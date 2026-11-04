# Panduan Mas Togar — monitoring MySQL dan email asap

Revisi 26 Oktober 2026 · Smart Server Room · KELAPA · BINUS Online University.

**Jalur utama tetap: perangkat → API Mas Togar yang sudah ada → MySQL `iot_binus` → web membaca database.** Dashboard menambahkan monitoring DHT/PIR/MQ dan email asap. Tidak perlu mengganti endpoint firmware hanya untuk menampilkan database yang sudah berjalan.

## 1. Alur dan pembagian tanggung jawab

```text
Perangkat: sensor, kipas, LED, logika lokal
                   ↓
             API Mas Togar
                   ↓
       MySQL iot_binus: dht / pir / mq
                   ↓ SELECT saja
             monitor-worker
         ┌─────────┴──────────┐
    cache SQLite       insiden + antrean email
         ↓                    ↓
    Next.js/web          SMTP → penerima
 refresh 300 detik     worker berjeda 5 detik
```

| Komponen | Tanggung jawab |
|---|---|
| Perangkat dan API Mas Togar | Membaca sensor, menjalankan kipas/LED, dan menulis hasil ke MySQL. URL, auth, serta payload API mengikuti implementasi Mas Togar; tidak ditebak dalam panduan |
| MySQL `iot_binus` | Sumber utama data. Web tidak membuat, menghapus, atau memperbarui tabel MySQL |
| Worker | Membaca ID baru, memperbarui cache/cursor, lalu memproses antrean SMTP |
| SQLite internal | Cache histori, cursor, penolakan baris, penerima, insiden, dan status email persisten; **bukan pengganti MySQL utama** |
| Dashboard | Ringkasan, grafik, histori, insiden, penerima email, dan status integrasi |
| API `/api/v2` aplikasi ini | Jalur alternatif untuk pengujian bila `DATA_SOURCE=api`. **Bukan endpoint API Mas Togar** |

Pada jalur MySQL, dashboard membaca laporan kipas `dht.status`. Perubahan ambang web tidak dikirim balik ke firmware; atur ambang pada firmware Mas Togar. Kontrol lokal perangkat tidak menunggu browser atau worker.

## 2. Arti tiga tabel

Dump `examples/iot_binus.sql` tanggal 25 Oktober 2026 berisi **69 baris DHT, 69 PIR, dan 69 MQ**, total **207 record**. Itu jumlah arsip contoh, bukan jumlah tetap database live.

| Tabel | Kolom yang dibaca | Arti status |
|---|---|---|
| `dht` | `id`, `suhu`, `kelembapan`, `status`, `create_date` | 0 = kipas mati; 1 = kipas menyala |
| `pir` | `id`, `status`, `create_date` | 0 = tidak ada deteksi; 1 = orang/gerakan terdeteksi |
| `mq` | `id`, `status`, `create_date` | 0 = tidak terdeteksi asap; 1 = asap terdeteksi |

- DHT menyimpan suhu/kelembapan sebagai teks angka pada dump. Adapter mengubahnya menjadi angka °C dan %. Nilai kosong/tidak valid menjadi null/null dengan `INVALID_DHT_VALUE`, bukan nol. Rentang aplikasi: suhu −40..80°C, kelembapan 0..100%.
- `dht.status` adalah **laporan kipas**, bukan kode sensor normal/gagal. Nilai null tetap belum diketahui.
- PIR bukan penghitung orang, identitas wajah, atau bukti seseorang masuk. Banyak sampel bernilai 1 dapat berasal dari kejadian yang sama.
- Tabel PIR tidak memiliki umpan balik LED. Web membedakan **target LED berdasarkan PIR** dari **status LED fisik yang belum dilaporkan**. Data MySQL/import memiliki `lamp_on:null`.
- MQ hanya menyediakan status biner. Tidak ada konsentrasi **PPM**, sehingga web tidak mengarang angka PPM atau tingkat bahaya berdasarkan angka yang tidak tersedia.
- Kolom DHT `update _date` memang memiliki spasi. Aplikasi tidak mengganti schema dan tidak memakai kolom itu; waktu utama tetap `create_date`.

