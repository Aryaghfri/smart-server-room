# Simulator v2 — pengujian opsional

Simulator memakai API HTTP aplikasi /api/v2. Ini **bukan API Mas Togar** dan bukan pengganti jalur utama perangkat → API Mas Togar → MySQL iot_binus → web.

Gunakan environment demo terpisah:

```dotenv
APP_MODE=simulation
DATA_SOURCE=api
BASE_URL=http://127.0.0.1:3000
```

Setup default sumberMySQL; ubah DATA_SOURCE secara eksplisit untuk uji ini dan restart server. DEVICE_ID/API_KEY berasal dari setup lokal. Simulator menolak mode real dan server yang bukan sumber API simulation.

```powershell
npm.cmd run simulator -- --scenario=normal
```

Hentikan proses sebelumnya dengan Ctrl+C sebelum menjalankan skenario lain:

```powershell
npm.cmd run simulator -- --scenario=motion --once
npm.cmd run simulator -- --scenario=sensor-error --once
npm.cmd run simulator -- --scenario=smoke --once
```

| Skenario | Hasil |
|---|---|
| normal | DHT berubah, PIR bergiliran, MQ0 |
| motion | PIR1 dan laporan LED simulasi ON; MQ0 |
| sensor-error | DHT null/null dengan DHT_READ_FAILED; kipas simulasi ON |
| smoke | MQ1; dapat membentuk insiden dan antrean untuk penerima aktif |

Syntax CLI memakai --scenario=nama. --once berhenti setelah satu putaran; tanpa opsi itu loop berjeda5detik. Timeout per request4detik. Simulator mengambil config, menerapkan ambang, mengirim ACK, kemudian telemetry. Default ambang API baru ON≥31°C/OFF≤30°C; di antaranya state kipas dipertahankan. Nilai ini bukan perubahan pada firmware jalur MySQL.

Satu sample_id UUID menghasilkan tiga record DHT/PIR/MQ. Payload yang gagal dikirim dipertahankan utuh di memori dengan ID dan timestamp sama untuk loop berikutnya. Buffer hilang saat proses berhenti; ini bukan firmware atau antrean persisten. Log Belum terkirim berarti kegagalan; jangan menyimpulkan berhasil hanya karena proses --once selesai.

## Uji email lokal

1. Daftarkan penerima uji yang disetujui sebelum insiden.
2. Atur SMTP lokal dan jalankan npm.cmd run worker; tanpa SMTP, antrean tetap pending dan tidak diklaim sent.
3. Jalankan smoke. Sampel1 berulang harus mempertahankan satu insiden, bukan mengirim email tiap sampel.
4. Hentikan smoke dan jalankan normal untuk menghasilkan MQ0. Insiden ditutup; email insiden yang masih baru tetap dapat dikirim.
5. Smoke berikutnya dapat membuat insiden baru. Sent hanya berarti SMTP menerima; unknown tidak diulang otomatis setelah restart.

Browser refresh5menit, worker MySQL berjeda5detik, dan tugas SMTP latar tidak menahan polling. Gunakan Perbarui untuk melihat hasil segera. Pada sumber API worker tetap memproses SMTP tanpa mengambil MySQL.

## Arsip SQL adalah jalur berbeda

```powershell
npm.cmd run import:sql -- examples/iot_binus.sql
```

Importer hanya berjalan pada mode simulation, membaca207record contoh, tidak mengeksekusi SQL dump, tidak membuat perangkat online, dan tidak membentuk alarm/email lama. Gunakan DATA_DIR terpisah agar histori arsip dan uji live tidak tertumpuk.

Simulator September dipertahankan melalui simulator:legacy; panduannya ada di [legacy/SIMULATOR.md](legacy/SIMULATOR.md). Kontrak uji saat ini: [OpenAPIv2](openapi-v2.json). Keberhasilan simulator bukan bukti pengujian MySQL live, inbox nyata, sensor, LED, kipas, atau hardware.
