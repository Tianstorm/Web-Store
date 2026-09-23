const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const databasePath = path.resolve(process.cwd(), '.data/test-rianshop.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${databasePath}${suffix}`, { force: true });
}

let ripayServer;
let appServer;
let baseUrl;

test.before(async () => {
  ripayServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/transactions') {
      res.end(JSON.stringify({
        ok: true,
        trx_id: 'trx_test_1',
        status: 'pending',
        amount: 20000,
        charged_amount: 20000,
        qr_image_url: 'https://example.test/qr.png',
        payment_page_url: 'https://example.test/pay',
        expires_at: new Date(Date.now() + 900000).toISOString(),
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/transactions/trx_test_1') {
      res.end(JSON.stringify({ status: 'pending', trx_id: 'trx_test_1' }));
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
  process.env.RIPAY_BASE_URL = `http://127.0.0.1:${ripayServer.address().port}`;
  process.env.RIPAY_API_KEY = 'test-key';
  process.env.RIPAY_API_SECRET = 'test-secret';
  process.env.FRONTEND_URL = 'http://127.0.0.1:4173';
  process.env.ZAILEYS_AUTH_PATH = path.resolve(process.cwd(), '.data/test-zaileys');

  const { app, initialize } = require('../src/app');
  await initialize();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => appServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  await Promise.all([
    new Promise((resolve) => appServer.close(resolve)),
    new Promise((resolve) => ripayServer.close(resolve)),
  ]);
});

test('health, catalog, admin login, and pending checkout flow work', async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const catalog = await fetch(`${baseUrl}/api/products`).then((response) => response.json());
  assert.equal(catalog.products.length, 9);
  const mobileLegends = catalog.products.find((product) => product.slug === 'mobile-legends-diamonds');
  assert.ok(mobileLegends);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  });
  const login = await loginResponse.json();
  assert.equal(loginResponse.status, 200);
  assert.ok(login.token);

  const checkoutResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Pelanggan Test',
      customer_phone: '081234567890',
      items: [{
        product_id: mobileLegends.id,
        quantity: 1,
        customer_data: { user_id: '123456', server_id: '7890' },
      }],
    }),
  });
  const checkout = await checkoutResponse.json();
  assert.equal(checkoutResponse.status, 201);
  assert.equal(checkout.order.status, 'pending_payment');
  assert.equal(checkout.order.payment_url, 'https://example.test/pay');

  const status = await fetch(
    `${baseUrl}/api/orders/${checkout.order.public_id}`,
  ).then((response) => response.json());
  assert.equal(status.order.status, 'pending_payment');
});
