const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');

function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ ok: false, message: 'Akses admin diperlukan' });
  if (!jwtSecret) {
    return res.status(503).json({ ok: false, message: 'JWT_SECRET belum dikonfigurasi' });
  }
  try {
    req.admin = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Sesi admin tidak valid atau kedaluwarsa' });
  }
}

module.exports = { authenticateAdmin };