`DATETIME` MySQL tidak menyimpan zona waktu. `MYSQL_TIME_ZONE=+07:00` berarti `2026-10-25 14:55:13` dibaca sebagai **14:55:13 WIB**, disimpan di cache sebagai `2026-10-25T07:55:13.000Z`, kemudian ditampilkan kembali dalam WIB hingga detik. Variabel ini mengatur interpretasi aplikasi, bukan mengubah zona global MySQL. Pastikan waktunya sesuai dengan penulis data di API Mas Togar.

## 3. Menjalankan jalur utama MySQL

Gunakan Node.js ≥22.18.0 dan npm. Semua terminal harus berada di folder proyek. Di Windows, `npm.cmd` dapat digunakan tanpa mengubah kebijakan PowerShell untuk `npm.ps1`.

### Instalasi baru dan environment

```powershell
npm.cmd ci
npm.cmd run setup -- --mode simulation
```

Default contoh sekarang adalah `APP_MODE=simulation`, `DATA_SOURCE=mysql`, dan `DASHBOARD_POLL_SECONDS=300`. Setup membuat API key/secret CSRF acak hanya bila `.env.local` belum ada. **Setup tidak menimpa file lama.** Menjalankan ulang dengan `--mode real` tidak otomatis mengganti mode atau kredensial lama.

Isi `.env.local` secara lokal, misalnya:

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

Nama akun/password adalah contoh, bukan kredensial siap pakai. Minta pemilik database menyediakan akun **SELECT saja** pada tiga tabel; jangan memakai root untuk runtime. `MYSQL_HOST=127.0.0.1` hanya benar jika MySQL ada pada komputer worker. Gunakan IP/hostname internal apabila berbeda komputer.

`MYSQL_SSL=true` mengaktifkan TLS dengan verifikasi sertifikat. Sesuaikan dengan server sebenarnya; jangan menonaktifkan validasi sertifikat untuk mengatasi error. API key, secret CSRF, password MySQL, dan password SMTP tidak boleh masuk frontend/repository. `BASE_URL` dipakai simulator opsional; variabel itu tidak mengubah listener server atau URL API Mas Togar.

### Jalankan web dan worker

Terminal pertama:

```powershell
npm.cmd run migrate
npm.cmd run build
npm.cmd run start
```

Terminal kedua, folder/environment sama:

```powershell
npm.cmd run worker
```

Periksa:

```powershell
$health = Invoke-RestMethod 'http://127.0.0.1:3000/api/v2/health'
$health.data
```

Harus memuat `version:2`, mode yang dipilih, dan `data_source:mysql`. Health hanya menyatakan konfigurasi aplikasi; keberhasilan MySQL dilihat dari status sinkronisasi/error pada halaman Integrasi. Buka `http://127.0.0.1:3000`. Untuk satu putaran diagnosis tersedia `npm.cmd run worker -- --once`; penggunaan normal membutuhkan worker terus berjalan.

`npm run migrate` menerapkan migrasi SQLite internal, bukan MySQL Mas Togar. Server web saja tidak menghidupkan worker. Restart server dan worker setelah mengganti environment; variabel yang sudah diset pada terminal juga perlu diperiksa jika file tampak tidak berpengaruh.

### Beralih ke hardware real

1. Hentikan proses demo secara normal.
2. Gunakan folder source bersih serta `DATA_DIR` terpisah. Jangan salin `.env.local`, cache/data demo, atau antrean email lama.
3. Buat environment baru dengan `npm.cmd run setup -- --mode real`, kemudian isi `DATA_SOURCE=mysql`, akses database yang disetujui, Origin, dan SMTP.
4. Jalankan migrasi/build/server/worker; health harus menyatakan `mode:real`.
5. Verifikasi ID baru yang ditulis API Mas Togar muncul pada web. Label real sendiri bukan bukti hardware terintegrasi.

Mode aplikasi memilih file lokal `<DATA_DIR>/simulation.sqlite` atau `<DATA_DIR>/real.sqlite`. **APP_MODE=simulation tidak otomatis menjadikan MySQL eksternal sebagai database uji dan tidak mencegah email ke penerima nyata** bila SMTP/worker diaktifkan. Pilih target database dan penerima secara sengaja. API key aplikasi ini tetap terpisah dari kredensial API Mas Togar.

## 4. Bootstrap, cursor, dan batas sinkronisasi

