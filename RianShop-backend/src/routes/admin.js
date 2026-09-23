const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { backendUrl, jwtSecret, zaileysAuthPath } = require('../config');
const { db, getSetting, setSetting } = require('../db');
const { authenticateAdmin } = require('../middleware/auth');
const { getDigiflazzConfig } = require('../services/digiflazz');
const { getRipayConfig, simulatePayment } = require('../services/ripay');
const {
  getOrder,
  refreshOrder,
  serializeOrder,
  serializeProduct,
} = require('../services/orders');
const { whatsappManager } = require('../services/whatsapp');
const { asJson, slugify, timingSafeEqualText } = require('../utils');

const router = express.Router();
const uploadDir = path.resolve(zaileysAuthPath, '..', 'uploads');
const sensitiveSettings = new Set([
  'ripay_api_key',
  'ripay_api_secret',
  'digiflazz_api_key',
  'digiflazz_webhook_secret',
]);

router.post('/login', async (req, res) => {
  const expectedUsername = await getSetting(
    'admin_username',
    process.env.ADMIN_USERNAME || 'admin',
  );
  const expectedPassword = await getSetting(
    'admin_password',
    process.env.ADMIN_PASSWORD || 'change-me',
  );
  const valid =
    timingSafeEqualText(req.body?.username, expectedUsername) &&
    timingSafeEqualText(req.body?.password, expectedPassword);
  if (!valid) return res.status(401).json({ error: 'Username atau password salah' });
  if (!jwtSecret) return res.status(503).json({ error: 'JWT_SECRET belum dikonfigurasi' });

  const token = jwt.sign({ sub: expectedUsername, role: 'admin' }, jwtSecret, {
    expiresIn: '12h',
  });
  return res.json({ token, username: expectedUsername });
});

router.use(authenticateAdmin);

