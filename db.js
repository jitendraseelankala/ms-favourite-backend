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
    voucher_applied TEXT
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
`);

module.exports = db;