Worker menyimpan `MAX(id)` setiap tabel saat pertama kali mengenali sumber MySQL. Baris yang sudah ada hingga batas bootstrap diambil sebagai **arsip awal**, tanpa alarm/email lama. Sesudah itu, pembacaan memakai `WHERE id > ? ORDER BY id LIMIT 500` per tabel/per putaran, dengan parameter batas bawah `Math.max(0, cursor - 200)` yang dihitung aplikasi. Cursor disimpan persisten dan dilanjutkan setelah restart. Pembacaan ulang 200 ID membantu menangkap commit terlambat dalam jendela tersebut; keterlambatan atau gap lebih jauh **tidak dijamin tertangkap**.

- Sumber harus **append-only**: setiap pembacaan baru memiliki ID baru yang meningkat. Record identik yang terbaca ulang dilewati. Perubahan isi pada ID yang sudah disimpan, bila terdeteksi dalam jendela pembacaan ulang, dikarantina sebagai `ROW_CHANGED`; cache lama tidak ditimpa. Perubahan di luar jendela tidak dijamin terdeteksi.
- Identitas sumber mencakup host, port, dan nama database. Perubahan IP menjadi hostname dapat dianggap sumber baru meskipun database sama.
- Jangan mereset ID atau mengganti database di balik alamat yang sama tanpa prosedur. Hentikan worker, arsipkan cache, dan sepakati namespace/data baru; jangan menghapus cursor saat proses aktif.
- Baris yang tidak dapat diadaptasi, seperti DATETIME null, status di luar 0/1, atau waktu terlalu jauh ke depan, dicatat pada `source_rejections`. Cursor tetap maju melewatinya agar satu baris rusak tidak menahan semua sensor. Kegagalan satu tabel tidak menghentikan giliran tabel lain, khususnya MQ.
- Perbaikan baris yang belum pernah masuk cache mungkin terbaca lagi bila masih di jendela 200 ID, tetapi jangan mengandalkannya di luar jendela. Cara yang konsisten adalah memperbaiki penulis data dan menghasilkan pembacaan baru dengan ID baru. Rekonsiliasi arsip memerlukan prosedur terpisah.
- Error DHT berupa angka tidak valid menjadi record null/error jika bagian lain baris valid; ini berbeda dari penolakan seluruh baris karena ID/waktu/status tidak dapat dibaca.
- Sync bersifat eventual. Waktu sync terbaru bukan bukti perangkat online; lihat error sync dan waktu pengukuran masing-masing sensor. Data lama boleh tampil dengan label usang.
- Satu worker per mode dan direktori data. Lock proses mencegah dua worker menggunakan pekerjaan lokal yang sama.

Semua query ke MySQL adalah SELECT. SQLite menyimpan cache serta state aplikasi tambahan, tetapi tidak mengubah kepemilikan data sumber MySQL.

## 5. Browser 5 menit dan worker 5 detik

| Mekanisme | Interval | Kegunaan |
|---|---:|---|
| Dashboard | **300 detik / 5 menit** | Pembaruan otomatis tampilan; tombol Perbarui mengambil data segera |
| Worker | Jeda **5 detik setelah putaran selesai** | Sync MySQL dan pemrosesan email walaupun browser ditutup |
| Simulator v2 opsional | Jeda 5 detik setelah putaran | Menghasilkan sampel uji pada sumber API |

Email tidak menunggu refresh browser. Koneksi MySQL/SMTP lambat dapat memperpanjang putaran worker; lima detik bukan jaminan latensi pengiriman. Menutup terminal worker menghentikan sync/email. Menutup browser tidak menghentikan worker.

Default ambang data usang dan kontak online adalah 30 detik. Dengan refresh browser lima menit, indikator yang terlihat adalah hasil pada pembaruan terakhir; gunakan Perbarui ketika mendiagnosis. Sync sukses tanpa pengukuran baru tidak membuat sensor segar. Jangan mengganti angka lama dengan 0 saat jaringan gagal.

## 6. Email asap

### Mengatur pengiriman

Penerima awal `spcindonesia@spci.site` dibuat otomatis oleh `npm run migrate` dari `ALERT_RECIPIENTS` di `.env.local` (pisahkan dengan koma untuk beberapa alamat; jalankan migrate ulang per `APP_MODE`). Penerima lain didaftarkan atau dinonaktifkan pada **Pengaturan → Penerima peringatan asap** sebelum membentuk insiden uji. Isi SMTP melalui environment server, misalnya:

