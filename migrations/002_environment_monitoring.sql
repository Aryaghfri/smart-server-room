-- Revisi Oktober: tiga sensor Mas Togar. Tabel lama tetap disimpan agar histori tidak hilang.
CREATE TABLE sensor_records (
  record_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('dht','pir','mq')),
  source TEXT NOT NULL CHECK(source IN ('api','mysql','sql_import','simulator')),
  source_id TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  suhu REAL,
  kelembapan REAL,
  status INTEGER CHECK(status IN (0,1) OR status IS NULL),
  lamp_on INTEGER CHECK(lamp_on IN (0,1) OR lamp_on IS NULL),
  error_code TEXT,
  payload_hash TEXT NOT NULL
);
CREATE INDEX sensor_kind_time ON sensor_records(kind,measured_at DESC,record_key DESC);
CREATE INDEX sensor_time ON sensor_records(measured_at DESC,record_key DESC);
CREATE TABLE monitor_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL DEFAULT 1,
  fan_on_c REAL NOT NULL DEFAULT 31,
  fan_off_c REAL NOT NULL DEFAULT 30 CHECK(fan_off_c<fan_on_c),
  updated_at TEXT NOT NULL
);
INSERT INTO monitor_config(singleton,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE monitor_device (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  last_contact_at TEXT,
  applied_config_version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO monitor_device(singleton) VALUES(1);
CREATE TABLE email_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE smoke_incidents (
  id TEXT PRIMARY KEY,
  trigger_record_key TEXT NOT NULL UNIQUE REFERENCES sensor_records(record_key),
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  source TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_smoke ON smoke_incidents((1)) WHERE resolved_at IS NULL;
CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES smoke_incidents(id),
  recipient_id INTEGER NOT NULL REFERENCES email_recipients(id),
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','skipped')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  message_id TEXT,
  detail TEXT,
  UNIQUE(incident_id,recipient_id)
);
CREATE INDEX outbox_pending ON email_outbox(status,id);
CREATE TABLE integration_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
