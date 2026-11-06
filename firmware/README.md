# Firmware ESP32 — Smart Server Room

Sketch Arduino dari tim IoT: [`smart-server-room/smart-server-room.ino`](smart-server-room/smart-server-room.ino).

## Perangkat dan pin (ESP32 WROOM)

| Komponen | Pin | Keterangan |
|---|---|---|
| PIR | GPIO 14 | Deteksi gerakan; LED mengikuti PIR |
| LED | GPIO 32 | Menyala saat PIR mendeteksi gerakan |
| DHT22 | GPIO 25 | Suhu dan kelembapan |
| Relay kipas | GPIO 27 | Kipas ON jika suhu ≥ 31,0 °C |
| MQ-2 | GPIO 34 (ADC) | Asap terdeteksi jika rata-rata 10 sampel ≥ 2000 |

Library: `DHT sensor library` (Adafruit). `WiFi.h` dan `HTTPClient.h` sudah termasuk di board ESP32.

## Alur data

Setiap 5 detik ESP32 membaca sensor lalu mengirim `POST` JSON ke API Flask Mas Togar (`SERVER_URL`, kode di [api-flask/](../api-flask/README.md)), yang menyimpannya ke MySQL `iot_binus`. Dashboard web tidak menerima data langsung dari ESP32; worker web membaca MySQL.

```json
{ "suhu": 31.2, "kelembapan": 67.0, "kipas": 1, "gerakan": 0, "nilai_asap": 1450, "asap": 0 }
```

Penyimpanan ke MySQL dilakukan oleh API Mas Togar; pemetaan berikut mengikuti arti kolom pada dump `iot_binus`:

| Field | Tabel MySQL |
|---|---|
| `suhu`, `kelembapan`, `kipas` | `dht` (`kipas` → `status`) |
| `gerakan` | `pir.status` |
| `asap` | `mq.status` |

## Sebelum upload

Sesuaikan `WIFI_SSID`, `WIFI_PASSWORD`, dan `SERVER_URL` (alamat IP laptop yang menjalankan API Flask) dengan jaringan yang dipakai.

## Catatan

Jika DHT22 gagal dibaca, `loop()` melewati pengiriman seluruh data pada putaran itu, termasuk status PIR dan asap.
