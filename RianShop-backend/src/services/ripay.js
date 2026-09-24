const axios = require('axios');
const { getSetting } = require('../db');

async function getRipayConfig() {
  return {
    baseUrl: (await getSetting('ripay_base_url', process.env.RIPAY_BASE_URL || 'https://ripayman.my.id')).replace(/\/$/, ''),
    apiKey: await getSetting('ripay_api_key', process.env.RIPAY_API_KEY || ''),
    apiSecret: await getSetting('ripay_api_secret', process.env.RIPAY_API_SECRET || ''),
  };
}

async function ripayRequest(method, path, data) {
  const config = await getRipayConfig();
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('API key dan API secret Ripay belum dikonfigurasi');
  }
  try {
    const response = await axios({
      method,
      url: `${config.baseUrl}${path}`,
      data,
      timeout: 15000,
      maxContentLength: 1024 * 1024,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.apiKey,
        'X-Api-Secret': config.apiSecret,
      },
    });
    return response.data;
  } catch (error) {
    const message =
      error.response?.data?.message || error.response?.data?.error || error.message;
    throw new Error(`Ripay: ${message}`);
  }
}

async function createPayment({ amount, customerRef, note, redirectUrl }) {
  const data = await ripayRequest('post', '/api/v1/transactions', {
    amount,
    customer_ref: customerRef,
    note,
    redirect_url: redirectUrl,
  });
  const transaction = data.transaction || data;
  if (data.ok === false || !transaction.trx_id || !transaction.payment_page_url) {
    throw new Error('Ripay tidak mengembalikan transaksi yang valid');
  }
  return transaction;
}

async function getPayment(trxId) {
  const data = await ripayRequest(
    'get',
    `/api/v1/transactions/${encodeURIComponent(trxId)}`,
  );
  return data.transaction || data;
}

async function simulatePayment(trxId) {
  return ripayRequest(
    'post',
    `/api/v1/transactions/${encodeURIComponent(trxId)}/simulate-payment`,
  );
}

module.exports = { createPayment, getPayment, getRipayConfig, simulatePayment };
