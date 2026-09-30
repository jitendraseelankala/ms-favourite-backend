const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());

// IMPORTANT: the Stripe webhook route must come BEFORE express.json() below,
// and use express.raw() instead — Stripe's signature check needs the exact
// raw request body, not the parsed/re-serialized version.
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.warn('⚠️  STRIPE_SECRET_KEY is not set — the rest of the site will run fine, but payment and webhook routes will return an error until it is added.');
}
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(503).send('Payments are not configured on this server yet.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    handlePaymentConfirmed(session.id).catch(e => console.error('Error finalising order:', e));
  }

  res.json({ received: true });
});

function handlePaymentConfirmed(sessionId) {
  const checkout = db.prepare('SELECT * FROM checkouts WHERE session_id=?').get(sessionId);
  if (!checkout) { console.error('No checkout row for session', sessionId); return Promise.resolve(); }
  if (checkout.status === 'completed') return Promise.resolve(); // already handled (Stripe can retry webhooks)

  const items = JSON.parse(checkout.items_json);
  const hasMeal = items.some(it => it.cat === 'mealsHalal');
  const code = uniqueOrderCode();
  const now = new Date().toISOString();

  const tx = db.transaction((paymentIntentId) => {
    db.prepare(`
      INSERT INTO orders (code, phone, items_json, total, has_meal, created_at, claimed, status, order_type, address, payment_intent_id)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'received', ?, ?, ?)
    `).run(code, checkout.phone, checkout.items_json, checkout.total, hasMeal ? 1 : 0, now, checkout.order_type, checkout.address, paymentIntentId || null);

    if (checkout.voucher_code) {
      db.prepare('UPDATE vouchers SET used=1, used_at=?, used_on_order=? WHERE code=?').run(now, code, checkout.voucher_code);
    }

    db.prepare("UPDATE checkouts SET status='completed', order_code=? WHERE session_id=?").run(code, sessionId);
  });

  // Fetch the session again to get the payment_intent id (needed later for refunds if staff decline the order)
  return stripe.checkout.sessions.retrieve(sessionId).then(fullSession => {
    tx(fullSession.payment_intent || null);
  }).catch(e => {
    console.error('Could not retrieve payment_intent for session', sessionId, e.message);
    tx(null);
  });
}

app.use(express.json());

const STAMP_TARGET = 5; // 5 stamps -> voucher for a free 6th meal
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STAFF_PIN = process.env.STAFF_PIN || '2468'; // change via Render env vars for real use

function requireStaff(req, res, next) {
  const pin = req.header('X-Staff-Pin');
  if (pin !== STAFF_PIN) return res.status(401).json({ error: 'Staff login required' });
  next();
}

