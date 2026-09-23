const crypto = require('node:crypto');
const express = require('express');
const { db, getSetting } = require('../db');
const {
  createOrder,
  handleDigiflazzCallback,
  refreshOrder,
  serializeProduct,
} = require('../services/orders');

const router = express.Router();

function orderToken(req) {
  return String(req.headers['x-order-token'] || req.query.token || '');
}

router.get('/products', async (_req, res, next) => {
  try {
    const result = await db.execute(
      'SELECT * FROM products WHERE active = 1 ORDER BY category, id',
    );
    res.json({ products: result.rows.map(serializeProduct) });
  } catch (error) {
    next(error);
  }
});

router.post('/orders', async (req, res, next) => {
  try {
    const order = await createOrder(req.body);
    res.status(201).json({ order });
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:publicId', async (req, res, next) => {
  try {
    const order = await refreshOrder(req.params.publicId, orderToken(req));
    if (!order) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    return res.json({ order });
  } catch (error) {
    return next(error);
  }
});

router.post('/digiflazz/callback', async (req, res, next) => {
  try {
    const secret = await getSetting(
      'digiflazz_webhook_secret',
      process.env.DIGIFLAZZ_WEBHOOK_SECRET || '',
    );
    if (!secret) return res.status(503).json({ error: 'Webhook Digiflazz belum dikonfigurasi' });
    const expected = `sha1=${crypto
      .createHmac('sha1', secret)
      .update(req.rawBody || Buffer.from(''))
      .digest('hex')}`;
    const received = String(req.headers['x-hub-signature'] || '');
    const valid =
      expected.length === received.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!valid) return res.status(401).json({ error: 'Signature webhook tidak valid' });
    const handled = await handleDigiflazzCallback(req.body);
    res.json({ ok: true, handled });
  } catch (error) {
    next(error);
  }
});

router.get('/health', async (_req, res) => {
  res.json({ ok: true, service: 'rianshop-api', time: new Date().toISOString() });
});

module.exports = router;
