# Instalasi dan operasi jaringan internal

## 1. Persiapan dan environment

Pasang Node.js ≥22.18.0 dan npm. Jalankan perintah dari direktori proyek, karena `.env.local`, direktori migrasi, dan path data relatif dibaca dari direktori tersebut.

```powershell
npm install
npm run setup -- --mode simulation
npm run migrate
npm run build
npm run start
```

`npm run setup` menghasilkan API key perangkat dan secret CSRF secara acak. `setup` tidak menimpa `.env.local`; mengganti `--mode` pada eksekusi berikutnya tidak otomatis mengganti mode berkas lama. Periksa `APP_MODE` secara eksplisit. Secret hanya berada di server/perangkat, tidak memakai awalan `NEXT_PUBLIC_`, tidak ditampilkan oleh dashboard, dan tidak disimpan dalam repository.

| Variabel | Default contoh | Fungsi |
|---|---|---|
| `APP_MODE` | `simulation` | `simulation` atau `real`; menentukan berkas database dan label UI |
| `DATA_DIR` | `./data` | Direktori disk persisten; jangan di direktori temporary atau network share |
| `DEVICE_ID` | `kelapa-esp32-01` | Satu ID pengendali; mengganti ID memerlukan direktori data baru |
| `DEVICE_API_KEY` | kosong | Diisi setup; minimal 32 karakter, rahasia server/perangkat |
| `CSRF_SECRET` | kosong | Diisi setup; minimal 32 karakter, rahasia server |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Origin dashboard yang diizinkan, dipisahkan koma; sertakan skema dan port |
| `BASE_URL` | `http://127.0.0.1:3000` | Origin server untuk simulator; tanpa path |
| `SENSOR_INTERVAL_SECONDS` | `10` | Interval sensor simulator; informasi bagi dashboard |
| `HEARTBEAT_INTERVAL_SECONDS` | `10` | Interval heartbeat simulator |
| `COMMAND_POLL_SECONDS` | `2` | Interval mengambil perintah |
| `DASHBOARD_POLL_SECONDS` | `5` | Interval pembaruan dashboard |
| `OFFLINE_AFTER_SECONDS` | `30` | Ambang tidak ada komunikasi POST perangkat yang valid |
| `SENSOR_STALE_SECONDS` | `30` | Ambang usia pengukuran valid terakhir |
| `UNLOCK_TTL_SECONDS` | `10` | Masa berlaku perintah sejak dibuat |
| `RESULT_GRACE_SECONDS` | `30` | Tambahan waktu menunggu hasil setelah TTL dan durasi aktuasi |

Interval server adalah bilangan bulat 1..3600 detik. Interval penerapan konfigurasi simulator default 10 detik; ubah dengan `--config-seconds` atau variabel opsional `CONFIG_POLL_SECONDS`. Ambang kipas/mode/durasi buka adalah konfigurasi berversi dalam database, bukan nilai environment. Default pertama: ON ≥30°C, OFF ≤28°C, otomatis, buka 5 detik.

## 2. Akses jaringan internal

Default `dev` dan `start` bind ke `127.0.0.1`. Pilihan yang disarankan untuk demonstrasi pada satu laptop adalah tetap memakai localhost. Untuk perangkat IoT dan laptop lain, gunakan reverse proxy internal dengan HTTPS ke `127.0.0.1:3000`; batasi alamat asal di firewall dan reverse proxy. Jangan port-forward router ke internet.

Contoh Nginx di server internal; sesuaikan subnet, DNS internal, dan path sertifikat dengan jaringan sebenarnya:

```nginx
server {
    listen 443 ssl;
    server_name server-room.internal;
    ssl_certificate     /etc/nginx/tls/server-room.crt;
    ssl_certificate_key /etc/nginx/tls/server-room.key;

    allow 127.0.0.1;
    allow 192.168.10.0/24;
    deny all;
    client_max_body_size 16k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 15s;
    }
}
```