```dotenv
SMTP_HOST=smtp.internal.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_FROM=server-room@example.internal
SMTP_USER=AKUN_SMTP_LOKAL
SMTP_PASSWORD=ISI_LOKAL
```

Ganti contoh dengan konfigurasi pengelola email. `SMTP_SECURE=true` memakai TLS sejak koneksi dimulai; pada koneksi non-secure, `SMTP_REQUIRE_TLS=true` meminta STARTTLS. Sertifikat selalu diverifikasi. Auth digunakan bila `SMTP_USER` terisi. Restart worker setelah perubahan.

Label **Dikonfigurasi** berarti `SMTP_HOST` dan `SMTP_FROM` tersedia, belum membuktikan password/koneksi/inbox berhasil. Gunakan penerima uji yang disetujui sebelum demo smoke. Secret SMTP tidak dikirim ke browser maupun ESP32.

### Satu insiden, satu antrean per penerima

MQ live baru dan masih segar dengan status 1 membuka insiden. Status1 berulang selama insiden aktif tidak menghasilkan email berulang. MQ baru status 0 menutup insiden; deteksi 1 berikutnya dapat membuat insiden baru. Urutan 1→0 yang terbaca dalam satu batch tetap dicatat sebagai deteksi singkat.

Penerima aktif saat insiden dibentuk mendapatkan satu antrean. Batas unik `(incident_id, recipient_id)` dan state insiden disimpan pada SQLite sehingga deduplikasi bertahan setelah restart. Penerima yang ditambahkan sesudah insiden hanya berlaku untuk insiden berikutnya; tidak ada backfill alarm lama.

| Status | Arti |
|---|---|
| `pending` | Menunggu worker/SMTP; tanpa konfigurasi tidak diklaim sudah terkirim |
| `sending` | Worker sudah mengambil pekerjaan dan berkomunikasi dengan SMTP |
| `sent` | Server SMTP menerima pesan; tidak menjamin masuk inbox atau dibaca |
| `failed` | Kegagalan tertentu diketahui: auth, envelope, DNS, atau koneksi; tidak diulang otomatis |
| `unknown` | Hasil ambigu atau worker restart saat sending; mungkin sudah diterima SMTP, sehingga tidak dikirim ulang otomatis |
| `skipped` | Umur insiden lebih dari lima menit saat diproses atau penerima dinonaktifkan |

**Insiden yang sudah berakhir tetapi masih berumur kurang dari lima menit tetap diberitahukan**, agar deteksi asap singkat tidak hilang. Tanpa SMTP, pending dapat menjadi skipped setelah melewati batas umur; aplikasi tidak mengirim seluruh alarm lama saat konfigurasi baru dinyalakan.

Sesudah crash, sending dipindahkan menjadi unknown, bukan pending. Kebijakan ini menghindari duplikasi pada hasil SMTP yang tidak pasti, dengan konsekuensi operator perlu memeriksa server SMTP/inbox secara manual. Import arsip dan bootstrap tidak menghasilkan email lama. Pemberitahuan prototype ini bukan pengganti alarm kebakaran tersertifikasi.

## 7. Import arsip tanpa MySQL aktif

Gunakan mode simulation dan direktori data demo:

```powershell
npm.cmd run import:sql -- examples/iot_binus.sql
```

Importer membaca teks INSERT untuk tiga tabel. **Isi SQL dump tidak dieksekusi**; perintah penghapusan tabel/schema di dalam berkas tidak dijalankan. MySQL tidak ditulis atau dibutuhkan untuk langkah ini. Worker MySQL juga tidak perlu dihidupkan untuk melihat arsip.

Ke cache kosong, import contoh menghasilkan 69/69/69. Import ulang berkas identik menghasilkan duplicate tanpa menggandakan record. Namespace berasal dari hash seluruh berkas; jika isi dump berubah, namespace berubah. Jangan menggabungkan banyak versi dump lalu menganggap ID yang sama otomatis menjadi satu record.

Parser mendukung format dump Navicat yang disertakan: satu INSERT tanpa daftar kolom per record; DHT enam nilai, PIR/MQ empat nilai. Ini bukan importer SQL umum. Arsip tidak membuat perangkat online dan tidak memicu email. Gunakan data demo terpisah sebelum beralih ke MySQL live agar hitungan cache tidak tercampur.

