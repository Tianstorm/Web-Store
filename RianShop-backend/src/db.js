const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { databaseAuthToken, databaseUrl } = require('./config');
const { decrypt, encrypt } = require('./crypto-store');

if (databaseUrl.startsWith('file:')) {
  const filename = databaseUrl.slice(5);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

const db = createClient({
  url: databaseUrl,
  authToken: databaseAuthToken,
});

const schema = [
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    image_url TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'sparkles',
    fulfillment_type TEXT NOT NULL DEFAULT 'manual',
    provider_sku TEXT NOT NULL DEFAULT '',
    customer_fields_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    reserved_order_id INTEGER,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL,
    customer_email TEXT NOT NULL DEFAULT '',
    total_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_provider TEXT NOT NULL DEFAULT 'ripay',
    payment_trx_id TEXT UNIQUE,
    payment_url TEXT NOT NULL DEFAULT '',
    qr_image_url TEXT NOT NULL DEFAULT '',
    payment_expires_at TEXT,
    access_token_hash TEXT NOT NULL DEFAULT '',
    paid_at TEXT,
    completed_at TEXT,
    receipt_json TEXT NOT NULL DEFAULT '{}',
    failure_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    fulfillment_type TEXT NOT NULL,
    provider_sku TEXT NOT NULL DEFAULT '',
    customer_data_json TEXT NOT NULL DEFAULT '{}',
    fulfillment_json TEXT NOT NULL DEFAULT '{}',
    provider_ref TEXT,
    failure_reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
];

const migrations = {
  products: {
    slug: "TEXT NOT NULL DEFAULT ''",
    category: "TEXT NOT NULL DEFAULT 'Lainnya'",
    description: "TEXT NOT NULL DEFAULT ''",
    image_url: "TEXT NOT NULL DEFAULT ''",
    icon: "TEXT NOT NULL DEFAULT 'sparkles'",
    fulfillment_type: "TEXT NOT NULL DEFAULT 'manual'",
    provider_sku: "TEXT NOT NULL DEFAULT ''",
    customer_fields_json: "TEXT NOT NULL DEFAULT '[]'",
    metadata_json: "TEXT NOT NULL DEFAULT '{}'",
    active: 'INTEGER NOT NULL DEFAULT 1',
    created_at: "TEXT NOT NULL DEFAULT ''",
    updated_at: "TEXT NOT NULL DEFAULT ''",
  },
  inventory: {
    updated_at: "TEXT NOT NULL DEFAULT ''",
  },
  orders: {
    access_token_hash: "TEXT NOT NULL DEFAULT ''",
  },
  order_items: {
    provider_ref: 'TEXT',
    failure_reason: "TEXT NOT NULL DEFAULT ''",
    created_at: "TEXT NOT NULL DEFAULT ''",
    updated_at: "TEXT NOT NULL DEFAULT ''",
  },
  settings: {
    sensitive: 'INTEGER NOT NULL DEFAULT 0',
    updated_at: "TEXT NOT NULL DEFAULT ''",
  },
};

const indexes = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug)',
  'CREATE INDEX IF NOT EXISTS idx_products_active_category ON products(active, category)',
  'CREATE INDEX IF NOT EXISTS idx_inventory_product_status ON inventory(product_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_provider_ref
    ON order_items(provider_ref) WHERE provider_ref IS NOT NULL AND provider_ref != ''`,
];

const seedProducts = [
  {
    slug: 'vps-nvme-starter',
    name: 'VPS NVMe Starter',
    category: 'VPS',
    description: '1 vCPU, 2 GB RAM, 25 GB NVMe, bandwidth premium.',
    price: 45000,
    stock: 0,
    icon: 'server',
    fulfillmentType: 'inventory',
    fields: [],
  },
  {
    slug: 'hosting-premium',
    name: 'Hosting Premium',
    category: 'Hosting',
    description: 'Hosting cepat dengan SSL, panel modern, dan backup otomatis.',
    price: 25000,
    stock: 0,
    icon: 'globe',
    fulfillmentType: 'inventory',
    fields: [{ name: 'domain', label: 'Domain', type: 'text', required: true }],
  },
  {
    slug: 'mobile-legends-diamonds',
    name: 'Mobile Legends Diamonds',
    category: 'Game',
    description: 'Top up Mobile Legends otomatis setelah pembayaran terkonfirmasi.',
    price: 20000,
    stock: 9999,
    icon: 'gamepad',
    fulfillmentType: 'digiflazz',
    fields: [
      { name: 'user_id', label: 'User ID', type: 'text', required: true },
      { name: 'server_id', label: 'Zone ID', type: 'text', required: true },
    ],
    metadata: { customer_number_template: '{{user_id}}{{server_id}}' },
  },
  {
    slug: 'free-fire-diamonds',
    name: 'Free Fire Diamonds',
    category: 'Game',
    description: 'Diamond Free Fire terkirim otomatis ke akun tujuan.',
    price: 15000,
    stock: 9999,
    icon: 'crosshair',
    fulfillmentType: 'digiflazz',
    fields: [{ name: 'user_id', label: 'Player ID', type: 'text', required: true }],
    metadata: { customer_number_template: '{{user_id}}' },
  },
  {
    slug: 'pubg-mobile-uc',
    name: 'PUBG Mobile UC',
    category: 'Game',
    description: 'UC PUBG Mobile diproses otomatis ke Player ID tujuan.',
    price: 18000,
    stock: 9999,
    icon: 'target',
    fulfillmentType: 'digiflazz',
    fields: [{ name: 'user_id', label: 'Player ID', type: 'text', required: true }],
    metadata: { customer_number_template: '{{user_id}}' },
  },
  {
    slug: 'roblox-robux',
    name: 'Roblox Robux',
    category: 'Game',
    description: 'Top up Robux cepat untuk akun Roblox tujuan.',
    price: 25000,
    stock: 9999,
    icon: 'box',
    fulfillmentType: 'digiflazz',
    fields: [{ name: 'user_id', label: 'User ID Roblox', type: 'text', required: true }],
    metadata: { customer_number_template: '{{user_id}}' },
  },
  {
    slug: 'premium-app-account',
    name: 'Aplikasi Premium',
    category: 'Aplikasi Premium',
    description: 'Akun aplikasi premium legal sesuai pilihan paket yang tersedia.',
    price: 30000,
    stock: 0,
    icon: 'sparkles',
    fulfillmentType: 'inventory',
    fields: [],
  },
  {
    slug: 'pulsa-all-operator',
    name: 'Pulsa Semua Operator',
    category: 'Pulsa',
    description: 'Isi pulsa otomatis untuk nomor Indonesia.',
    price: 12000,
    stock: 9999,
    icon: 'smartphone',
    fulfillmentType: 'digiflazz',
    fields: [{ name: 'phone', label: 'Nomor HP', type: 'tel', required: true }],
    metadata: { customer_number_template: '{{phone}}' },
  },
  {
    slug: 'token-listrik',
    name: 'Token Listrik PLN',
    category: 'PLN',
    description: 'Token listrik prabayar dan nomor token dikirim lewat WhatsApp.',
    price: 22000,
    stock: 9999,
    icon: 'zap',
    fulfillmentType: 'digiflazz',
    fields: [{ name: 'meter_id', label: 'Nomor Meter / ID Pelanggan', type: 'text', required: true }],
    metadata: { customer_number_template: '{{meter_id}}' },
  },
];

async function initializeDatabase() {
  for (const statement of schema) await db.execute(statement);
  await migrateLegacySchema();
  for (const statement of indexes) await db.execute(statement);

  for (const product of seedProducts) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO products
        (slug, name, category, description, price, stock, icon, fulfillment_type, customer_fields_json, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        product.slug,
        product.name,
        product.category,
        product.description,
        product.price,
        product.stock,
        product.icon,
        product.fulfillmentType,
        JSON.stringify(product.fields),
        JSON.stringify(product.metadata || {}),
      ],
    });
  }

  const products = await db.execute('SELECT id, customer_fields_json FROM products');
  for (const product of products.rows) {
    const fields = JSON.parse(String(product.customer_fields_json || '[]'));
    if (!fields.some((field) => field.key && !field.name)) continue;
    await db.execute({
      sql: 'UPDATE products SET customer_fields_json = ? WHERE id = ?',
      args: [
        JSON.stringify(fields.map((field) => ({
          ...field,
          name: field.name || field.key,
          key: undefined,
        }))),
        product.id,
      ],
    });
  }
}

async function migrateLegacySchema() {
  for (const [table, columns] of Object.entries(migrations)) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    const existing = new Set(info.rows.map((row) => String(row.name)));
    for (const [column, definition] of Object.entries(columns)) {
      if (existing.has(column)) continue;
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  const legacyProducts = await db.execute(
    "SELECT id, name FROM products WHERE slug = '' OR slug IS NULL",
  );
  for (const product of legacyProducts.rows) {
    const base = String(product.name || 'product')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-');
    await db.execute({
      sql: `UPDATE products SET slug = ?, created_at = COALESCE(NULLIF(created_at, ''), CURRENT_TIMESTAMP),
        updated_at = COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP) WHERE id = ?`,
      args: [`${base || 'product'}-${product.id}`, product.id],
    });
  }
  await db.execute(
    "UPDATE inventory SET updated_at = COALESCE(NULLIF(updated_at, ''), created_at, CURRENT_TIMESTAMP)",
  );
  await db.execute(
    "UPDATE order_items SET created_at = COALESCE(NULLIF(created_at, ''), CURRENT_TIMESTAMP), updated_at = COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP)",
  );
  await db.execute(
    "UPDATE settings SET updated_at = COALESCE(NULLIF(updated_at, ''), CURRENT_TIMESTAMP)",
  );
}

async function getSetting(key, fallback = '') {
  const result = await db.execute({
    sql: 'SELECT value, sensitive FROM settings WHERE key = ?',
    args: [key],
  });
  const row = result.rows[0];
  if (!row) return fallback;
  return Number(row.sensitive) ? decrypt(row.value) : String(row.value);
}

async function setSetting(key, value, sensitive = false) {
  await db.execute({
    sql: `INSERT INTO settings (key, value, sensitive, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, sensitive = excluded.sensitive, updated_at = CURRENT_TIMESTAMP`,
    args: [key, sensitive ? encrypt(value) : String(value || ''), sensitive ? 1 : 0],
  });
}

module.exports = {
  db,
  getSetting,
  initializeDatabase,
  setSetting,
};
