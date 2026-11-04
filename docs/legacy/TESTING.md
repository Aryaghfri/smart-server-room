# Hasil pengujian

Tanggal verifikasi: **29 September 2026**, pembaruan laporan pukul **20:11 WIB**. Pengujian berlangsung lokal pada Windows dengan Node.js **22.18.0** dan Next.js **16.3.7**.

| Pemeriksaan | Hasil | Bukti yang dijalankan |
|---|---|---|
| Integrasi API dan SQLite | **16/16 lulus**, 0 gagal, 0 dilewati; 3,20 detik pada run terakhir | `node node_modules/tsx/dist/cli.mjs --test tests/api.test.ts` |
| Alur HTTP dengan server produksi dan simulator sebenarnya | **12/12 lulus**, dijalankan ulang setelah perubahan simulator terakhir | `node node_modules/tsx/dist/cli.mjs scripts/verify-e2e.ts` |
| Build produksi dan TypeScript | **Lulus** pada source akhir | `node node_modules/next/dist/bin/next build` |
| Browser desktop dan HP | **Lulus pemeriksaan manual** di browser Codex; viewport desktop 1894 px dan HP 390 × 844 px, tanpa overflow horizontal halaman | Navigasi lima halaman, kontrol, filter, validasi dan status gangguan |

Perintah pengguna yang setara adalah `npm test` dan, setelah `npm run build`, `npm run test:e2e`. Kedua suite memakai direktori SQLite sementara; pengujian tidak menghapus atau mengubah database demonstrasi/penggunaan nyata. Tes HTTP memilih port loopback sendiri, membuat secret sementara, menjalankan proses Next.js dan CLI simulator, kemudian menghentikan proses pengujiannya.

## Yang telah dibuktikan

Tes API menggunakan handler backend sebenarnya, validasi, autentikasi, migrasi, dan SQLite. Jam pengujian khusus `NODE_ENV=test` mempercepat pemeriksaan batas waktu tanpa menunggu puluhan detik.

- API key, Origin, cookie CSRF, dan header token diperiksa. Permintaan perubahan tanpa kombinasi yang benar ditolak. Input sensor, konfigurasi, tanggal, UUID, dan JSON yang tidak valid ditolak dengan envelope error yang konsisten.
- Retry akses, pembacaan sensor, command, receipt, dan hasil akhir tidak menggandakan aksi atau catatan. ID yang dipakai ulang dengan isi berbeda ditolak. Dua receipt bersamaan hanya memberikan satu izin eksekusi.
- Pembacaan dan heartbeat terlambat tetap masuk histori tanpa mengganti laporan terbaru. Grafik berisi maksimal 180 sampel, tetap berurutan, dan menyertakan sampel terakhir; pagination histori tetap berjalan.
- Offline, sensor gagal, dan data usang memiliki indikator terpisah. Kegagalan sensor menyimpan nilai `null`, sedangkan pembacaan valid terakhir tetap tersedia. GET polling tidak membuat perangkat online dan tidak menulis state bisnis ke SQLite.
- Hitungan hari ini serta filter tanggal memakai batas hari Asia/Jakarta, termasuk tepat pukul 00:00:00 WIB.
- Penyimpanan konfigurasi memakai versi optimistis. Heartbeat tidak dianggap sebagai ACK. Perintah kipas memerlukan mode manual dan konfigurasi yang sudah dikonfirmasi; penggantian konfigurasi membatalkan perintah kipas yang belum diterima.
- Command yang baru disimpan berstatus menunggu. Command kedaluwarsa tidak dapat diterima untuk dieksekusi. Receipt belum berarti berhasil. Konfirmasi hilang menjadi hasil belum diketahui; hasil valid yang datang terlambat dapat menyelesaikannya tanpa memberikan izin aktuasi ulang. Hasil gagal juga disimpan dan dideduplikasi.
- Respons dashboard/perangkat tidak memuat hash internal atau secret server. Audit menggunakan sumber `dashboard internal`, tanpa identitas operator rekaan.
- Catatan bertahan setelah koneksi database ditutup dan proses baru membacanya. Database real dan simulation terpisah.

