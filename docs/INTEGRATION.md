# Intégrasi — revisi Oktober 2026

Panduan integrasi aktif adalah **[PANDUAN-TOGAR.md](PANDUAN-TOGAR.md)**. Jalur utama:

```text
Perangkat → API Mas Togar yang sudah ada → MySQL iot_binus
                                           ↓ SELECT worker
                                     cache lokal → web
                                           ↓
                                      antrean SMTP
```

API Mas Togar tetap digunakan. URL/auth/payload API itu mengikuti implementasi Mas Togar; OpenAPI aplikasi web ini tidak menggantikannya.

- [Panduan Mas Togar](PANDUAN-TOGAR.md): schema DHT/PIR/MQ, DATETIME WIB, MySQL SELECT-only, cursor/karantina, email dan troubleshooting.
- [Instalasi](INSTALLATION.md): environment, migrasi lokal, web dan worker.
- [Simulator v2](SIMULATOR.md): pengujian opsional tanpa perangkat/MySQL live.
- [OpenAPI v2](openapi-v2.json): kontrak endpoint aplikasi **/api/v2**, termasuk API uji perangkat dan endpoint dashboard. [openapi.json](openapi.json) berisi salinan kontrak v2 yang sama.
- [Hasil pengujian](TESTING.md): baca tanggal dan cakupan run; hasil lokal tidak membuktikan MySQL live/hardware.

## Dua jalur yang berbeda

**MySQL utama:** gunakan DATA_SOURCE=mysql. Web/worker membaca dht, pir, mq dan tidak menulis balik ke MySQL. Ambang kipas tetap milik firmware. API perangkat v2 menolak request pada sumber ini dengan409 SOURCE_MISMATCH.

**API uji opsional:** gunakan environment demo terpisah, DATA_SOURCE=api dan APP_MODE=simulation. Endpoint perangkat v2 memakai X-Device-ID serta X-API-Key aplikasi ini, bukan key API Mas Togar. GET tidak mengirim telemetry; POST telemetry menyimpan tiga record dalam transaksi. UUID/timestamp/payload retry tetap sama.

Dashboard refresh default300detik. Worker MySQL berjeda5detik setelah query selesai. Satu tugas SMTP berjalan di latar sehingga penantian SMTP tidak menahan polling MySQL; pengiriman tetap memiliki timeout dan status persisten.

Semua sukses API dibungkus data; error membawa error.code, message, details opsional, dan request_id. Perubahan dashboard memerlukan cookie/token CSRF dan Origin dalam allowlist. Ini bukan login; batasi jaringan internal.

Dokumen September disalin utuh ke [legacy/INTEGRATION.md](legacy/INTEGRATION.md). Itu kontrak /api/v1 terdahulu, bukan panduan integrasi Oktober.
