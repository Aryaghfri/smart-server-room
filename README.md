# Smart Server Room — Monitoring DHT, PIR, dan MQ

Revisi **26 Oktober 2026**, kelompok **KELAPA · BINUS Online University**. Alur utama mengikuti sistem Mas Togar yang sudah ada:

```text
Perangkat → API Mas Togar → MySQL iot_binus (dht, pir, mq)
                                     ↓ SELECT oleh worker
                          cache dan antrean email lokal
                              ↓                ↓
                       dashboard web      SMTP → penerima
                       refresh 5 menit    worker ±5 detik
```

API Mas Togar tetap digunakan perangkat. Web membaca MySQL melalui akun SELECT. SQLite menjadi cache persisten serta tempat cursor, penerima, insiden, dan antrean email internal; **bukan pengganti MySQL iot_binus**. API `/api/v2/device/*` aplikasi ini hanya jalur alternatif pengujian dan bukan API Mas Togar.

Panduan utama: **[PANDUAN-TOGAR.md](docs/PANDUAN-TOGAR.md)** — setup, arti data, email, pengujian, peta file/fungsi, dan troubleshooting.

Firmware ESP32 dari tim IoT ada di **[firmware/](firmware/README.md)**, API Flask penerima data di **[api-flask/](api-flask/README.md)**.

### Prediksi suhu besok (model ML)

Ringkasan dashboard menampilkan **prediksi suhu besok untuk pagi, siang, dan malam**. Model ML mengisi tabel MySQL `prediksi_suhu` (buat dengan [api-flask/prediksi_suhu.sql](api-flask/prediksi_suhu.sql)); worker membacanya dengan SELECT setiap putaran dan memakai baris terbaru per waktu untuk tanggal besok (WIB). Selama tabel belum ada atau belum berisi data besok, kartu menampilkan *Menunggu prediksi*.

## Menjalankan dari Windows

Persyaratan: Node.js ≥22.18.0 dan npm. Jalankan semua terminal dari folder proyek; gunakan `npm.cmd` bila PowerShell memblokir `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd run setup -- --mode simulation
```

Setup default memakai `APP_MODE=simulation` dan `DATA_SOURCE=mysql`. Isi kredensial MySQL pada `.env.local` sesuai [panduan](docs/PANDUAN-TOGAR.md#3-menjalankan-jalur-utama-mysql). Setup menghasilkan secret lokal dan **tidak menimpa** `.env.local` lama. Jangan commit secret atau data.

```powershell
npm.cmd run migrate
npm.cmd run build
npm.cmd run start
```

Buka `http://127.0.0.1:3000`. Jalankan terminal kedua dari folder yang sama:

```powershell
npm.cmd run worker
```

Dashboard memperbarui tampilan otomatis setiap **300 detik / 5 menit**; tombol **Perbarui** mengambil data segera. Worker membaca MySQL dan memproses email dengan jeda **5 detik setelah pekerjaan sebelumnya selesai**, termasuk ketika browser ditutup. Server web saja tidak menjalankan worker.

## Demo tanpa MySQL aktif

Import dump yang disertakan sebagai arsip, hanya pada mode simulation:

```powershell
npm.cmd run import:sql -- examples/iot_binus.sql
```

Dump berisi **69 DHT + 69 PIR + 69 MQ = 207 record**. Importer hanya membaca INSERT, tidak mengeksekusi SQL dump, tidak mengubah MySQL, tidak membuat perangkat online, dan tidak mengirim email arsip. Worker MySQL tidak diperlukan untuk melihat arsip. Ini bukan bukti koneksi MySQL langsung.

Untuk data uji baru melalui API alternatif, ubah lingkungan demo menjadi `DATA_SOURCE=api`, tetap `APP_MODE=simulation`, lalu restart server. Jalankan satu skenario pada satu waktu:

```powershell
npm.cmd run simulator -- --scenario=normal
npm.cmd run simulator -- --scenario=motion --once
npm.cmd run simulator -- --scenario=sensor-error --once
npm.cmd run simulator -- --scenario=smoke --once
```

Skenario smoke membentuk insiden/antrean bagi penerima aktif; pengiriman memerlukan worker dan SMTP. Data simulator bukan laporan hardware. Gunakan direktori data demo yang berbeda dari real.

## Arti status

- `dht.status`: laporan kipas, **0 OFF / 1 ON**; bukan status berhasil/gagal membaca DHT.
- `pir.status`: **0 tidak ada deteksi / 1 terdeteksi**. Target LED mengikuti PIR, tetapi tabel SQL tidak menyediakan konfirmasi fisik LED. PIR tidak menghitung penghuni.
- `mq.status`: **0 tidak terdeteksi / 1 asap terdeteksi**. Schema tidak menyediakan konsentrasi PPM.
- `create_date` ditafsirkan sebagai WIB (`MYSQL_TIME_ZONE=+07:00`), disimpan lokal dalam UTC, ditampilkan kembali dalam WIB.
- Email dideduplikasi per insiden/penerima. `sent` berarti SMTP menerima pesan, bukan jaminan masuk inbox. Hasil ambigu menjadi `unknown` dan tidak dikirim ulang otomatis.

## Pengujian dan batas penerapan

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Pemeriksaan awal revisi mencatat **14 tes unit monitoring serta build Next.js 16.4.3 lulus**; pengujian tambahan dan E2E revisi dijalankan terpisah setelah perubahan akhir. Jangan memakai hasil versi September sebagai bukti revisi ini. Koneksi MySQL Mas Togar live, inbox email nyata, dan hardware belum boleh dianggap teruji dari hasil unit/simulator.

Dashboard tanpa login harus tetap dibatasi firewall/reverse proxy internal. Tidak ada deployment publik. `docs/INTEGRATION.md`, `docs/SIMULATOR.md`, `docs/openapi.json`, `CONTRACT.md`, dan laporan September di `docs/TESTING.md` menjelaskan **versi lama /api/v1**. Gunakan panduan Oktober untuk integrasi saat ini. Perintah lama tersedia sebagai `simulator:legacy`, `test:legacy`, dan `test:e2e:legacy`.
