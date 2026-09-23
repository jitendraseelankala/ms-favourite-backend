# M's Favourite — Rewards Backend

A small real backend for the Rewards/loyalty system: it creates order receipts,
verifies receipt codes, tracks stamps per phone number, issues vouchers at 5
stamps, and redeems vouchers (one free Meal per voucher, no matter how many
Meals are in the basket).

## What this replaces

Previously the website tracked everything in the browser's `localStorage`,
which meant stamps didn't survive a cleared cache or a different device, and
a receipt "code" could never really be verified. This backend fixes both:
data lives in a real database on a server, and every claim/redeem is checked
against it.

## Running it locally (for testing)

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd backend
npm install
npm start
```

You should see:
```
M's Favourite backend running on http://localhost:4000
```

A file called `data.sqlite` will appear in this folder — that's your
database. It's created automatically on first run.

## Connecting the website to it

In `index.html`, near the top of the `<script>` tag, there's this line:

```js
const API_BASE = 'http://localhost:4000';
```

- While testing locally, leave it as `http://localhost:4000` and open
  `index.html` directly in your browser (the backend must be running).
- Once you deploy the backend somewhere public (see below), change this to
  that URL, e.g. `const API_BASE = 'https://ms-favourite-api.onrender.com';`

## Deploying it for real

This is a plain Node.js + Express app, so it runs on almost any host. Easiest
options, roughly in order of simplicity:

1. **[Render.com](https://render.com)** — free tier available. Push this
   `backend` folder to a GitHub repo, create a new "Web Service" on Render
   pointing at it, set the start command to `npm start`. Render gives you a
   public HTTPS URL automatically.
2. **[Railway.app](https://railway.app)** — similar to Render, also very
   quick to set up from a GitHub repo.
3. **Your own VPS** (e.g. a £5/month DigitalOcean/Hetzner box) — install
   Node, copy this folder up, run `npm install && npm start` behind a
   process manager like `pm2`, and put Nginx in front for HTTPS.

Whichever you choose, once it's live, update `API_BASE` in `index.html` to
that URL and re-upload the website.

**Note on the database:** this uses SQLite (a single file, `data.sqlite`).
That's perfect for a single small backend like this, but if you deploy to a
platform with an ephemeral filesystem (some free tiers wipe disk on
restart/redeploy), your stamps/vouchers could reset. Render and Railway's
paid tiers support persistent disks; ask them to attach one to be safe, or
migrate to a hosted Postgres database later if this grows.

## API reference

| Method | Path | What it does |
|---|---|---|
| POST | `/api/orders` | Create an order receipt. Body: `{ phone, items, total }`. Returns `{ code }`. |
| GET | `/api/orders/:code` | Look up a receipt by code. |
| POST | `/api/loyalty/claim` | Verify a receipt code and add a stamp. Body: `{ phone, code }`. Issues a voucher automatically at 5 stamps. |
| GET | `/api/loyalty/:phone` | Get current stamp count and any unused vouchers for a phone number. |
| POST | `/api/vouchers/redeem` | Preview/apply a voucher discount to a basket. Body: `{ phone, voucherCode, items }`. Only discounts **one** Meal — the cheapest one in the basket. |
| POST | `/api/vouchers/consume` | Permanently mark a voucher as used once an order is actually placed. Body: `{ voucherCode, orderCode }`. |
| GET | `/api/health` | Simple check that the server is up. |

## Business rules baked in

- **5 stamps → a voucher for a free 6th Meal.** The stamp counter resets to
  0 once a voucher is issued, so it's a repeating cycle.
- **Stamps only count for orders that include a Meal** (your "Meals"
  category) — a burger-only order won't add a stamp even with a valid code.
- **Each receipt code can only be claimed once.**
- **A voucher only discounts one Meal, ever** — if someone orders 3 Meals
  and applies a voucher, they still pay for 2 of them. The backend always
  picks the *cheapest* Meal in the basket to give away, so you're never
  giving away more value than intended.
- **A voucher is tied to the phone number that earned it** — redeeming with
  a different number is rejected.
- **A voucher is single-use** — once consumed on an order, it can't be
  applied again.

## Limitations to know about

- There's no login/authentication — anyone who knows a phone number could
  in theory check its stamp count. For a small local takeaway this is a
  reasonable tradeoff, but don't treat phone numbers as a security
  boundary.
- No admin dashboard is included. To look something up manually (e.g.
  "has this code been used?"), you can query `data.sqlite` directly with
  any SQLite browser tool, or use the `GET /api/orders/:code` endpoint.
- CORS is currently wide open (any website can call this API). Fine for a
  single-restaurant setup; tighten it in `server.js` if that ever matters.
