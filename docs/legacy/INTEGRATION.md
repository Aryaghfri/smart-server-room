# Panduan integrasi tim IoT

Base URL contoh lokal: `http://127.0.0.1:3000/api/v1`. Kontrak mesin lengkap ada di [`openapi.json`](openapi.json). Nama properti JSON tetap berbahasa Inggris untuk konsistensi firmware; UI berbahasa Indonesia. Satu instalasi menerima satu `DEVICE_ID`.

## Autentikasi dan bentuk respons

Setiap endpoint `/device/*` memerlukan `X-Device-ID` dan `X-API-Key` dari environment perangkat/server. Gunakan klien HTTP perangkat, tanpa header `Origin`: permintaan browser ke endpoint perangkat ditolak. Secret tidak boleh diletakkan pada JavaScript frontend, gambar, repository, atau log.

Semua request POST/PUT memakai `Content-Type: application/json`, maksimal 16 KiB, dan properti tak dikenal ditolak. Sukses:

```json
{"data":{"reading_id":"70eb06c2-444c-44b1-a1ce-6d6c68430ca5","duplicate":false}}
```

Error:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Payload atau parameter tidak valid.","details":[{"path":"humidity_percent","message":"Nilai di luar rentang."}]},"request_id":"95210317-14cd-44ab-ad67-3c488f303a18"}
```

`request_id` untuk menelusuri kegagalan server; detail validasi berupa array field/message. Error tidak mengandung secret. Status umum:

| HTTP | Makna |
|---|---|
| 200 | Baca/aksi sukses; retry telemetry atau command yang sudah tersimpan |
| 201 | Telemetry atau command baru dibuat |
| 400 | JSON rusak atau body tidak tersedia |
| 401 | ID/API key perangkat tidak valid |
| 403 | Origin perangkat/browser tidak sesuai; Origin/CSRF dashboard ditolak |
| 404 | Endpoint, metode, atau ID command tidak ditemukan |
| 409 | ID/payload konflik, versi konfigurasi usang, receipt belum ada, mode/konfigurasi tidak sesuai, atau perintah sejenis masih aktif |
| 410 | Perintah kedaluwarsa; jangan jalankan aktuator |
| 413 | Body lebih dari 16 KiB |
| 415 | Content-Type bukan application/json |
| 422 | Validasi field/rentang/waktu gagal |
| 429 | Pembatasan request; header `Retry-After: 60` |
| 500/503 | Server gagal atau secret belum dikonfigurasi |

Rate limiter sederhana per proses: endpoint perangkat berbagi 240 request/menit untuk satu device, perubahan dashboard 120/menit. Tidak menggantikan pembatasan reverse proxy. Untuk firmware, hentikan burst/retry ketika 429; tunggu sesuai Retry-After dan beri jitter. Timeout normal 3 detik, maksimal dua retry tambahan dengan payload/ID yang sama. Jangan membuat loop request paralel tanpa batas. Simulator memiliki batas retry per panggilan; koneksi pulih dicoba lagi dalam loop periodik.

## Urutan integrasi

1. Sinkronkan jam UTC perangkat (misalnya NTP pada jaringan yang tersedia). Tetapkan state output boot yang disepakati tim hardware.
2. `GET /device/config`, simpan versi serta konfigurasi lokal, lalu terapkan nilai.
3. `POST /device/config/ack` setelah penerapan benar-benar selesai. Heartbeat yang menyebut versi **tidak** menggantikan ACK.
4. Ambil sensor setiap 10 detik dan kirim `/device/readings`, termasuk status gagal. Jalankan kipas otomatis secara lokal, tidak menunggu web.
5. Kirim `/device/heartbeat` setiap 10 detik berisi state aktuator yang dilaporkan perangkat. Kirim `/device/access-events` hanya ketika ada keputusan akses.
6. Poll `/device/commands` setiap 2 detik; terapkan prosedur receipt/ledger/result di bawah. Poll konfigurasi setiap 10 detik.

GET hanya membaca state bisnis, tidak menandai perangkat online, tidak mengakui konfigurasi, dan tidak menerima/menjalankan command. Komunikasi valid untuk status online adalah POST perangkat yang sukses, termasuk retry identik. Heartbeat bukan bukti sensor valid. Kondisi online, sensor gagal, dan data usang adalah indikator terpisah.

## Endpoint perangkat

| Metode/path | Field request | Respons `data` |
|---|---|---|
| POST `/device/access-events` | `event_id` UUID, `occurred_at` datetime, `recognition` known/unknown, `decision` allowed/denied; opsional nullable `person_id`, `person_name`, `reason` | `{event_id,duplicate}` |
| POST `/device/readings` | `reading_id` UUID, `measured_at`, `status` ok/error, `temperature_c`, `humidity_percent`; `error_code` sesuai status | `{reading_id,duplicate}` |
| POST `/device/heartbeat` | `heartbeat_id` UUID, `reported_at`, `lock_state` locked/unlocked/unknown, `fan_on` boolean, `fan_mode` automatic/manual, `applied_config_version` integer ≥0 | `{heartbeat_id,duplicate}` |
| GET `/device/config` | tidak ada body | `{version,fan_on_c,fan_off_c,fan_mode,unlock_duration_seconds,updated_at}` |
| POST `/device/config/ack` | `version` integer ≥1, tidak melebihi versi terbit | `{applied_config_version}` |
| GET `/device/commands` | tidak ada body | Array maksimum 50 command pending/received yang belum lewat TTL |
| POST `/device/commands/{command_id}/receipt` | `{}` | `{command,execute_allowed}` |
| POST `/device/commands/{command_id}/result` | `status` succeeded/failed, `executed_at`; opsional `message` maksimal 500 karakter | Command final |

ID/nama orang opsional maksimal 160 karakter; jika dikirim sebagai string, tidak boleh kosong setelah trim. `reason` maksimal 500 karakter. Hasil pengenalan terpisah dari izin: dikenal bisa ditolak. Jika identitas tidak tersedia, kirim null atau hilangkan properti; UI menampilkan “Tidak dikenal”. Jangan mengisi nama orang yang tidak diketahui.

`status:ok` mensyaratkan suhu angka −40..80°C, kelembapan angka 0..100%, dan `error_code:null`/tidak disertakan. `status:error` mensyaratkan **kedua nilai null** dan `error_code` nonkosong maksimal 160 karakter. Sensor gagal tidak pernah direkam sebagai 0. Nilai numeric tetap boleh desimal.

Semua timestamp menerima ISO 8601 dengan zona waktu, dinormalisasi ke UTC `Z`. Waktu lebih dari 30 detik di masa depan ditolak. Waktu lama diterima dan tetap memakai waktu kejadian/pengukuran, bukan waktu penerimaan. `received_at` diisi server. Web menampilkan Asia/Jakarta hingga detik; “hari ini” adalah `[00:00 WIB, 00:00 WIB hari berikutnya)`, sama dengan 17:00 UTC hari sebelumnya sampai 17:00 UTC hari berjalan.

## Deduplikasi, urutan, dan konfigurasi

Untuk retry, simpan UUID dan **payload asli** sampai pengiriman berhasil; jangan mengganti timestamp atau membuat UUID baru. ID sama dan payload sama menghasilkan 200 `duplicate:true`; isi berbeda menghasilkan 409 `ID_CONFLICT`. Server memilih ringkasan berdasarkan waktu pengukuran/laporan terbaru sehingga data terlambat tidak menimpa status baru. Retry valid memperbarui last_contact, tetapi tidak menyegarkan waktu pengukuran sensor.

Konfigurasi dashboard memakai versi optimistis: PUT membawa `expected_version`. Dua operator/tab menyimpan versi sama: satu berhasil, yang berikutnya mendapat 409 `CONFIG_CONFLICT` dan harus memuat ulang. Ambang OFF harus lebih kecil dari ON; ON −39..80°C, OFF −40..79°C; durasi buka integer 1..30 detik. Setiap simpan menghasilkan versi baru. ACK lama tidak menurunkan versi yang sudah dikonfirmasi. UI membedakan versi server dari versi ACK perangkat.

Saat mode otomatis, ambang diterapkan **di perangkat**. Jika suhu berada di antara ON/OFF, status sebelumnya dipertahankan. Mode manual mempertahankan perintah operator sampai kembali otomatis. Simulator memilih kipas ON pada sensor gagal dalam mode otomatis; perangkat nyata perlu menyetujui kebijakan ini, output boot, watchdog, dan proteksi listrik. Mode manual tidak diam-diam diganti menjadi otomatis ketika sensor gagal.

## Protokol perintah: receipt bukan sukses

Command berisi `command_id`, `device_id`, `type` unlock/set_fan, `duration_seconds` atau `fan_on`, `config_version`, `created_at`, `expires_at`, `result_deadline`, `received_at`, `completed_at`, `status`, `message`, dan `source:"dashboard internal"`. `completed_at` adalah waktu server menerima hasil. Timestamp mulai aktuasi dikirim sebagai `executed_at` dalam result.

```text
pending --receipt pertama--> received --hasil--> succeeded / failed
pending --lewat TTL--------> expired
received --lewat tenggat--> unknown --hasil terlambat valid--> succeeded / failed
```

Status kedaluwarsa/unknown dihitung ketika membaca, tanpa perubahan state melalui GET. Pending `set_fan` dari versi konfigurasi yang sudah diganti juga menjadi expired. Result deadline = expires_at + durasi buka (0 untuk kipas) + RESULT_GRACE_SECONDS. Dengan default unlock: dibuat +10 detik TTL +5 detik durasi +30 detik grace. Hilang konfirmasi **tidak** berarti sukses. Server masih menerima hasil terlambat bila timestamp mulai eksekusi berada antara created_at dan expires_at serta receipt sudah tercatat.

Perangkat wajib menyimpan ledger persisten dengan prosedur berikut:

1. Catat UUID sebagai diklaim sebelum meminta receipt. Tolak UUID yang pernah diklaim/dieksekusi pada reboot/retry.
2. POST receipt dengan `{}`. **Hanya respons receipt pertama** bisa memberi `execute_allowed:true`. Respons ulang memberi false. Bila respons pertama hilang, retry tidak boleh menjalankan aktuator; pilih ketidakpastian daripada membuka dua kali.
3. Periksa TTL lokal lagi sesaat sebelum aktuasi. Persist fase akan mengeksekusi sebelum menyentuh relay.
4. Untuk unlock, buka selama `duration_seconds`, lalu kunci kembali dengan timer lokal walaupun internet/server mati. Command bukan toggle.
5. Simpan hasil dan timestamp mulai eksekusi, lalu POST result. Retry hasil memakai payload sama, tidak mengulang relay. Hasil final berbeda ditolak `RESULT_CONFLICT`.

Receipt `set_fan` membutuhkan versi konfigurasi yang sudah di-ACK cocok dengan command; jika belum, server memberi 409 `CONFIG_NOT_APPLIED`. Selalu sync konfigurasi sebelum polling perintah. Simulator menunggu versi konfigurasi lokal cocok sebelum receipt. Respons 409 CONFIG_NOT_APPLIED memastikan receipt belum diterima sehingga boleh dicoba setelah ACK; receipt lain yang gagal/ambigu tidak dieksekusi ulang dan akhirnya expired/unknown. GET command hanya mengembalikan yang belum lewat TTL, sehingga perangkat harus mengirim ulang result yang sudah tersimpan dari ledger meskipun command tidak lagi muncul dalam polling.

Dashboard menggunakan command UUID yang sama untuk retry penyimpanan; tidak otomatis membuat ulang unlock. Perintah sejenis pending/received membatasi perintah baru (`COMMAND_IN_FLIGHT`). Setelah unknown/expired, operator masih bisa membuat aksi baru secara sadar setelah memeriksa state; itu UUID baru, bukan retry aktuator lama.

## Contoh curl (Bash/Git Bash)

Jangan menempel API key asli ke dokumentasi. Ambil key dari `.env.local` melalui mekanisme aman di komputer Anda. Contoh variabel berikut adalah placeholder; semua timestamp dan UUID untuk data baru harus dibuat saat menjalankan contoh.

```bash
BASE='http://127.0.0.1:3000/api/v1'
DEVICE='kelapa-esp32-01'
read -r -s -p 'API key perangkat: ' KEY; echo
NOW=$(node -p 'new Date().toISOString()')
ID=$(node -p 'require("node:crypto").randomUUID()')