Set `ALLOWED_ORIGINS=https://server-room.internal` dan `BASE_URL=https://server-room.internal`. Restart server setelah perubahan environment. Sertifikat harus dipercaya komputer dan perangkat; jangan mematikan validasi TLS. Jangan menambahkan header CORS `*` untuk mencoba memperbaiki akses perangkat: perangkat memakai HTTP langsung, sementara dashboard memakai origin yang sama.

Untuk LAN demo tanpa proxy, jalankan Next secara eksplisit:

```powershell
npx next start --hostname 0.0.0.0 --port 3000
```

Batasi firewall OS ke subnet/IP perangkat dan penguji, misalnya rule inbound TCP 3000 hanya dari subnet lab. Tambahkan origin yang benar, misalnya `http://192.168.10.20:3000`, ke `ALLOWED_ORIGINS`; `BASE_URL` juga mengarah ke IP tersebut untuk simulator di komputer lain. HTTP LAN mengirim data dan API key tanpa enkripsi; gunakan hanya jaringan demonstrasi tepercaya. Pada HTTPS, cookie CSRF menggunakan atribut Secure; pada HTTP lokal atribut itu tidak digunakan.

**Tidak ada autentikasi dashboard.** Siapa pun yang lolos batas jaringan bisa membuat token CSRF sendiri dan melakukan kontrol. CSRF menghalangi request lintas situs, bukan menetapkan hak operator. API key perangkat juga tidak memberikan autentikasi operator. Jangan membuka dashboard melalui tunnel publik atau hosting internet.

## 3. Database, migrasi, dan pemisahan mode

- `APP_MODE=simulation` memakai `DATA_DIR/simulation.sqlite`.
- `APP_MODE=real` memakai `DATA_DIR/real.sqlite`.
- Metadata mode dan device ID diperiksa saat database dibuka. Mengganti nama berkas simulasi menjadi `real.sqlite` akan ditolak oleh penanda mode.
- Simulator menolak environment `APP_MODE=real` dan memeriksa `/api/v1/health` sebelum mengirim data.
- Gunakan salinan konfigurasi dan `DATA_DIR` berbeda untuk lingkungan hardware; gunakan API key berbeda. Jangan menyalin database demo menjadi basis data nyata.

Migrasi SQL berurutan ada di `migrations/`, dengan versi dalam `schema_migrations`. `npm run migrate` menerapkan migrasi dalam transaksi. Startup API juga memastikan migrasi tersedia. SQLite menggunakan WAL, foreign key, `synchronous=FULL`, dan busy timeout 5 detik. Jalankan satu instance aplikasi; SQLite file bukan database terdistribusi.

Untuk backup sederhana: hentikan simulator, hentikan server dengan normal, lalu salin **seluruh direktori data**, termasuk berkas `.sqlite`, `-wal`, `-shm` yang masih ada, dan ledger simulator. Simpan `.env.local` secara terpisah dengan akses terbatas. Pulihkan ke mesin/mode/perangkat yang sesuai dan jalankan migrasi sebelum start. Jangan menyalin hanya `.sqlite` ketika server masih menulis.

Untuk reset demo, hentikan seluruh proses dan arsipkan direktori data lama; pilih `DATA_DIR` baru. Jangan menghapus ledger simulator untuk memaksa perintah yang hasilnya belum diketahui dijalankan ulang. Database tidak mempunyai retensi otomatis; pantau kapasitas disk dan arsipkan berdasarkan kebutuhan lab.

## 4. Operasi dan batas kapasitas

Jalankan server dengan pengelola proses OS agar restart terkontrol; proses tunggal sudah memadai untuk satu perangkat dengan interval default. Error API membawa `request_id` untuk pelacakan. Aktivitas operator dicatat sebagai `dashboard internal` tanpa identitas rekaan. Aplikasi ini belum mempunyai log terpusat, alert, high availability, atau monitoring infrastruktur.

Kegagalan server/jaringan tidak boleh menghentikan logika kipas atau timer kunci pada firmware. Database disk penuh, izin file, mati listrik, clock perangkat, reconnect, relay, serta posisi kunci fisik tetap perlu diuji di perangkat nyata. Restart server tidak menjadikan perintah yang belum dikonfirmasi otomatis berhasil.
