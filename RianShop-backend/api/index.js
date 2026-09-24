const { app, initialize } = require('../src/app');

const initialization = initialize();

module.exports = async function handler(req, res) {
  try {
    await initialization;
    return app(req, res);
  } catch (error) {
    console.error('Gagal menginisialisasi aplikasi:', error);
    return res.status(503).json({ error: 'Aplikasi gagal diinisialisasi' });
  }
};
