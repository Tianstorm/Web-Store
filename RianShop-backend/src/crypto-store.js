const crypto = require('node:crypto');
const { settingsEncryptionKey } = require('./config');

function keyBuffer() {
  if (!settingsEncryptionKey) return null;
  return crypto.createHash('sha256').update(settingsEncryptionKey).digest();
}

function encrypt(value) {
  const key = keyBuffer();
  if (!key) {
    throw new Error('SETTINGS_ENCRYPTION_KEY wajib dikonfigurasi sebelum menyimpan rahasia');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(value) {
  const text = String(value || '');
  if (!text.startsWith('enc:')) return text;
  const key = keyBuffer();
  if (!key) throw new Error('SETTINGS_ENCRYPTION_KEY diperlukan untuk membaca konfigurasi');
  const [, iv, tag, ciphertext] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

module.exports = { decrypt, encrypt, mask };
