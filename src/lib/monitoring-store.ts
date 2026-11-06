import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { getDb, transaction } from "./db";
import { settings } from "./env";
import { ApiError } from "./security";
import { isoNow, todayWibBounds, tomorrowWib } from "./time";
import type {
  MonitorConfig,
  MonitorSummary,
  Recipient,
  SensorKind,
  SensorRecord,
  SmokeIncident,
  TemperatureForecast,
} from "./monitoring-types";

export type IncomingRecord = Omit<SensorRecord, "received_at">;
/** Ambil satu baris dari SQLite lokal web, bukan dari MySQL perangkat. */
export function one<T>(sql: string, ...args: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .get(...args) as T | undefined;
}
/** Ambil daftar hasil SQL lokal dengan parameter terikat untuk mencegah injeksi. */
export function rows<T>(sql: string, ...args: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .all(...args) as T[];
}
/** Tulis cache/antrean lokal. Hak akses MySQL Mas Togar tetap SELECT saja. */
export function execute(sql: string, ...args: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .run(...args);
}
/** Pilih jalur integrasi melalui environment; API dan MySQL tidak mencampur sumber aktif. */
export function dataSource(): "api" | "mysql" {
  const value = process.env.DATA_SOURCE || "mysql";
  if (value !== "api" && value !== "mysql")
    throw new Error("DATA_SOURCE harus api atau mysql");
  return value;
}
/** Baca posisi cursor dan status worker yang harus bertahan setelah restart. */
export function state(key: string): string | null {
  return (
    one<{ value: string }>(
      "SELECT value FROM integration_state WHERE key=?",
      key,
    )?.value ?? null
  );
}
/** Simpan kemajuan sinkronisasi agar row yang sama tidak menghasilkan insiden berulang. */
export function setState(key: string, value: string) {
  execute(
    "INSERT INTO integration_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    value,
  );
}
/** Rahasia SMTP hanya dibaca server. Browser cukup menerima status siap atau belum siap. */
export function emailConfigured() {
  return !!process.env.SMTP_HOST && !!process.env.SMTP_FROM;
}
/** Ambang ini khusus API alternatif; jalur MySQL tetap memakai ambang firmware Togar. */
export function currentConfig() {
  return one<MonitorConfig>(
    "SELECT version,fan_on_c,fan_off_c,updated_at FROM monitor_config WHERE singleton=1",
  )!;
}
/** Pilih pengukuran paling baru, bukan sekadar baris terakhir yang tiba di web. */
export function latest(kind: SensorKind) {
  return (
    one<SensorRecord>(
      "SELECT record_key,kind,source,source_id,measured_at,received_at,suhu,kelembapan,status,lamp_on,error_code FROM sensor_records WHERE kind=? ORDER BY measured_at DESC,rowid DESC LIMIT 1",
      kind,
    ) ?? null
  );
}
/** Data lama dan jam masa depan tidak boleh dianggap kondisi ruangan saat ini. */
export function isFresh(record: SensorRecord | null) {
  if (!record) return false;
  const age = Date.now() - Date.parse(record.measured_at);
  return age >= -30_000 && age < settings().stale * 1000;
}
/** Satu periode asap menghasilkan satu insiden, bukan email setiap sampel 5 detik. */
function reconcileSmoke() {
  const sample = latest("mq");
  if (!isFresh(sample) || !sample || sample.status === null) return;
  const active = one<{ id: string; detected_at: string }>(
    "SELECT id,detected_at FROM smoke_incidents WHERE resolved_at IS NULL",
  );
  if (
    sample.status === 0 &&
    active &&
    sample.measured_at >= active.detected_at
  ) {
    execute(
      "UPDATE smoke_incidents SET resolved_at=? WHERE id=?",
      sample.measured_at,
      active.id,
    );
    return;
  }
  if (sample.status !== 1 || active) return;
  const id = randomUUID();
  const created = execute(
    "INSERT OR IGNORE INTO smoke_incidents(id,trigger_record_key,detected_at,source) VALUES(?,?,?,?)",
    id,
    sample.record_key,
    sample.measured_at,
    sample.source,
  );
  if (!created.changes) return;
  for (const recipient of rows<Recipient>(
    "SELECT * FROM email_recipients WHERE enabled=1",
  )) {
    execute(
      "INSERT INTO email_outbox(incident_id,recipient_id,recipient_email,status,created_at) VALUES(?,?,?,?,?)",
      id,
      recipient.id,
      recipient.email,
      "pending",
      isoNow(),
    );
  }
}
/** Simpan tiga tabel ke histori lokal secara atomik dan deduplikasi berdasarkan ID sumber. */
export function saveRecords(
  records: IncomingRecord[],
  options: { live: boolean; contact?: boolean },
) {
  return transaction(() => {
    let inserted = 0;
    for (const record of records) {
      const digest = createHash("sha256")
        .update(JSON.stringify(record))
        .digest("hex");
      const existing = one<{ payload_hash: string }>(
        "SELECT payload_hash FROM sensor_records WHERE record_key=?",
        record.record_key,
      );
      if (existing) {
        if (existing.payload_hash !== digest)
          throw new ApiError(
            409,
            "ID_CONFLICT",
            "ID sama mempunyai isi berbeda. Retry harus memakai payload asli.",
          );
        continue;
      }
      execute(
        "INSERT INTO sensor_records(record_key,kind,source,source_id,measured_at,received_at,suhu,kelembapan,status,lamp_on,error_code,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        record.record_key,
        record.kind,
        record.source,
        record.source_id,
        record.measured_at,
        isoNow(),
        record.suhu,
        record.kelembapan,
        record.status,
        record.lamp_on,
        record.error_code,
        digest,
      );
      inserted++;
      // Proses setiap sampel MQ; transisi 1 lalu 0 dalam satu batch tetap membuat insiden.
      if (options.live && record.kind === "mq") {
        const newest = latest("mq");
        if (newest?.record_key === record.record_key) reconcileSmoke();
      }
    }
    // Import arsip tidak boleh membuat perangkat tampak online atau mengirim alarm masa lalu.
    if (options.contact) {
      execute(
        "UPDATE monitor_device SET last_contact_at=? WHERE singleton=1",
        isoNow(),
      );
      setState("last_contact_source", records[0]?.source || "api");
    }
    return { inserted, duplicates: records.length - inserted };
  });
}
/** Gabungkan satu insiden asap dengan status email setiap penerima untuk halaman Peringatan. */
export function incidentList(limit = 20, offset = 0): SmokeIncident[] {
  return rows<Omit<SmokeIncident, "emails">>(
    "SELECT id,detected_at,resolved_at,source FROM smoke_incidents ORDER BY detected_at DESC,id DESC LIMIT ? OFFSET ?",
    limit,
    offset,
  ).map((incident) => ({
    ...incident,
    emails: rows<SmokeIncident["emails"][number]>(
      "SELECT recipient_email,status,completed_at,detail FROM email_outbox WHERE incident_id=? ORDER BY id",
      incident.id,
    ),
  }));
}
/** Ringkasan memisahkan deteksi PIR, target LED, dan laporan LED fisik yang belum tersedia. */
/** Prediksi disimpan worker sebagai JSON; yang ditampilkan hanya prediksi untuk besok. */
function forecast(): TemperatureForecast | null {
  try {
    const value = JSON.parse(state("forecast") || "null") as TemperatureForecast | null;
    return value?.tanggal === tomorrowWib() ? value : null;
  } catch {
    return null;
  }
}
export function summary(): MonitorSummary {
  const env = settings();
  const d = one<{
    last_contact_at: string | null;
    applied_config_version: number;
  }>("SELECT * FROM monitor_device WHERE singleton=1")!;
  const values = { dht: latest("dht"), pir: latest("pir"), mq: latest("mq") };
  const [start, end] = todayWibBounds();
  const count = (sql: string, ...params: SQLInputValue[]) =>
    one<{ n: number }>(sql, ...params)?.n ?? 0;
  const chart = rows<SensorRecord>(
    "SELECT record_key,kind,source,source_id,measured_at,received_at,suhu,kelembapan,status,lamp_on,error_code FROM sensor_records WHERE kind='dht' ORDER BY measured_at DESC,rowid DESC LIMIT 120",
  ).reverse();
  return {
    forecast: forecast(),
    dashboard_poll_seconds: env.dashboardPoll,
    mode: env.mode,
    data_source: dataSource(),
    device_id: env.deviceId,
    server_time: isoNow(),
    online:
      !!d.last_contact_at &&
      (dataSource() === "mysql"
        ? state("last_contact_source") === "mysql"
        : state("last_contact_source") !== "mysql") &&
      Date.now() - Date.parse(d.last_contact_at) < env.offline * 1000,
    last_contact_at: d.last_contact_at,
    latest: values,
    stale: {
      dht: !isFresh(values.dht),
      pir: !isFresh(values.pir),
      mq: !isFresh(values.mq),
    },
    counts: {
      dht: count("SELECT COUNT(*) n FROM sensor_records WHERE kind='dht'"),
      pir: count("SELECT COUNT(*) n FROM sensor_records WHERE kind='pir'"),
      mq: count("SELECT COUNT(*) n FROM sensor_records WHERE kind='mq'"),
      motion_samples_today: count(
        "SELECT COUNT(*) n FROM sensor_records WHERE kind='pir' AND status=1 AND measured_at>=? AND measured_at<?",
        start,
        end,
      ),
      smoke_samples_today: count(
        "SELECT COUNT(*) n FROM sensor_records WHERE kind='mq' AND status=1 AND measured_at>=? AND measured_at<?",
        start,
        end,
      ),
    },
    chart,
    recent: rows<SensorRecord>(
      "SELECT record_key,kind,source,source_id,measured_at,received_at,suhu,kelembapan,status,lamp_on,error_code FROM sensor_records ORDER BY measured_at DESC,rowid DESC LIMIT 8",
    ),
    incidents: incidentList(5),
    config: currentConfig(),
    applied_config_version: d.applied_config_version,
    source_counts: rows(
      "SELECT source,COUNT(*) total FROM sensor_records GROUP BY source",
    ),
    email: {
      configured: emailConfigured(),
      recipients: count(
        "SELECT COUNT(*) n FROM email_recipients WHERE enabled=1",
      ),
      worker_last_seen: state("worker_last_seen"),
    },
    integration: {
      rejected_rows: count("SELECT COUNT(*) n FROM source_rejections"),
      last_sync_at: state("mysql_last_sync"),
      last_error: state("mysql_error"),
      worker_last_seen: state("worker_last_seen"),
    },
  };
}
