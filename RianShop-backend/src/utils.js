const crypto = require('node:crypto');

function asJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function createPublicId(prefix) {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${prefix}-${date}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}

function isValidPhone(value) {
  return /^62\d{8,13}$/.test(normalizePhone(value));
}

function rupiah(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function safeText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function slugify(value) {
  return safeText(value, 120)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function interpolate(template, values) {
  return String(template || '').replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) =>
    safeText(values[key], 120),
  );
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  asJson,
  createPublicId,
  interpolate,
  isValidPhone,
  normalizePhone,
  rupiah,
  safeText,
  slugify,
  timingSafeEqualText,
};
