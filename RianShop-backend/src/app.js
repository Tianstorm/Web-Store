const fs = require('node:fs');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const { allowedOrigins, zaileysAuthPath } = require('./config');
const { initializeDatabase } = require('./db');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const { processOpenOrders } = require('./services/orders');
const { whatsappManager } = require('./services/whatsapp');

const app = express();
let initialized = false;
let jobTimer = null;

app.disable('x-powered-by');
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin tidak diizinkan'));
    },
  }),
);
app.use(express.json({
  limit: '1mb',
  verify(req, _res, buffer) {
    req.rawBody = buffer;
  },
}));
app.use('/uploads', express.static(path.resolve(zaileysAuthPath, '..', 'uploads'), {
  fallthrough: false,
  maxAge: '7d',
}));
app.use('/api/admin', adminRoutes);
app.use('/api', publicRoutes);

app.use((error, _req, res, _next) => {
  const status =
    Number(error.status) || (
    error.type === 'entity.too.large' ? 413 :
    /wajib|tidak valid|tidak tersedia|tidak mencukupi|baru saja habis|terlalu panjang|belum diatur|belum dikonfigurasi/i.test(error.message) ? 400 :
    500);
  if (status === 500) console.error(error);
  res.status(status).json({ error: error.message || 'Terjadi kesalahan pada server' });
});

async function initialize() {
  if (initialized) return;
  fs.mkdirSync(path.resolve(zaileysAuthPath, '..'), { recursive: true });
  await initializeDatabase();
  initialized = true;
  whatsappManager.restore().catch((error) => {
    console.error('Gagal memulihkan WhatsApp:', error.message);
  });
}

function startBackgroundJobs() {
  if (jobTimer) return;
  const run = () => processOpenOrders().catch((error) => console.error('Background job:', error.message));
  run();
  jobTimer = setInterval(run, 10000);
  jobTimer.unref();
}

module.exports = { app, initialize, startBackgroundJobs };
