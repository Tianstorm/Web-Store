const { app, initialize } = require('../src/app');

initialize().catch((error) => {
  console.error('Gagal menginisialisasi aplikasi:', error);
});

module.exports = app;