curl -sS "$BASE/device/config" -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY"
curl -sS "$BASE/device/config/ack" -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"version":1}'

curl -sS "$BASE/device/readings" -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"reading_id\":\"$ID\",\"measured_at\":\"$NOW\",\"status\":\"ok\",\"temperature_c\":30.2,\"humidity_percent\":54.1,\"error_code\":null}"
```

Ulangi command curl terakhir tanpa mengganti ID/isi untuk memperoleh `duplicate:true`. Untuk error sensor gunakan UUID baru, timestamp baru, `status:"error"`, `temperature_c:null`, `humidity_percent:null`, `error_code:"DHT22_READ_FAILED"`. Versi ACK harus versi yang benar-benar dibaca dan diterapkan; `1` pada contoh hanya untuk database awal.

```bash
EVENT_ID=$(node -p 'require("node:crypto").randomUUID()')
NOW=$(node -p 'new Date().toISOString()')
curl -sS "$BASE/device/access-events" -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"event_id\":\"$EVENT_ID\",\"occurred_at\":\"$NOW\",\"person_id\":\"KLP-002\",\"person_name\":\"Tamu Simulasi\",\"recognition\":\"known\",\"decision\":\"denied\",\"reason\":\"Tidak memiliki izin ruang server\"}"

HB_ID=$(node -p 'require("node:crypto").randomUUID()')
NOW=$(node -p 'new Date().toISOString()')
curl -sS "$BASE/device/heartbeat" -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"heartbeat_id\":\"$HB_ID\",\"reported_at\":\"$NOW\",\"lock_state\":\"locked\",\"fan_on\":true,\"fan_mode\":\"automatic\",\"applied_config_version\":1}"
curl -sS "$BASE/device/commands" -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY"
```

Untuk mengikuti command tertentu, isi UUID dari hasil polling, persist ledger, dan jalankan receipt:

```bash
COMMAND_ID='UUID_DARI_POLLING'
curl -sS "$BASE/device/commands/$COMMAND_ID/receipt" \
  -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}'
