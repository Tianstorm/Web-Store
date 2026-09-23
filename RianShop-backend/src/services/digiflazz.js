const crypto = require('node:crypto');
const axios = require('axios');
const { backendUrl } = require('../config');
const { getSetting } = require('../db');

async function getDigiflazzConfig() {
  const testingValue = await getSetting(
    'digiflazz_testing',
    process.env.DIGIFLAZZ_TESTING || 'true',
  );
  return {
    username: await getSetting('digiflazz_username', process.env.DIGIFLAZZ_USERNAME || ''),
    apiKey: await getSetting('digiflazz_api_key', process.env.DIGIFLAZZ_API_KEY || ''),
    testing: String(testingValue).toLowerCase() === 'true',
  };
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

async function topup({ sku, customerNo, refId }) {
  const config = await getDigiflazzConfig();
  if (!config.username || !config.apiKey) {
    throw new Error('Username dan API key Digiflazz belum dikonfigurasi');
  }
  if (!sku) throw new Error('SKU Digiflazz produk belum diatur');

  try {
    const response = await axios.post(
      'https://api.digiflazz.com/v1/transaction',
      {
        username: config.username,
        buyer_sku_code: sku,
        customer_no: customerNo,
        ref_id: refId,
        sign: md5(`${config.username}${config.apiKey}${refId}`),
        testing: config.testing,
        cb_url: `${backendUrl.replace(/\/$/, '')}/api/digiflazz/callback`,
      },
      {
        timeout: 30000,
        maxContentLength: 1024 * 1024,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    if (!response.data?.data) throw new Error('Respons Digiflazz tidak valid');
    return response.data.data;
  } catch (error) {
    const message =
      error.response?.data?.data?.message ||
      error.response?.data?.message ||
      error.message;
    throw new Error(`Digiflazz: ${message}`);
  }
}

module.exports = { getDigiflazzConfig, topup };