## 8. API v2 hanya untuk jalur pengujian opsional

Set lingkungan demo menjadi `APP_MODE=simulation`, `DATA_SOURCE=api`, lalu restart server. API perangkat v2 menolak sumber MySQL dengan 409 `SOURCE_MISMATCH`. Jangan mengubah firmware Mas Togar ke API ini hanya karena contoh pengujian tersedia.

```powershell
npm.cmd run simulator -- --scenario=normal
# Hentikan proses sebelumnya dengan Ctrl+C.
npm.cmd run simulator -- --scenario=motion --once
npm.cmd run simulator -- --scenario=sensor-error --once
npm.cmd run simulator -- --scenario=smoke --once
```

Syntax memakai `--scenario=nama`. Normal mengirim angka DHT berubah dan contoh PIR; motion membuat PIR 1; smoke membuat MQ 1; sensor-error mengirim DHT null/null dengan error_code. `--once` berhenti sesudah satu putaran. Simulator memeriksa mode/source server; buffer retry memakai UUID/timestamp/payload asli tetapi hanya di memori, bukan antrean firmware tahan reset.

Ambang awal API uji adalah ON≥31°C dan OFF≤30°C. Simulator mengambil konfigurasi, menerapkan, lalu mengirim ACK. Nilai ini tidak otomatis mengubah kebijakan firmware pada jalur MySQL.

Base endpoint aplikasi ini adalah `/api/v2`:

| Metode/path | Fungsi |
|---|---|
| GET `/health` | Version, mode, dan sumber konfigurasi aplikasi |
| POST `/device/telemetry` | Satu sampel gabungan DHT/PIR/MQ, tiga record dalam transaksi |
| GET `/device/config` | Ambang kipas berversi untuk jalur API |
| POST `/device/config/ack` | Konfirmasi versi yang diterapkan |
| POST `/device/heartbeat` | Kontak perangkat; bukan ACK/sensor sehat |
| GET `/dashboard/summary`, `/history`, `/alerts`, `/recipients` | Pembacaan data dashboard |
| GET `/dashboard/session` | Cookie/token CSRF perubahan dashboard |
| POST `/dashboard/recipients` | Daftarkan/aktifkan penerima |
| DELETE `/dashboard/recipients/{id}` | Nonaktifkan penerima |
| PUT `/dashboard/settings` | Ubah ambang jalur API; ditolak pada sumber MySQL |

Header perangkat adalah `X-Device-ID` dan `X-API-Key` dari environment aplikasi, bukan key API Mas Togar. Request perangkat tidak memakai Origin. Mutasi dashboard membutuhkan Origin allowlist, cookie, dan token CSRF. Sukses dibungkus `data`; error berbentuk `{error:{code,message,details?},request_id}`.

Contoh body telemetry:

```json
{
  "sample_id": "da3c236b-a00b-4ede-8566-b9a9c9eb988b",
  "measured_at": "2026-10-26T07:00:00.000Z",
  "dht": { "suhu": 31.2, "kelembapan": 67, "status": 1, "error_code": null },
  "pir": { "status": 1, "lamp_on": null },
  "mq": { "status": 0 }
}
```

Gunakan waktu aktual dan UUID baru untuk sampel baru; retry memakai payload asli. UUID sama dengan isi berbeda ditolak 409. Waktu lebih dari 30 detik di masa depan ditolak. DHT error memerlukan dua nilai null dan error_code nonkosong. `lamp_on` opsional, hanya diisi bila pengirim memang mengetahui laporan output LED, bukan tebakan dari PIR.

## 9. Peta file dan fungsi

Komentar dalam source menjelaskan keputusan integrasi. Peta ini membantu menemukan bagian yang perlu dibaca tanpa mengubah schema asal secara tidak sengaja.

