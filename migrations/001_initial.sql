CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE device (
  device_id TEXT PRIMARY KEY,
  last_contact_at TEXT,
  applied_config_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE configurations (
  version INTEGER PRIMARY KEY,
  fan_on_c REAL NOT NULL,
  fan_off_c REAL NOT NULL CHECK(fan_off_c < fan_on_c),
  fan_mode TEXT NOT NULL CHECK(fan_mode IN ('automatic','manual')),
  unlock_duration_seconds INTEGER NOT NULL CHECK(unlock_duration_seconds BETWEEN 1 AND 30),
  updated_at TEXT NOT NULL
);
CREATE TABLE access_events (
  event_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(device_id),
  occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
  person_id TEXT, person_name TEXT, recognition TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
  payload_hash TEXT NOT NULL
);
CREATE INDEX access_time ON access_events(occurred_at DESC);
CREATE INDEX access_decision_time ON access_events(decision,occurred_at DESC);
CREATE TABLE readings (
  reading_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(device_id),
  measured_at TEXT NOT NULL, received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','error')),
  temperature_c REAL, humidity_percent REAL, error_code TEXT, payload_hash TEXT NOT NULL,
  CHECK((status='ok' AND temperature_c IS NOT NULL AND humidity_percent IS NOT NULL) OR
        (status='error' AND temperature_c IS NULL AND humidity_percent IS NULL))
);
CREATE INDEX readings_time ON readings(measured_at DESC);
CREATE INDEX readings_valid ON readings(status,measured_at DESC);
CREATE TABLE heartbeats (
  heartbeat_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(device_id),
  reported_at TEXT NOT NULL, received_at TEXT NOT NULL,
  lock_state TEXT NOT NULL, fan_on INTEGER NOT NULL, fan_mode TEXT NOT NULL,
  applied_config_version INTEGER NOT NULL, payload_hash TEXT NOT NULL
);
CREATE INDEX heartbeat_time ON heartbeats(reported_at DESC);
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(device_id),
  type TEXT NOT NULL CHECK(type IN ('unlock','set_fan')),
  duration_seconds INTEGER, fan_on INTEGER, config_version INTEGER NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, result_deadline TEXT NOT NULL,
  received_at TEXT, completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','received','succeeded','failed')),
  message TEXT, source TEXT NOT NULL DEFAULT 'dashboard internal',
  payload_hash TEXT NOT NULL, result_hash TEXT
);
CREATE INDEX commands_time ON commands(created_at DESC);
CREATE INDEX commands_pending ON commands(status,expires_at);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, created_at TEXT NOT NULL,
  device_id TEXT NOT NULL, source TEXT NOT NULL, command_id TEXT, detail TEXT NOT NULL
);
CREATE INDEX audit_time ON audit_log(created_at DESC);