router.get('/dashboard', async (_req, res, next) => {
  try {
    const [products, orders, revenue, actions] = await Promise.all([
      db.execute('SELECT COUNT(*) AS total FROM products WHERE active = 1'),
      db.execute("SELECT COUNT(*) AS total FROM orders WHERE status = 'completed'"),
      db.execute("SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status = 'completed'"),
      db.execute("SELECT COUNT(*) AS total FROM orders WHERE status = 'needs_action'"),
    ]);
    res.json({
      stats: {
        active_products: Number(products.rows[0].total),
        completed_orders: Number(orders.rows[0].total),
        revenue: Number(revenue.rows[0].total),
        needs_action: Number(actions.rows[0].total),
      },
      whatsapp: whatsappManager.snapshot(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/products', async (_req, res, next) => {
  try {
    const result = await db.execute('SELECT * FROM products ORDER BY id DESC');
    res.json({ products: result.rows.map(serializeProduct) });
  } catch (error) {
    next(error);
  }
});

router.post('/products', async (req, res, next) => {
  try {
    const product = normalizeProduct(req.body);
    const result = await db.execute({
      sql: `INSERT INTO products
        (slug, name, category, description, price, stock, image_url, icon, fulfillment_type,
          provider_sku, customer_fields_json, metadata_json, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: productArgs(product),
    });
    const created = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [result.lastInsertRowid] });
    res.status(201).json({ product: serializeProduct(created.rows[0]) });
  } catch (error) {
    next(error);
  }
});

router.put('/products/:id', async (req, res, next) => {
  try {
    const product = normalizeProduct(req.body);
    await db.execute({
      sql: `UPDATE products SET slug = ?, name = ?, category = ?, description = ?, price = ?,
        stock = ?, image_url = ?, icon = ?, fulfillment_type = ?, provider_sku = ?,
        customer_fields_json = ?, metadata_json = ?, active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      args: [...productArgs(product), Number(req.params.id)],
    });
    const updated = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [Number(req.params.id)] });
    if (!updated.rows[0]) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    return res.json({ product: serializeProduct(updated.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.delete('/products/:id', async (req, res, next) => {
  try {
    await db.execute({
      sql: 'UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [Number(req.params.id)],
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/uploads',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], limit: '5mb' }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'File gambar kosong' });
      }
      const extensions = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
      };
      const extension = extensions[req.headers['content-type']];
      if (!extension) return res.status(415).json({ error: 'Format gambar tidak didukung' });
      fs.mkdirSync(uploadDir, { recursive: true });
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
      fs.writeFileSync(path.join(uploadDir, filename), req.body, { flag: 'wx' });
      return res.status(201).json({
        url: `${backendUrl.replace(/\/$/, '')}/uploads/${filename}`,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get('/inventory', async (req, res, next) => {
  try {
    const productId = Number(req.query.product_id || 0);
    const result = await db.execute({
      sql: `SELECT inventory.*, products.name AS product_name FROM inventory
        JOIN products ON products.id = inventory.product_id
        WHERE (? = 0 OR inventory.product_id = ?) ORDER BY inventory.id DESC LIMIT 500`,
      args: [productId, productId],
    });
    res.json({
      inventory: result.rows.map((row) => ({
        ...row,
        id: Number(row.id),
        product_id: Number(row.product_id),
        payload: asJson(row.payload_json, {}),
        payload_json: undefined,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/inventory', async (req, res, next) => {
  try {
    const productId = Number(req.body?.product_id);
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!productId || entries.length === 0 || entries.length > 500) {
      return res.status(400).json({ error: 'Data inventori tidak valid' });
    }
    for (const entry of entries) {
      await db.execute({
        sql: 'INSERT INTO inventory (product_id, label, payload_json) VALUES (?, ?, ?)',
        args: [
          productId,
          String(entry.label || ''),
          JSON.stringify(entry.payload && typeof entry.payload === 'object' ? entry.payload : {}),
        ],
      });
    }
    await syncProductStock(productId);
    return res.status(201).json({ ok: true, added: entries.length });
  } catch (error) {
    return next(error);
  }
});

router.delete('/inventory/:id', async (req, res, next) => {
  try {
    const stock = await db.execute({
      sql: "SELECT product_id FROM inventory WHERE id = ? AND status = 'available'",
      args: [Number(req.params.id)],
    });
    if (!stock.rows[0]) return res.status(409).json({ error: 'Inventori tidak dapat dihapus' });
    await db.execute({ sql: 'DELETE FROM inventory WHERE id = ?', args: [Number(req.params.id)] });
    await syncProductStock(Number(stock.rows[0].product_id));
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const status = String(req.query.status || '');
    const result = await db.execute({
      sql: `SELECT * FROM orders WHERE (? = '' OR status = ?) ORDER BY id DESC LIMIT 200`,
      args: [status, status],
    });
    res.json({
      orders: result.rows.map((row) => serializeOrder(row)),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:publicId', async (req, res, next) => {
  try {
    const data = await getOrder(req.params.publicId);
    if (!data) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    return res.json({ order: serializeOrder(data.row, data.items) });
  } catch (error) {
    return next(error);
  }
});

router.post('/orders/:publicId/retry', async (req, res, next) => {
  try {
    const data = await getOrder(req.params.publicId);
    if (!data) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    await db.execute({
      sql: `UPDATE orders SET status = CASE WHEN paid_at IS NULL THEN 'pending_payment' ELSE 'processing' END,
        failure_reason = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [data.row.id],
    });
    await db.execute({
      sql: `UPDATE order_items SET status = CASE WHEN ? IS NULL THEN 'waiting_payment' ELSE 'processing' END,
        failure_reason = '', updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status IN ('failed', 'needs_action')`,
      args: [data.row.paid_at, data.row.id],
    });
    return res.json({ order: await refreshOrder(req.params.publicId) });
  } catch (error) {
    return next(error);
  }
});

router.post('/orders/:publicId/simulate-payment', async (req, res, next) => {
  try {
    const data = await getOrder(req.params.publicId);
    if (!data) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    await simulatePayment(data.row.payment_trx_id);
    return res.json({ order: await refreshOrder(req.params.publicId) });
  } catch (error) {
    return next(error);
  }
});

router.get('/settings', async (_req, res, next) => {
  try {
    const ripay = await getRipayConfig();
    const digiflazz = await getDigiflazzConfig();
    res.json({
      settings: {
        ripay_base_url: ripay.baseUrl,
        ripay_api_key: ripay.apiKey ? '••••••••' : '',
        ripay_api_secret: ripay.apiSecret ? '••••••••' : '',
        digiflazz_username: digiflazz.username,
        digiflazz_api_key: digiflazz.apiKey ? '••••••••' : '',
        digiflazz_webhook_secret: (await getSetting(
          'digiflazz_webhook_secret',
          process.env.DIGIFLAZZ_WEBHOOK_SECRET || '',
        )) ? '••••••••' : '',
        digiflazz_testing: digiflazz.testing,
        whatsapp_phone: await getSetting('whatsapp_phone', ''),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const allowed = [
      'ripay_base_url',
      'ripay_api_key',
      'ripay_api_secret',
      'digiflazz_username',
      'digiflazz_api_key',
      'digiflazz_webhook_secret',
      'digiflazz_testing',
      'admin_username',
      'admin_password',
    ];
    for (const key of allowed) {
      if (!(key in req.body)) continue;
      const value = String(req.body[key]);
      if (value === '••••••••') continue;
      await setSetting(
        key,
        value,
        sensitiveSettings.has(key) || key === 'admin_password',
      );
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get('/whatsapp', (_req, res) => {
  res.json({ whatsapp: whatsappManager.snapshot() });
});

router.post('/whatsapp/connect', async (req, res, next) => {
  try {
    res.json({ whatsapp: await whatsappManager.connect(req.body?.phone) });
  } catch (error) {
    next(error);
  }
});

router.post('/whatsapp/logout', async (_req, res, next) => {
  try {
    await whatsappManager.logout();
    res.json({ whatsapp: whatsappManager.snapshot() });
  } catch (error) {
    next(error);
  }
});

function normalizeProduct(input) {
  const name = String(input.name || '').trim();
  const price = Math.round(Number(input.price));
  if (!name || !Number.isFinite(price) || price < 0) throw new Error('Nama dan harga produk tidak valid');
  return {
    slug: slugify(input.slug || name),
    name,
    category: String(input.category || 'Lainnya').trim(),
    description: String(input.description || '').trim(),
    price,
    stock: Math.max(0, Math.round(Number(input.stock || 0))),
    image_url: String(input.image_url || '').trim(),
    icon: String(input.icon || 'sparkles').trim(),
    fulfillment_type: ['inventory', 'digiflazz', 'manual'].includes(input.fulfillment_type)
      ? input.fulfillment_type
      : 'manual',
    provider_sku: String(input.provider_sku || '').trim(),
    customer_fields: Array.isArray(input.customer_fields) ? input.customer_fields : [],
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    active: input.active === false ? 0 : 1,
  };
}

function productArgs(product) {
  return [
    product.slug,
    product.name,
    product.category,
    product.description,
    product.price,
    product.stock,
    product.image_url,
    product.icon,
    product.fulfillment_type,
    product.provider_sku,
    JSON.stringify(product.customer_fields),
    JSON.stringify(product.metadata),
    product.active,
  ];
}

async function syncProductStock(productId) {
  await db.execute({
    sql: `UPDATE products SET stock = (
      SELECT COUNT(*) FROM inventory WHERE product_id = ? AND status = 'available'
    ), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [productId, productId],
  });
}

module.exports = router;