| File | Fungsi/bagian penting | Isi |
|---|---|---|
| `examples/iot_binus.sql` | Dump 69/tabel | Acuan format data, bukan SQL yang dieksekusi importer |
| `src/lib/legacy-adapter.ts` | `legacyTime`, `adaptLegacyRow`, `parseLegacyDump` | Waktu WIB, angka teks, semantik status, LED null, parser terbatas |
| `src/lib/mysql-sync.ts` | `mysqlPool`, `mysqlNamespace`, `syncMySql` | SELECT-only, bootstrap, ID cursor, penolakan baris, isolasi kegagalan tabel |
| `src/lib/monitoring-store.ts` | `saveRecords`, `summary`, `incidentList`, `state`/`setState` | Transaksi/deduplikasi, indikator, insiden, state sinkronisasi |
| `src/lib/mail-worker.ts` | `deliverPendingEmails`, `recoverSendingEmails` | Klaim pekerjaan, SMTP, status hasil, pemulihan tanpa duplikasi |
| `scripts/monitor-worker.ts` | Loop dan PID lock | Proses terpisah web, sync/email, shutdown normal |
| `src/lib/monitoring-api.ts` | `handleMonitoringApi` | API v2, validasi, pemisahan sumber, penerima, CSRF |
| `src/lib/monitoring-types.ts` | `SensorRecord`, `MonitorSummary`, `SmokeIncident` | Bentuk data backend/UI |
| `src/components/monitoring-dashboard.tsx` | Komponen dashboard | Refresh 300 detik, tampilan, filter, penerima, integrasi |
| `src/app/page.tsx` | `Page` | Memasang dashboard monitoring aktif |
| `src/app/api/v2/[...path]/route.ts` | Route handler | URL v2 menuju monitoring-api |
| `migrations/002_environment_monitoring.sql` | Tabel/index lokal | sensor_records, config/device, recipients, incidents, outbox, integration_state |
| `migrations/003_source_rejections.sql` | Karantina baris sumber | source_rejections berisi ID sumber, sensor, waktu penolakan, dan alasan; ringkasan menyertakan jumlah rejected_rows |
| `src/lib/db.ts` | `getDb`, `transaction` | SQLite sesuai mode, migrasi, WAL, transaksi |
| `scripts/setup.ts`, `scripts/migrate.ts` | Setup/migrasi | Secret baru tanpa overwrite; migrasi internal |
| `scripts/import-sql.ts` | Import arsip | Namespace hash, parse-only, simulation-only, tanpa email |
| `scripts/simulator-v2.ts` | Klien HTTP contoh | Empat skenario opsional, retry payload asli |
| `tests/monitoring.test.ts` | Suite monitoring | Mapping dump, validasi, histori, dedup, insiden, kontrak API |

Migrasi 002 menambah tabel tanpa menghapus histori September. `service.ts`, `contracts.ts`, `simulator-engine.ts`, `/api/v1`, `CONTRACT.md`, serta dokumen OpenAPI/integrasi/simulator lama adalah **versi sebelumnya**. Dokumen tersebut bukan kontrak API Mas Togar atau API v2 Oktober. Perintah lama tersedia sebagai `simulator:legacy`, `test:legacy`, dan `test:e2e:legacy`.

## 10. Checklist demo dan pengujian

1. Health/source benar: MySQL untuk sistem Mas Togar; API hanya saat demo alternatif.
2. Cocokkan beberapa ID, angka, status, dan waktu dari sumber dengan histori; tidak ada klaim PPM, jumlah orang, atau LED fisik yang belum dilaporkan.
3. Import 207 record dan import ulang tidak menggandakan; bootstrap tidak mengirim alarm lama.
4. API Mas Togar menulis ID baru; worker mengambilnya. Restart worker tidak menggandakan baris.
5. Browser refresh lima menit; tombol Perbarui segera. Worker/email tetap berjalan saat browser ditutup.
6. Daftarkan penerima sebelum insiden. MQ 1 berulang menghasilkan satu insiden/email per penerima; 0 menutup; 1 berikutnya insiden baru.
7. Tanpa SMTP tidak ada klaim sent. Unknown tidak dikirim ulang. Deteksi singkat 1→0 masih diberitahukan selama belum melewati lima menit.
8. Error MySQL/baris buruk terlihat; kegagalan DHT tidak menghalangi MQ. Data usang tetap dibedakan dari offline.
9. Histori, cursor, penerima, insiden, dan status email bertahan setelah restart.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Pemeriksaan awal revisi mencatat **14 tes unit monitoring dan build Next.js 16.4.3 lulus**. Pengujian tambahan serta E2E revisi dijalankan terpisah sesudah perubahan akhir; hasil versi September tidak otomatis berlaku untuk Oktober. Hasil unit/simulator tidak membuktikan koneksi MySQL Mas Togar live, email masuk inbox nyata, atau perangkat fisik berhasil.

