require('dotenv').config();

const { app, initialize, startBackgroundJobs } = require('./src/app');

const port = Number(process.env.PORT || 3000);

initialize()
  .then(() => {
    app.listen(port, () => {
      console.log(`RianShop API aktif di http://localhost:${port}`);
    });
    startBackgroundJobs();
  })
  .catch((error) => {
    console.error('Aplikasi gagal dijalankan:', error);
    process.exitCode = 1;
  });
