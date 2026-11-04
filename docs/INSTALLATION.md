# Instalasi internal — revisi Oktober2026

Gunakan [Panduan Mas Togar](PANDUAN-TOGAR.md) untuk rincian arsitektur dan pemetaan file. Sumber utama adalah MySQL iot_binus yang diisi API Mas Togar; SQLite hanya cache serta state aplikasi internal.

## 1. Setup Windows

Node.js ≥22.18.0 dan npm diperlukan. Jalankan semua terminal dari folder proyek. npm.cmd menghindari pembatasan PowerShell pada npm.ps1.

```powershell
npm.cmd ci
npm.cmd run setup -- --mode simulation
```

Setup menghasilkan secret lokal tetapi tidak menimpa .env.local yang sudah ada. Default contoh: APP_MODE=simulation, DATA_SOURCE=mysql, DASHBOARD_POLL_SECONDS=300. Migrasi sebelumnya tetap dipertahankan.

Isi .env.local dengan target MySQL sebenarnya dan akun SELECT-only:

```dotenv
APP_MODE=simulation
DATA_DIR=./data-togar-demo
DATA_SOURCE=mysql
DASHBOARD_POLL_SECONDS=300
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=iot_binus
MYSQL_USER=akun_baca_iot
MYSQL_PASSWORD=ISI_LOKAL
MYSQL_TIME_ZONE=+07:00
MYSQL_SSL=false
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
BASE_URL=http://127.0.0.1:3000
```

Ganti contoh user/password secara lokal. MYSQL_HOST menunjuk mesin database dari sisi worker; localhost hanya jika satu mesin. MYSQL_TIME_ZONE adalah interpretasi DATETIME aplikasi, bukan perintah mengubah zona MySQL. MYSQL_SSL=true memakai TLS dengan verifikasi sertifikat. Simpan DEVICE_API_KEY dan CSRF_SECRET yang dibuat setup; key ini bukan kredensial API Mas Togar.

## 2. Server dan worker

Terminal pertama:

```powershell
npm.cmd run migrate
npm.cmd run build
npm.cmd run start
```

Terminal kedua:

```powershell
npm.cmd run worker
```

Buka http://127.0.0.1:3000. Health konfigurasi tersedia pada /api/v2/health; periksa version2 dan data_source=mysql. Keberhasilan MySQL dilihat dari status sinkronisasi/error, bukan health saja.

Dashboard refresh otomatis300detik atau tombol Perbarui. Worker menyelesaikan query MySQL lalu berjeda5detik. SMTP berjalan sebagai satu tugas latar, sehingga koneksi email lambat tidak menahan polling MySQL. Worker tetap berjalan ketika browser ditutup. --once hanya untuk diagnosis satu putaran dan menunggu tugas email selesai.

MySQL dibaca dengan ID cursor dan overlap200ID; sumber harus append-only. ID berubah/invalid dikarantina, tidak menimpa cache; keterlambatan di luar jendela tidak dijamin tertangkap. Rincian bootstrap dan penolakan baris ada di panduan utama.

## 3. Email

Daftarkan penerima di dashboard sebelum insiden uji. Isi SMTP_HOST, SMTP_FROM, SMTP_PORT, SMTP_SECURE, SMTP_REQUIRE_TLS, serta SMTP_USER/PASSWORD sesuai layanan. Default port587, secure=false, requireTLS=true. Restart worker setelah perubahan.

Dikonfigurasi hanya berarti HOST/FROM tersedia, bukan bukti inbox. Tanpa SMTP, pending tetap terlihat; alarm lebih dari lima menit atau penerima nonaktif menjadi skipped. Insiden singkat yang sudah berakhir tetapi masih baru tetap dikirim. Sent berarti diterima SMTP; failed/unknown tidak diulang otomatis. Sisa sending saat restart menjadi unknown.

## 4. Simulation dan real

Gunakan instalasi/env/data terpisah. Untuk folder source bersih, jalankan setup --mode real, lalu isi MySQL dan SMTP yang disetujui. Setup tidak mengganti mode pada file lama. APP_MODE memilih simulation.sqlite atau real.sqlite pada DATA_DIR; tidak mengubah MySQL eksternal menjadi database uji, dan tidak memblokir email nyata apabila dikonfigurasi.

Jangan menyalin cache/antrean/secret demo ke real. Migrasi lokal002/003 menambah monitoring/karantina pada SQLite, bukan mengubah MySQL. API v2 dan simulator hanyalah alternatif uji; gunakan DATA_SOURCE=api dan mode simulation untuk simulator.

## 5. Jaringan dan backup

Server default bind127.0.0.1. Untuk jaringan tim gunakan reverse proxy internal HTTPS ke listener tersebut dan firewall untuk subnet/IP yang disetujui. Jika mengaktifkan listener LAN untuk demo, sesuaikan ALLOWED_ORIGINS dengan skema/host/port sebenarnya. Tidak ada login dashboard; siapa pun yang menjangkau UI dapat mengatur penerima. CORS dan CSRF bukan pengganti pembatasan jaringan. Jangan expose ke internet publik.

Hentikan worker/server normal sebelum backup keseluruhan DATA_DIR, termasuk SQLite/WAL yang masih ada; simpan environment dengan akses terbatas. Backup MySQL dilakukan terpisah oleh pengelola sumber. Jangan reset ID sumber atau menghapus cursor ketika proses berjalan.

Panduan instalasi September dipertahankan pada [legacy/INSTALLATION.md](legacy/INSTALLATION.md). Referensi aktif: [PANDUAN-TOGAR.md](PANDUAN-TOGAR.md), [SIMULATOR.md](SIMULATOR.md), [openapi-v2.json](openapi-v2.json).