## 11. Troubleshooting

| Gejala | Pemeriksaan/tindakan |
|---|---|
| npm.ps1 diblokir | Gunakan `npm.cmd`; tidak perlu mengubah execution policy global |
| Setup real tetapi tetap simulation | `.env.local` lama tidak ditimpa atau env terminal mengalahkan file; periksa folder/APP_MODE/DATA_DIR, lalu restart proses |
| MYSQL_NOT_CONFIGURED | Isi MYSQL_HOST dan MYSQL_USER di environment worker; setup tidak membuat akun MySQL |
| MySQL connection refused/timeout | Periksa server, host/port, jaringan/firewall. Localhost pada komputer berbeda menunjuk komputer sendiri |
| MySQL access denied | Cocokkan kredensial lokal dan hak SELECT; jangan mempublikasikan password untuk diagnosis |
| Tabel/kolom tidak cocok | Pastikan database iot_binus dan schema asli; jangan DROP/recreate database existing |
| Data tidak bertambah | Periksa worker/error/cursor dan apakah API menulis ID baru, bukan UPDATE ID lama |
| Ada baris ditolak | Baca alasan source_rejections dan jumlah rejected_rows; perbaiki penulis data dan buat pembacaan baru. Jendela ulang terbatas 200 ID; ROW_CHANGED tidak menimpa cache |
| Waktu bergeser tujuh jam | Cocokkan cara API menulis DATETIME dengan MYSQL_TIME_ZONE; jangan menebak atau mengubah data tanpa memeriksa sumber |
| Sync sukses tetapi data lama | Periksa create_date dan pembacaan baru; arsip bukan kontak aktif |
| UI belum berubah | Refresh otomatis lima menit; tekan Perbarui, lalu periksa worker. Jangan mencampur interval browser dengan loop worker |
| LED belum dilaporkan | Benar untuk SQL PIR tanpa feedback LED; target tidak membuktikan state fisik |
| Import tidak mengenali format | Parser terbatas pada dump contoh; jangan menjalankan dump sebagai workaround |
| Simulator 409 SOURCE_MISMATCH | Sumber MySQL aktif; gunakan lingkungan demo terpisah dengan DATA_SOURCE=api untuk API uji |
| Email pending | SMTP belum siap atau worker belum berjalan; pending lebih dari lima menit dapat skipped |
| Email failed | Periksa kode/detail auth, DNS, koneksi, dan envelope SMTP; status ini bukan sukses |
| Email unknown | Hasil SMTP ambigu; periksa server/inbox uji manual, jangan memaksa pengiriman ulang otomatis |
| Insiden tanpa penerima | Penerima ditambahkan setelah insiden atau semua nonaktif; berlaku untuk insiden berikutnya |
| Pengaturan fan ditolak pada MySQL | Tidak ada jalur balik; ubah ambang di firmware Mas Togar |
| Dashboard 403 Origin/CSRF | Sesuaikan skema/host/port ALLOWED_ORIGINS, restart, lalu muat ulang sesi; jangan mematikan CSRF |
| Worker lain masih berjalan | Hentikan proses lama normal; jangan menghapus lock milik proses aktif |

## 12. Jaringan, backup, dan batas bukti

Server default bind `127.0.0.1`. Akses tim memakai reverse proxy internal HTTPS atau listener LAN dengan firewall; sesuaikan Origin. CORS bukan pengganti kontrol jaringan. Dashboard tanpa login berarti semua pihak yang menjangkaunya dapat melihat data dan mengatur penerima dengan hak sama. Jangan expose ke internet publik.

Backup lokal: hentikan worker/server normal, salin seluruh direktori data termasuk SQLite/WAL yang masih ada, serta simpan environment dengan akses terbatas. Backup MySQL adalah proses terpisah milik pengelola database; cache web bukan backup sumber utama.

Panduan ini tidak mengklaim MySQL live, inbox nyata, wiring ESP32, DHT/PIR/MQ fisik, relay/LED/kipas telah teruji. Web tidak menentukan pinout, tegangan, polaritas relay, maupun firmware. Verifikasi bersama tim IoT memakai perangkat dan jaringan sebenarnya sebelum penggunaan di luar demonstrasi.

