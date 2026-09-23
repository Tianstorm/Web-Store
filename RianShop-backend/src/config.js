const path = require('node:path');

const isProduction = process.env.NODE_ENV === 'production';

function getDatabaseUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  return `file:${path.resolve(process.cwd(), '.data/rianshop.db')}`;
}

function getAllowedOrigins() {
  return (process.env.FRONTEND_URL || 'http://localhost:4173,http://127.0.0.1:4173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

module.exports = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:3000',
  frontendUrl: getAllowedOrigins()[0] || 'http://localhost:4173',
  databaseUrl: getDatabaseUrl(),
  databaseAuthToken: process.env.TURSO_AUTH_TOKEN || undefined,
  isProduction,
  jwtSecret: process.env.JWT_SECRET || '',
  settingsEncryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || '',
  allowedOrigins: getAllowedOrigins(),
  zaileysAuthPath:
    process.env.ZAILEYS_AUTH_PATH || path.resolve(process.cwd(), '.data/zaileys'),
};
