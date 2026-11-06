# API Flask — Penerima Data ESP32 (Mas Togar)

`app.py` menerima data sensor dari ESP32 lalu menyimpannya ke MySQL `iot_binus` (tabel `dht`, `pir`, `mq`). Dashboard web membaca tabel yang sama.

## Menjalankan

```powershell
pip install -r requirements.txt
$env:MYSQL_USER = "root"
$env:MYSQL_PASSWORD = "password_mysql"
python app.py
```

Server berjalan di port `5000`. Variabel lain: `MYSQL_HOST` (default `localhost`), `MYSQL_DATABASE` (default `iot_binus`), `FLASK_DEBUG=1` untuk mode debug saat pengembangan saja.

## Endpoint

| Method | Path | Fungsi |
|---|---|---|
| GET | `/` | Cek server berjalan |
| GET | `/test-db` | Cek koneksi MySQL |
| POST | `/api/data` | Terima data sensor ESP32 |

Body `POST /api/data`:

```json
{ "suhu": 31.2, "kelembapan": 67.0, "kipas": 1, "gerakan": 0, "nilai_asap": 1450, "asap": 0 }
```

Satu request menyimpan tiga baris sekaligus dalam satu transaksi: `dht` (suhu, kelembapan, status kipas), `pir` (gerakan), dan `mq` (asap). `nilai_asap` divalidasi (0–4095) tetapi tidak disimpan karena tabel `mq` hanya punya kolom status.

## File lain

- `iot_binus.sql` — dump database terbaru (1 November 2026, 2031 baris per tabel).
- `prediksi_suhu.sql` — tabel untuk hasil model ML; dashboard menampilkan prediksi suhu besok (pagi, siang, malam) dari tabel ini.
