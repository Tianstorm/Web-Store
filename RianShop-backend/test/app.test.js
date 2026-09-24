const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');

const databasePath = path.resolve(process.cwd(), '.data/test-rianshop.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

let ripayServer;
let appServer;
let baseUrl;
let adminToken;
let paymentStatus = 'pending';
let transactionCounter = 0;

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

function adminHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

test.before(async () => {
  ripayServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/transactions') {
      transactionCounter += 1;
      res.end(JSON.stringify({
        ok: true,
        trx_id: `trx_test_${transactionCounter}`,
        status: 'pending',
        amount: 45000,
        charged_amount: 45000,
        qr_image_url: 'https://example.test/qr.png',
        payment_page_url: 'https://example.test/pay',
        expires_at: new Date(Date.now() + 900000).toISOString(),
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v1/transactions/')) {
      res.end(JSON.stringify({
        status: paymentStatus,
        trx_id: req.url.split('/').pop(),
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => ripayServer.listen(0, '127.0.0.1', resolve));

  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.SETTINGS_ENCRYPTION_KEY = 'test-encryption-key';
  process.env.RIPAY_BASE_URL = `http://127.0.0.1:${ripayServer.address().port}`;
  process.env.RIPAY_API_KEY = 'test-key';
  process.env.RIPAY_API_SECRET = 'test-secret';
  process.env.FRONTEND_URL = 'http://127.0.0.1:4173';
  process.env.ZAILEYS_AUTH_PATH = path.resolve(process.cwd(), '.data/test-zaileys');

  const legacy = createClient({ url: `file:${databasePath}` });
  await legacy.execute(
    'CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, stock INTEGER)',
  );
  await legacy.execute(
    "INSERT INTO products (name, price, stock) VALUES ('Produk Lama', 1000, 2)",
  );
  await legacy.execute(`CREATE TABLE inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    reserved_order_id INTEGER,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await legacy.execute(`CREATE TABLE orders (
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
    paid_at TEXT,
    completed_at TEXT,
    receipt_json TEXT NOT NULL DEFAULT '{}',
    failure_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await legacy.execute(`CREATE TABLE order_items (
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
    status TEXT NOT NULL DEFAULT 'pending'
  )`);
  await legacy.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.close();

  const { app, initialize } = require('../src/app');
  await initialize();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  const login = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  assert.equal(login.response.status, 200);
  adminToken = login.body.token;
});

test.after(async () => {
  await Promise.all([
    new Promise((resolve) => appServer.close(resolve)),
    new Promise((resolve) => ripayServer.close(resolve)),
  ]);
});

test('legacy schema migrates before indexes and seed data', async () => {
  const health = await api('/api/health');
  assert.equal(health.body.ok, true);

  const catalog = await api('/api/products');
  assert.equal(catalog.response.status, 200);
  assert.ok(catalog.body.products.length >= 10);
  const legacy = catalog.body.products.find((product) => product.name === 'Produk Lama');
  assert.match(legacy.slug, /^produk-lama-\d+$/);
  assert.equal(legacy.category, 'Lainnya');

  const { db } = require('../src/db');
  const inventoryColumns = await db.execute('PRAGMA table_info(inventory)');
  const itemColumns = await db.execute('PRAGMA table_info(order_items)');
  assert.ok(inventoryColumns.rows.some((row) => row.name === 'updated_at'));
  for (const column of ['provider_ref', 'failure_reason', 'updated_at']) {
    assert.ok(itemColumns.rows.some((row) => row.name === column));
  }
});

test('inventory checkout is private and fulfills after payment', async () => {
  const catalog = await api('/api/products');
  const vps = catalog.body.products.find((product) => product.slug === 'vps-nvme-starter');
  assert.ok(vps);

  const inventory = await api('/api/admin/inventory', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      product_id: vps.id,
      entries: [{
        label: 'VPS Test',
        payload: { ip: '192.0.2.10', username: 'root', password: 'secret', port: 22 },
      }],
    }),
  });
  assert.equal(inventory.response.status, 201);

  const checkout = await api('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Pelanggan Test',
      customer_phone: '081234567890',
      items: [{ product_id: vps.id, quantity: 1, customer_data: {} }],
    }),
  });
  assert.equal(checkout.response.status, 201);
  assert.equal(checkout.body.order.status, 'pending_payment');
  assert.equal(checkout.body.order.payment_url, 'https://example.test/pay');
  assert.ok(checkout.body.order.access_token);

  const unauthorized = await api(`/api/orders/${checkout.body.order.public_id}`);
  assert.equal(unauthorized.response.status, 403);

  const authorizedHeaders = { 'X-Order-Token': checkout.body.order.access_token };
  const pending = await api(`/api/orders/${checkout.body.order.public_id}`, {
    headers: authorizedHeaders,
  });
  assert.equal(pending.body.order.status, 'pending_payment');

  paymentStatus = 'paid';
  const completed = await api(`/api/orders/${checkout.body.order.public_id}`, {
    headers: authorizedHeaders,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.order.status, 'completed');
  assert.equal(completed.body.order.items[0].fulfillment.credentials[0].ip, '192.0.2.10');
});

test('invalid quantities are rejected and concurrent checkout cannot share stock', async () => {
  paymentStatus = 'pending';
  const product = await api('/api/admin/products', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      name: 'Stok Tunggal',
      slug: 'stok-tunggal',
      category: 'VPS',
      description: '',
      price: 10000,
      stock: 0,
      fulfillment_type: 'inventory',
      customer_fields: [],
      metadata: {},
      active: true,
    }),
  });
  assert.equal(product.response.status, 201);
  await api('/api/admin/inventory', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      product_id: product.body.product.id,
      entries: [{ label: 'Satu', payload: { username: 'only-one' } }],
    }),
  });

  const orderBody = {
    customer_name: 'Pembeli Test',
    customer_phone: '081234567890',
    items: [{ product_id: product.body.product.id, quantity: 1, customer_data: {} }],
  };
  const fractional = await api('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...orderBody,
      items: [{ ...orderBody.items[0], quantity: 1.5 }],
    }),
  });
  assert.equal(fractional.response.status, 400);

  const responses = await Promise.all([
    api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody),
    }),
    api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody),
    }),
  ]);
  assert.deepEqual(
    responses.map(({ response }) => response.status).sort(),
    [201, 400],
  );
});

test('unsigned Digiflazz callbacks are rejected when webhook secret is unset', async () => {
  const callback = await api('/api/digiflazz/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { ref_id: 'forged', status: 'Sukses' } }),
  });
  assert.equal(callback.response.status, 503);
});
