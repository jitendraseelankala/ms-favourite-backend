const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const STAMP_TARGET = 5; // 5 stamps -> voucher for a free 6th meal
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
  const { phone, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in order' });
  }
  const hasMeal = items.some(it => it.cat === 'mealsHalal');
  const code = uniqueOrderCode();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (code, phone, items_json, total, has_meal, created_at, claimed)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(code, normPhone(phone) || null, JSON.stringify(items), total || 0, hasMeal ? 1 : 0, now);

  res.json({ code, hasMeal, total, createdAt: now });
});

// ---------------------------------------------------------------------------
// GET /api/orders/:code — look up a receipt (for staff / debugging)
// ---------------------------------------------------------------------------
app.get('/api/orders/:code', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE code=?').get(req.params.code.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ ...order, items: JSON.parse(order.items_json) });
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

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`M's Favourite backend running on http://localhost:${PORT}`));
