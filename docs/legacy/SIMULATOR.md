# Simulator perangkat

Simulator mengirim HTTP ke API sebenarnya, tanpa menulis langsung ke SQLite atau mengisi data statis dalam UI. CLI membaca `.env.local`; `APP_MODE` dan health server harus sama-sama `simulation`. API key tidak dicetak.

```powershell
npm run simulator -- --help
npm run simulator -- --scenario normal
npm run simulator -- --once --access known-denied
```

## Skenario

| Opsi `--scenario` | Perilaku yang benar-benar dilakukan |
|---|---|
| `normal` | Sensor berubah bertahap sekitar 26,5–32,5°C dan 44–58%; heartbeat, konfigurasi, perintah, dan contoh akses berjalan periodik |
| `offline` | Satu putaran terhubung, lalu seluruh transport dihentikan 45 detik; sensor, keputusan kipas, dan relock tetap lokal. Setelah itu pulih dan mengirim buffer dengan timestamp asli. Ubah `--offline-seconds`; tidak mendukung `--once` |
| `sensor-error` | Mengirim `status:error`, dua nilai sensor `null`, `error_code:DHT22_READ_FAILED`; heartbeat tetap berjalan. Mode otomatis menyalakan kipas sebagai asumsi fail-safe simulator |
| `duplicate` | Setiap payload telemetry dikirim dua kali dengan UUID dan isi identik; histori dan hitungan tidak bertambah dua kali |
| `late` | Setiap sensor terbaru disusul sensor valid lain yang waktunya 5 menit lebih lama; sampel lama masuk histori tetapi tidak menggantikan ringkasan terbaru |
| `lost-confirmation` | Menerima perintah dan menjalankan aktuator simulasi satu kali, tetapi tidak pernah mengirim hasil untuk perintah tersebut. Pengecualian tersimpan dalam ledger dan tetap berlaku setelah restart. Server akan menampilkan hasil belum diketahui setelah tenggat hasil |

Pilihan `--access cycle|allowed|known-denied|unknown-denied` membedakan pengenalan dan izin. `cycle` (default) bergiliran: Operator Simulasi dikenal dan berizin, Tamu Simulasi dikenal tetapi ditolak, kemudian wajah tidak dikenal dan ditolak. Contoh akses setiap 30 detik. Akses diizinkan juga membuka kunci secara lokal selama durasi konfigurasi. Gunakan **`--access known-denied` untuk demo tombol buka manual** agar tidak bertepatan dengan pembukaan akses lokal. Bila kunci sudah terbuka, perintah unlock baru dilaporkan gagal dan tidak memperpanjang timer.

`--once` melakukan sinkronisasi konfigurasi, satu putaran data/heartbeat/akses, dan polling perintah, kemudian menunggu timer buka lokal selesai sebelum keluar. Sesudah perintah dan relock, simulator mengirim heartbeat baru agar status dashboard mengikuti hasil. Gunakan mode kontinu untuk melihat perubahan grafik. Perintah manual harus sudah ada sebelum polling sekali; pada mode kontinu bisa dibuat kapan pun.

## Interval dan retry

| Opsi | Default | Batas |
|---|---:|---|
| `--sensor-seconds` | 10 | 1..3600 |
| `--heartbeat-seconds` | 10 | 1..3600 |
| `--command-seconds` | 2 | 1..3600 |
| `--config-seconds` | 10 | 1..3600 |
| `--access-seconds` | 30 | 1..86400 |
| `--offline-seconds` | 45 | 1..86400 |
| `--timeout-ms` | 3000 | 100..30000 |
| `--retries` | 2 | 0..3 tambahan |

Scheduler HTTP tunggal mencegah request jaringan tumpang tindih. Akuisisi sensor dan timer aktuator lokal terpisah dari penantian HTTP. Retry jaringan/5xx memakai ID dan payload yang sama, timeout 3 detik per attempt, jeda 250 lalu 500 ms, maksimal 3 attempt per panggilan default. Sesudah habis, loop berikutnya dapat mencoba komunikasi lagi. Respons 429 menunda seluruh transport sesuai Retry-After (default 60 detik), tanpa menghentikan kontrol lokal; 429 saat startup/--once menghentikan proses agar pemanggil menjadwalkan ulang. Error 4xx lainnya tidak diulang secara otomatis dalam satu panggilan. Data yang ditolak permanen dibuang dengan pesan error; data tidak diubah agar seolah-olah berhasil.

Buffer telemetry dalam memori maksimal 200 payload; yang tertua dibuang jika penuh. Buffer ini hilang saat proses berhenti. Ledger perintah berbeda: tersimpan di disk, tidak dibuang. Simulator bukan solusi antrean offline permanen untuk deployment hardware. Perangkat perlu menyepakati kapasitas antrean, retensi, dan kebijakan kehilangan data dengan tim IoT.

## Ledger dan kontrol lokal

State disimpan di `DATA_DIR/simulator-<DEVICE_ID>.json` (atau `--state`). Berkas `.lock` mencegah dua simulator perangkat sama berjalan bersamaan. Penulisan state memakai temporary file, flush ke disk, lalu rename. Disk/izin gagal menyebabkan simulator berhenti, bukan menjalankan aktuator tanpa ledger.

Urutan aman:

1. Simpan ID perintah sebagai `claimed` **sebelum** request receipt.
2. Hanya jalankan bila respons receipt pertama membawa `execute_allowed:true` dan TTL belum habis.
3. Simpan fase `executing` sebelum perubahan aktuator. Catat timestamp eksekusi, hasil, dan state ke disk.
4. Kirim hasil yang tersimpan. Retry hanya pengiriman hasil, tidak pernah aktuator.
5. Bila crash/receipt response hilang sebelum hasil diketahui, entri tetap `uncertain`; tidak dijalankan lagi. Tidak membuat hasil sukses rekaan.

Pada restart, simulator mengasumsikan kunci terkunci; kipas otomatis mulai ON sebagai posisi konservatif, sedangkan kipas manual mempertahankan state yang tersimpan. Mode dan ambang diambil dari konfigurasi terakhir, kemudian disinkronkan ke server. Dalam mode otomatis, sampel valid baru menerapkan hysteresis: ON saat ≥ambang ON, OFF saat ≤ambang OFF, pertahankan posisi di antaranya. Sensor gagal membuat kipas ON. Dalam mode manual, kegagalan sensor tidak mengambil alih perintah operator; setelah restart state kipas manual terakhir dipulihkan. Berpindah kembali ke otomatis langsung mengevaluasi sampel lokal terakhir.

Timer relock tetap berjalan ketika transport putus selama proses simulator hidup. Stop normal mengasumsikan kunci kembali locked. **Ini asumsi simulasi, bukan jaminan relay/kunci fisik.** Firmware harus menetapkan posisi output saat boot, watchdog, perilaku kehilangan daya, durasi timer lokal, penyimpanan ledger yang tahan reset, deteksi sensor gagal, dan arti laporan hardware. Relock setelah process kill/mati listrik tidak bisa dibuktikan oleh simulator.

Jangan menghapus ledger untuk “mencoba lagi” perintah unknown. Operator perlu memeriksa keadaan perangkat, kemudian membuat aksi baru secara sadar jika masih diperlukan. Perintah kedaluwarsa tidak diambil/diterima untuk dieksekusi setelah koneksi pulih.