Tes HTTP membuktikan rantai **simulator → API HTTP → SQLite → data dashboard → command → simulator → receipt/hasil → data dashboard** pada server hasil build produksi. CLI simulator yang sama dengan demonstrasi digunakan untuk akses dikenal tetapi ditolak, retry duplikat, konfigurasi/ACK, kipas manual ON/OFF, ambang otomatis, buka kunci selama satu detik lalu relock, expiry, sensor gagal, data terlambat, dan konfirmasi hilang. Server dihentikan dan dijalankan kembali untuk menguji persistensi. Mode real kemudian dijalankan pada direktori data yang sama dan menunjukkan histori terpisah yang kosong.

## Pemeriksaan browser

- Ringkasan menerima pembaruan sensor aktual dari simulator melalui polling, menampilkan grafik dan hitungan akses WIB.
- Tombol buka kunci menampilkan dialog konfirmasi. Setelah konfirmasi, command `8aa27908-8413-4e2b-82c6-0ccc803f4be0` tercatat di audit dan berubah menjadi **Berhasil** sesudah simulator mengirim hasil. Laporan kunci sempat terbuka lalu kembali terkunci.
- Pilihan manual menyimpan konfigurasi v2, kemudian tombol ON aktif setelah ACK. Command kipas `42f7c225-8bd6-48df-9bde-da2fa7ae50d4` berhasil dan laporan perangkat menunjukkan kipas menyala. Mode dikembalikan ke otomatis melalui konfigurasi v3.
- Sensor error dari API simulator menampilkan **Sensor gagal membaca**, pembacaan valid lama tetap tampil tanpa diganti nol. Setelah simulator berhenti lebih dari 30 detik, label **Perangkat offline** muncul terpisah.
- Menu navigasi HP terbuka dan menuju Pengaturan. Ambang OFF 31°C dengan ON 30°C memunculkan validasi dan menonaktifkan Simpan. Draft dibatalkan.
- Pencarian kosong, filter, tabel, dan halaman riwayat diperiksa. Semua waktu detail memakai WIB hingga detik.
- Pemeriksaan log browser pada build akhir tidak menemukan error atau warning. Semua font berasal dari komputer lokal; tidak memerlukan Google Fonts.

Bukti tampilan: [desktop](screenshots/dashboard.png), [HP](screenshots/mobile.png), [offline dan sensor gagal](screenshots/offline-sensor-error.png). Pemeriksaan ukuran adalah emulasi viewport browser, bukan pengujian pada perangkat HP fisik. Browser CLI awal tidak dapat membuka Edge di lingkungan ini; pemeriksaan dilanjutkan dengan browser dalam aplikasi Codex.

## Batasan hasil

- Tes HTTP memeriksa HTML awal dan data yang dikonsumsi dashboard; hasil itu sendiri bukan bukti bahwa seluruh interaksi atau tata letak browser sudah benar. Pemeriksaan browser dicatat terpisah di atas.
- Kamera/face recognition, ESP32, DHT22, relay, kipas, LED, dan solenoid fisik **belum diintegrasikan atau diuji**. Keberhasilan simulator tidak membuktikan keamanan listrik, posisi daun pintu, keberhasilan seseorang masuk, atau fail-safe fisik.
- PDF referensi tidak tersedia dalam lampiran sesi ini; implementasi mengikuti teks spesifikasi pengguna. Logo BINUS berupa teks karena aset resmi tidak tersedia.
- Strategi kipas ketika sensor gagal, keadaan saat listrik padam, sinkronisasi waktu perangkat, persistensi ledger, dan perilaku restart masih harus disepakati serta diuji bersama tim IoT. Setelah restart, firmware perlu mengambil dan menerapkan konfigurasi terkini sebelum mengonfirmasi versi atau menjalankan perintah yang bergantung pada konfigurasi.
- Pengujian ini sesuai skala satu perangkat/satu server untuk demonstrasi. Belum dilakukan uji beban jangka panjang, kerusakan media penyimpanan, pemulihan listrik, atau penetration test. Dashboard tanpa login harus tetap dibatasi pada jaringan internal sesuai panduan instalasi.
