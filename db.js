const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    code TEXT PRIMARY KEY,
    phone TEXT,
    items_json TEXT NOT NULL,
    total REAL NOT NULL,
    has_meal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    voucher_applied TEXT,
    status TEXT NOT NULL DEFAULT 'received',
    order_type TEXT NOT NULL DEFAULT 'collection',
    address TEXT
  );

  CREATE TABLE IF NOT EXISTS stamps (
    phone TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    code TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    used_at TEXT,
    used_on_order TEXT
  );

  CREATE TABLE IF NOT EXISTS checkouts (
    session_id TEXT PRIMARY KEY,
    phone TEXT,
    items_json TEXT NOT NULL,
    total REAL NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'collection',
    address TEXT,
    wants_stamp INTEGER NOT NULL DEFAULT 0,
    voucher_code TEXT,
    voucher_discount REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    order_code TEXT,
    created_at TEXT NOT NULL
  );
`);

// Lightweight migration for databases created before status/order_type/address existed
const existingCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!existingCols.includes('status')) db.exec("ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'received'");
if (!existingCols.includes('order_type')) db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'collection'");
if (!existingCols.includes('address')) db.exec("ALTER TABLE orders ADD COLUMN address TEXT");

module.exports = db;
