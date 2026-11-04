# Kontrak revisi Oktober2026

Panduan utama: [docs/PANDUAN-TOGAR.md](docs/PANDUAN-TOGAR.md). Kontrak HTTP aplikasi: [docs/openapi-v2.json](docs/openapi-v2.json), identik dengan docs/openapi.json. Salinan kontrak September ada di docs/legacy/CONTRACT.md.

## Jalur utama

Perangkat → API Mas Togar existing → MySQL iot_binus → worker SELECT-only → SQLite cache/antrean → dashboard. API Mas Togar tidak diganti atau diasumsikan memiliki URL/payload sama dengan endpoint aplikasi ini. Sumber default MYSQL; /api/v2/device/* hanya alternatif uji ketika DATA_SOURCE=api.

- dht: id,suhu,kelembapan,status,create_date. status adalah fan0OFF/1ON; kegagalan DHT memakai null/error, bukan statuskipas.
- pir: id,status,create_date. status0/1 deteksi, bukan jumlahorang; SQL tidak memberi feedback LED. Target LED berbeda dari laporanfisik lamp_on.
- mq: id,status,create_date. Status asap biner, bukanPPM.
- DATETIME sumber ditafsirkan sesuai MYSQL_TIME_ZONE=+07:00, disimpan lokalUTC, ditampilkanWIB. update _date tidak diubah atau dipakai.
- Dump contoh69baris/tabel =207record. Import/bootstraphistori tidak membuat alarm/email lama atau kontakaktif.

## Sinkronisasi dan penyimpanan

Worker mencatat MAX(id) per tabel sebagai bootstrap. Query WHERE id>? ORDER BY id LIMIT500 memakai batasMath.max(0,cursor-200), untuk overlap200ID. Cursor persisten; sumber harusappend-only, ID tidak direset. Recordidentik dilewati; ID sama berubah dikarantinaROW_CHANGED tanpa overwritecache. Baris invalid/waktufuture dikarantina di source_rejections; kegagalan satu tabel tidak memblokir giliran MQ. Gap/commit terlambat di luar200ID tidak dijamin. SQLite adalah cache/stateinternal, bukan penggantiMySQL.

Dashboard defaultDASHBOARD_POLL_SECONDS=300. Loop ingestion menyelesaikan queryMySQL lalu jeda5detik; satu tugasSMTP latar berjalan tanpa menahan pollingMySQL. Browser boleh ditutup, worker harus tetap hidup. APP_MODE=simulation|real memilih fileSQLite terpisah; setup tidak overwrite.env.local. Mode simulation tidak menonaktifkanSMTP nyata jika operator mengonfigurasikannya.

## Email

Satu episodeMQ1 membentuk satu insiden; MQ0 menutup;1berikutnya insiden baru. Proses perbaris mempertahankan pulse1→0 dalam satu batch. Antreanunik(incident_id,recipient_id). Penerima baru tidak backfill insidenlama. Status pending/sending/sent/failed/unknown/skipped persisten. TanpaSMTP pending; umur>5menit atau penerimanonaktif skipped. Insidenfresh yangresolved tetapdikirim. Sent=SMTPaccepted, bukaninbox. EAUTH/EENVELOPE/EDNS gagaldefinitif; timeout/koneksiambigu unknown, tidak autoretry. Restart sending→unknown.

## HTTP aplikasi v2 (opsional untuk perangkat)

Sukses {data:...}; error {error:{code,message,details?},request_id}. Device memakai X-Device-ID+X-API-Key; headerOrigin ditolak. SumberMySQL menolakdeviceendpoint409SOURCE_MISMATCH. Mutasidashboard memerlukan Originallowlist+cookieHttpOnlySameSiteStrict+X-CSRF-Token. Dashboard tanpa login, batasi jaringan.

- GET /api/v2/health: version2,mode,data_source; bukan tesMySQL/SMTP.
- POST /api/v2/device/telemetry: sample_idUUID,measured_atISO,dht{suhu,kelembapan,status,error_code?},pir{status,lamp_on?},mq{status}. Tigarecord atomik; retryID+payload sama idempoten, konflik409. DHTstatus/PIRstatus/MQstatus 0|1|null; lamp_onboolean|null.
- GET /api/v2/device/config; POST /api/v2/device/config/ack {version}; POST /api/v2/device/heartbeat {heartbeat_id,reported_at}. ACK eksplisitmonotonik; heartbeat bukanACK/sensorsehat.
- GET /api/v2/dashboard/session, /summary, /history, /alerts, /recipients. Histori filterkind/source/from/to WIB, paginationpage1..100000/page_size1..100.
- POST /api/v2/dashboard/recipients {email,name?}; DELETE /api/v2/dashboard/recipients/{id}:nonaktifkan.
- PUT /api/v2/dashboard/settings {expected_version,fan_on_c,fan_off_c}: jalurAPI saja, OFF<ON; sumberMySQL409MYSQL_LOCAL_CONFIG, versi usang409CONFIG_CONFLICT.

Schema lengkap, contoh, dan batas validasi ada di OpenAPIv2. Tidak ada kontrak PIN/wiring atau klaim hardwareteruji pada dokumen ini.
