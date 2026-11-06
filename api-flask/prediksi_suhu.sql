-- Tabel hasil prediksi suhu dari model ML (dibuat di database iot_binus).
-- Dashboard membaca tabel ini dengan SELECT dan menampilkan prediksi untuk BESOK (WIB).
--   tanggal : tanggal yang diprediksi (DATE, contoh 2026-11-07)
--   waktu   : 'pagi', 'siang', atau 'malam'
--   suhu    : suhu prediksi dalam °C
-- Jika model dijalankan ulang, cukup INSERT baris baru; dashboard memakai baris terbaru
-- (id terbesar) untuk setiap waktu.

CREATE TABLE IF NOT EXISTS `prediksi_suhu` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tanggal` date NOT NULL,
  `waktu` varchar(10) NOT NULL COMMENT 'pagi / siang / malam',
  `suhu` decimal(5,2) NOT NULL,
  `create_date` datetime NULL DEFAULT NULL,
  PRIMARY KEY (`id`) USING BTREE,
  KEY `idx_tanggal` (`tanggal`)
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci;

-- Contoh data dari model ML untuk besok:
-- INSERT INTO prediksi_suhu (tanggal, waktu, suhu, create_date) VALUES
--   (CURDATE() + INTERVAL 1 DAY, 'pagi',  27.4, NOW()),
--   (CURDATE() + INTERVAL 1 DAY, 'siang', 31.6, NOW()),
--   (CURDATE() + INTERVAL 1 DAY, 'malam', 28.9, NOW());

-- Akun SELECT dashboard juga perlu izin membaca tabel ini, misalnya:
-- GRANT SELECT ON iot_binus.prediksi_suhu TO 'akun_baca'@'%';