function randomCode(prefix) {
  let s = prefix + '-';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function uniqueOrderCode() {
  let code;
  do { code = randomCode('M'); } while (db.prepare('SELECT 1 FROM orders WHERE code=?').get(code));
  return code;
}
function uniqueVoucherCode() {
  let code;
  do { code = randomCode('V'); } while (db.prepare('SELECT 1 FROM vouchers WHERE code=?').get(code));
  return code;
}
function normPhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// POST /api/orders  — called right after checkout to create a receipt
// body: { phone?, items: [{id, n, price, qty, drink, cat}], total }
// ---------------------------------------------------------------------------
app.post('/api/orders', (req, res) => {
  const { phone, items, total, orderType, address } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in order' });
  }
  const hasMeal = items.some(it => it.cat === 'mealsHalal');
  const code = uniqueOrderCode();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (code, phone, items_json, total, has_meal, created_at, claimed, status, order_type, address)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'received', ?, ?)
  `).run(code, normPhone(phone) || null, JSON.stringify(items), total || 0, hasMeal ? 1 : 0, now, orderType || 'collection', address || null);

  res.json({ code, hasMeal, total, createdAt: now, status: 'received' });
});

// ---------------------------------------------------------------------------
// GET /api/orders/:code — look up a receipt (for staff / debugging)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/orders/by-phone/:phone — a customer's order history ("Your Orders")
// ---------------------------------------------------------------------------
app.get('/api/orders/by-phone/:phone', (req, res) => {
  const phone = normPhone(req.params.phone);
  if (phone.length < 6) return res.status(400).json({ error: 'Please enter a valid phone number' });
  const orders = db.prepare('SELECT code, items_json, total, has_meal, created_at, claimed, status, order_type, decline_note FROM orders WHERE phone=? ORDER BY created_at DESC LIMIT 50').all(phone);
  const out = orders.map(o => ({
    code: o.code,
    items: JSON.parse(o.items_json),
    total: o.total,
    hasMeal: !!o.has_meal,
    createdAt: o.created_at,
    stampClaimed: !!o.claimed,
    status: o.status,
    orderType: o.order_type,
    declineNote: o.decline_note || null
  }));
  res.json({ orders: out });
});

app.get('/api/orders/:code', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE code=?').get(req.params.code.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    ...order,
    items: JSON.parse(order.items_json),
    declineNote: order.decline_note || null
  });
});

// ---------------------------------------------------------------------------
// POST /api/loyalty/claim — verify a receipt code and add a stamp
// body: { phone, code }
// ---------------------------------------------------------------------------
const CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

app.post('/api/loyalty/claim', (req, res) => {
  const phone = normPhone(req.body.phone);
  const code = String(req.body.code || '').trim().toUpperCase();
  if (phone.length < 6) return res.status(400).json({ error: 'Please enter a valid phone number' });
  if (!code) return res.status(400).json({ error: 'Enter your receipt code first' });

  const order = db.prepare('SELECT * FROM orders WHERE code=?').get(code);
  if (!order) return res.status(404).json({ error: 'Code not recognised — check and try again' });
  if (order.claimed) return res.status(409).json({ error: 'This code has already been used' });
  if (!order.has_meal) return res.status(422).json({ error: "This order didn't include a Meal — stamps only apply to Meals" });

  const orderAgeMs = Date.now() - new Date(order.created_at).getTime();
  if (orderAgeMs > CODE_EXPIRY_MS) {
    return res.status(410).json({ error: 'This code has expired — codes are only valid for 15 minutes' });
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('UPDATE orders SET claimed=1, claimed_at=? WHERE code=?').run(now, code);

    let row = db.prepare('SELECT * FROM stamps WHERE phone=?').get(phone);
    let count = row ? row.count : 0;
    count += 1;

    let voucherCode = null;
    if (count >= STAMP_TARGET) {
      voucherCode = uniqueVoucherCode();
      db.prepare('INSERT INTO vouchers (code, phone, created_at, used) VALUES (?, ?, ?, 0)')
        .run(voucherCode, phone, now);
      count = 0; // reset the cycle
    }

    if (row) {
      db.prepare('UPDATE stamps SET count=?, updated_at=? WHERE phone=?').run(count, now, phone);
    } else {
      db.prepare('INSERT INTO stamps (phone, count, updated_at) VALUES (?, ?, ?)').run(phone, count, now);
    }
    return { count, voucherCode };
  });

  const { count, voucherCode } = tx();
  res.json({ stamps: count, target: STAMP_TARGET, voucherIssued: !!voucherCode, voucherCode });
});

// ---------------------------------------------------------------------------
// GET /api/loyalty/:phone — current stamp count + any unused vouchers
// ---------------------------------------------------------------------------
app.get('/api/loyalty/:phone', (req, res) => {
  const phone = normPhone(req.params.phone);
  const row = db.prepare('SELECT * FROM stamps WHERE phone=?').get(phone);
  const vouchers = db.prepare('SELECT code, created_at FROM vouchers WHERE phone=? AND used=0 ORDER BY created_at DESC').all(phone);
  res.json({ stamps: row ? row.count : 0, target: STAMP_TARGET, vouchers });
});

// ---------------------------------------------------------------------------
// POST /api/vouchers/redeem — apply a voucher to ONE meal in the current basket
// body: { phone, voucherCode, items: [{id, n, price, qty, cat}] }
// Only the single cheapest meal UNIT is discounted — everything else is paid.
// ---------------------------------------------------------------------------
app.post('/api/vouchers/redeem', (req, res) => {
  const phone = normPhone(req.body.phone);
  const voucherCode = String(req.body.voucherCode || '').trim().toUpperCase();
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  const voucher = db.prepare('SELECT * FROM vouchers WHERE code=?').get(voucherCode);
  if (!voucher) return res.status(404).json({ error: 'Voucher code not recognised' });
  if (voucher.used) return res.status(409).json({ error: 'This voucher has already been used' });
  if (voucher.phone !== phone) return res.status(403).json({ error: 'This voucher was issued to a different phone number' });

  // expand meal lines into individual units, find the cheapest one
  let cheapest = null;
  for (const it of items) {
    if (it.cat !== 'mealsHalal') continue;
    const unitPrice = Number(it.price) || 0;
    if (!cheapest || unitPrice < cheapest.unitPrice) {
      cheapest = { id: it.id, n: it.n, unitPrice };
    }
  }
  if (!cheapest) {
    return res.status(422).json({ error: 'Your basket needs at least one Meal for this voucher to apply' });
  }

  res.json({
    ok: true,
    discount: cheapest.unitPrice,
    appliedTo: cheapest.n,
    voucherCode
  });
});

// Mark a voucher as permanently used once the order is actually placed
app.post('/api/vouchers/consume', (req, res) => {
  const voucherCode = String(req.body.voucherCode || '').trim().toUpperCase();
  const orderCode = String(req.body.orderCode || '').trim().toUpperCase();
  const voucher = db.prepare('SELECT * FROM vouchers WHERE code=?').get(voucherCode);
  if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
  if (voucher.used) return res.status(409).json({ error: 'Voucher already used' });
  const now = new Date().toISOString();
  db.prepare('UPDATE vouchers SET used=1, used_at=?, used_on_order=? WHERE code=?').run(now, orderCode || null, voucherCode);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/delivery/quote — geocode a delivery address and work out the fee
// body: { address, total }
// Shop location: 91 Green Lanes, London N16 9BX
// ---------------------------------------------------------------------------
const SHOP_LAT = 51.554212;
const SHOP_LNG = -0.089007;
const DELIVERY_RADIUS_MILES = 2;
const FREE_DELIVERY_THRESHOLD = 20;
const DELIVERY_FEE = 2;

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth radius in miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post('/api/delivery/quote', async (req, res) => {
  const address = String(req.body.address || '').trim();
  const total = Number(req.body.total) || 0;
  if (!address) return res.status(400).json({ error: 'Please enter a delivery address' });

  let geo;
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=gb`;
    const geoRes = await fetch(url, { headers: { 'User-Agent': "MsFavouriteChicken/1.0 (91 Green Lanes N16 9BX)" } });
    const geoData = await geoRes.json();
    if (!geoData || geoData.length === 0) {
      return res.status(422).json({ error: "We couldn't find that address — please check it and try again, or include your postcode." });
    }
    geo = geoData[0];
  } catch (e) {
    return res.status(502).json({ error: 'Could not verify that address right now — please try again in a moment.' });
  }

  const distanceMiles = haversineMiles(SHOP_LAT, SHOP_LNG, parseFloat(geo.lat), parseFloat(geo.lon));

  if (distanceMiles > DELIVERY_RADIUS_MILES) {
    return res.status(422).json({
      error: `Sorry — that address is about ${distanceMiles.toFixed(1)} miles away. We only deliver within ${DELIVERY_RADIUS_MILES} miles. Please select Collection instead.`,
      distanceMiles: Math.round(distanceMiles * 10) / 10,
      withinRange: false
    });
  }

  const fee = total >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
  res.json({
    ok: true,
    withinRange: true,
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    fee,
    freeThreshold: FREE_DELIVERY_THRESHOLD,
    matchedAddress: geo.display_name
  });
});

