# RianShop Backend

API toko digital untuk katalog, QRIS Ripay, fulfillment inventori, Digiflazz,
dashboard admin, dan pengiriman struk WhatsApp melalui Zaileys HTML cards.

## Menjalankan lokal

Persyaratan: Node.js 20 atau lebih baru.

```bash
cp .env.example .env
npm install --legacy-peer-deps
npm run dev
```

API berjalan di `http://localhost:3000`. Database lokal tersimpan di
`.data/rianshop.db`.

## Konfigurasi wajib

- `JWT_SECRET`: secret panjang untuk sesi admin.
- `SETTINGS_ENCRYPTION_KEY`: secret untuk enkripsi kredensial integrasi.
- `RIPAY_API_KEY` dan `RIPAY_API_SECRET`: kredensial Ripay.
- `DIGIFLAZZ_USERNAME`, `DIGIFLAZZ_API_KEY`, dan
  `DIGIFLAZZ_WEBHOOK_SECRET`: kredensial buyer dan validasi webhook Digiflazz.
- `FRONTEND_URL` dan `BACKEND_URL`: URL publik frontend dan backend.
- `ADMIN_USERNAME` dan `ADMIN_PASSWORD`: login awal admin.

Nilai integrasi juga dapat disimpan dari dashboard admin. Nilai sensitif
dienkripsi dengan AES-256-GCM bila `SETTINGS_ENCRYPTION_KEY` tersedia.

## Fulfillment

- Produk `inventory` mengambil satu stok yang sudah direservasi. Isi
  `payload` bebas, misalnya kredensial VPS:

```json
{
  "ip": "203.0.113.10",
  "username": "root",
  "password": "secret",
  "port": "22"
}
```

- Hosting dapat menggunakan `panel_url`, `username`, dan `password`.
- Produk `digiflazz` membutuhkan `provider_sku` yang sesuai price list akun
  Digiflazz.
- Nomor token PLN dibaca dari field `sn` respons Digiflazz.

## WhatsApp

Masukkan nomor bot pada dashboard, buka **Perangkat tertaut** di WhatsApp,
pilih tautkan dengan nomor telepon, lalu masukkan pairing code yang tampil.
Zaileys menyimpan sesi di `ZAILEYS_AUTH_PATH`.

HTML cards hanya dirender penuh pada WhatsApp Android. Zaileys otomatis
mengirim fallback teks ke perangkat yang tidak mendukungnya.

## Deployment

Gunakan proses Node.js yang selalu aktif dengan penyimpanan persisten
(misalnya VPS, Fly.io, Railway, atau Render). Zaileys membutuhkan koneksi
WebSocket dan auth storage persisten; deployment serverless Vercel tidak
cocok untuk bot WhatsApp yang harus selalu terhubung.

Untuk produksi, gunakan Turso melalui `TURSO_DATABASE_URL` dan
`TURSO_AUTH_TOKEN`, lalu mount volume persisten untuk `ZAILEYS_AUTH_PATH` dan
folder upload.

## Verifikasi

```bash
npm run lint
npm test
npm audit --omit=dev
```