# Periksa execute_allowed dan expires_at. Hanya perangkat yang benar-benar mengeksekusi
# boleh mengirim succeeded; curl tidak menggerakkan relay.
EXECUTED_AT=$(node -p 'new Date().toISOString()')
curl -sS "$BASE/device/commands/$COMMAND_ID/result" \
  -H "X-Device-ID: $DEVICE" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"status\":\"failed\",\"executed_at\":\"$EXECUTED_AT\",\"message\":\"Contoh pengujian: relay tidak terhubung\"}"
```

Jalankan result selama timestamp eksekusi masih masuk TTL; contoh curl bukan firmware dan tidak boleh dipakai untuk mengklaim aktuasi hardware berhasil.

## API dashboard dan CSRF

Endpoint baca: `GET /dashboard/summary`, `/access-events`, `/environment`, `/commands`, `/config`, `/audit`. Semua tidak memerlukan akun. Riwayat memakai `page` ≥1 maksimal 100000 dan `page_size` 1..100. Access menerima `q` maksimal 160 karakter, `decision` allowed/denied, `from`/`to` tanggal inklusif WIB. Environment menerima `hours` integer 1..168; grafik disampling, tabel tetap dipaginasi. Endpoint detail dan schema hasil ada di OpenAPI.

Untuk perubahan dashboard, ambil `/dashboard/session` agar cookie HttpOnly SameSite=Strict tersimpan dan dapatkan `data.csrf_token`. Kirim cookie, `X-CSRF-Token`, dan `Origin` persis dalam allowlist. Browser menambahkan Origin secara otomatis. POST `/dashboard/commands` menerima `{command_id,type:"unlock"}` atau `{command_id,type:"set_fan",fan_on:boolean}`. PUT `/dashboard/config` menerima semua nilai konfigurasi dan `expected_version`.

Contoh berikut **membuat perintah unlock pada server**; lakukan hanya pada MODE SIMULASI yang sedang diuji. Membuat request tidak sama dengan eksekusi berhasil:

```bash
ORIGIN='http://127.0.0.1:3000'
SESSION=$(curl -sS -c cookies.txt "$BASE/dashboard/session")
TOKEN=$(printf '%s' "$SESSION" | node -e 'let x="";process.stdin.on("data",d=>x+=d).on("end",()=>console.log(JSON.parse(x).data.csrf_token))')
COMMAND_ID=$(node -p 'require("node:crypto").randomUUID()')
curl -sS -b cookies.txt "$BASE/dashboard/commands" -H "Origin: $ORIGIN" \
  -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"command_id\":\"$COMMAND_ID\",\"type\":\"unlock\"}"
```

Hapus berkas cookie pengujian setelah selesai dan jangan commit. Perlindungan ini bukan login; setiap orang yang dapat mengakses jaringan dashboard mempunyai kemampuan kontrol sama. CORS bukan kontrol jaringan. Ikuti [panduan instalasi](INSTALLATION.md).

