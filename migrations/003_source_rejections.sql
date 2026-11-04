-- Baris sumber yang tidak valid dicatat, sehingga satu sensor rusak tidak menghentikan sensor lain.
CREATE TABLE source_rejections (
  record_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