// ---------------------------------------------------------------------------
// POST /api/checkout/create-session — builds a real Stripe payment page
// body: { phone, items, orderType, address, wantsStamp, voucherCode, voucherDiscount }
// Nothing in "orders" is created here — only after Stripe confirms payment
// (via the webhook above) does a real order + Stamp Card code get generated.
// ---------------------------------------------------------------------------
app.post('/api/checkout/create-session', async (req, res) => {
  const { phone, items, orderType, address, wantsStamp, voucherCode, voucherDiscount } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in basket' });
  }
  if (!stripe) {
    return res.status(503).json({ error: 'Payments are not configured yet — STRIPE_SECRET_KEY is missing on the server.' });
  }

  try {
    const line_items = [];
    const discount = Number(voucherDiscount) || 0;
    let discountRemaining = discount;

    for (const it of items) {
      const unitPence = Math.round(Number(it.price) * 100);
      const qty = Number(it.qty) || 1;
      const name = it.n + (it.drink ? ` (${it.drink})` : '');

      if (discountRemaining > 0 && voucherCode && it.cat === 'mealsHalal' && qty >= 1) {
        // discount exactly one unit of this meal line (the one the voucher applies to)
        const discountedUnitPence = Math.max(0, unitPence - Math.round(discountRemaining * 100));
        discountRemaining = 0;
        if (qty > 1) {
          line_items.push({ price_data: { currency: 'gbp', product_data: { name }, unit_amount: unitPence }, quantity: qty - 1 });
        }
        line_items.push({ price_data: { currency: 'gbp', product_data: { name: name + ' (Rewards voucher applied)' }, unit_amount: discountedUnitPence }, quantity: 1 });
      } else {
        line_items.push({ price_data: { currency: 'gbp', product_data: { name }, unit_amount: unitPence }, quantity: qty });
      }
    }

    const itemsTotal = items.reduce((sum, it) => sum + Number(it.price) * (Number(it.qty) || 1), 0);
    let deliveryFee = 0;
    if (orderType === 'delivery') {
      deliveryFee = itemsTotal - discount >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
      if (deliveryFee > 0) {
        line_items.push({ price_data: { currency: 'gbp', product_data: { name: 'Delivery fee' }, unit_amount: Math.round(deliveryFee * 100) }, quantity: 1 });
      }
    }

    const total = Math.max(0, itemsTotal - discount + deliveryFee);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // No payment_method_types set on purpose — this lets the payment methods
      // you enable in the Stripe Dashboard (Settings > Payment methods) control
      // what shows here. Cards + Apple Pay are on by default; Google Pay must be
      // switched on there too (it's off by default on new Stripe accounts).
      line_items,
      success_url: `${req.headers.origin || 'https://ms-favourite.pages.dev'}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || 'https://ms-favourite.pages.dev'}/?payment=cancelled`,
      customer_email: undefined,
      phone_number_collection: { enabled: false }
    });

    db.prepare(`
      INSERT INTO checkouts (session_id, phone, items_json, total, order_type, address, wants_stamp, voucher_code, voucher_discount, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(session.id, normPhone(phone) || null, JSON.stringify(items), total, orderType || 'collection', address || null, wantsStamp ? 1 : 0, voucherCode || null, discount || null, new Date().toISOString());

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(502).json({ error: 'Could not start payment — please try again.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/checkout/session/:sessionId — the site polls this after returning
// from Stripe, to find out once the webhook has finished creating the order.
// ---------------------------------------------------------------------------
app.get('/api/checkout/session/:sessionId', (req, res) => {
  const checkout = db.prepare('SELECT * FROM checkouts WHERE session_id=?').get(req.params.sessionId);
  if (!checkout) return res.status(404).json({ error: 'Checkout not found' });
  if (checkout.status !== 'completed') return res.json({ status: 'pending' });
  const order = db.prepare('SELECT * FROM orders WHERE code=?').get(checkout.order_code);
  res.json({
    status: 'completed',
    code: checkout.order_code,
    hasMeal: order ? !!order.has_meal : false,
    total: checkout.total,
    wantsStamp: !!checkout.wants_stamp,
    orderType: checkout.order_type
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// STAFF DASHBOARD ENDPOINTS — everything below requires the staff PIN
// ---------------------------------------------------------------------------
app.post('/api/staff/login', (req, res) => {
  const pin = String(req.body.pin || '');
  if (pin !== STAFF_PIN) return res.status(401).json({ error: 'Incorrect PIN' });
  res.json({ ok: true });
});

// GET /api/staff/orders — today's orders, newest first, for the staff dashboard
app.get('/api/staff/orders', requireStaff, (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const orders = db.prepare('SELECT * FROM orders WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100').all(since);
  const out = orders.map(o => ({
    code: o.code,
    phone: o.phone,
    items: JSON.parse(o.items_json),
    total: o.total,
    hasMeal: !!o.has_meal,
    createdAt: o.created_at,
    status: o.status,
    orderType: o.order_type,
    address: o.address,
    declineNote: o.decline_note || null
  }));
  res.json({ orders: out });
});

// PATCH /api/orders/:code/status — staff moves an order through received -> accepted -> ready
// or declines it (requires a note; triggers an automatic Stripe refund).
const VALID_STATUSES = ['received', 'accepted', 'ready', 'declined'];
app.patch('/api/orders/:code/status', requireStaff, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const status = String(req.body.status || '');
  const note = String(req.body.note || '').trim();
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const order = db.prepare('SELECT * FROM orders WHERE code=?').get(code);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (status === 'declined') {
    if (!note) return res.status(400).json({ error: 'Please add a short note explaining why the order is being declined' });

    let refundStatus = 'not_attempted';
    if (stripe && order.payment_intent_id) {
      try {
        await stripe.refunds.create({ payment_intent: order.payment_intent_id });
        refundStatus = 'refunded';
      } catch (err) {
        console.error('Refund failed for order', code, err.message);
        refundStatus = 'failed';
      }
    } else if (!order.payment_intent_id) {
      refundStatus = 'no_payment_on_file';
    }

    db.prepare('UPDATE orders SET status=?, decline_note=?, refund_status=? WHERE code=?').run(status, note, refundStatus, code);
    return res.json({ ok: true, code, status, refundStatus });
  }

  db.prepare('UPDATE orders SET status=? WHERE code=?').run(status, code);
  res.json({ ok: true, code, status });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`M's Favourite backend running on http://localhost:${PORT}`));
