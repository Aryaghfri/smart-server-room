import { createHash } from "node:crypto";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { adaptLegacyRow, legacyTime, type LegacyRow } from "./legacy-adapter";
import {
  execute,
  one,
  saveRecords,
  setState,
  state,
  type IncomingRecord,
} from "./monitoring-store";
import { isoNow, tomorrowWib } from "./time";
import type {
  ForecastPeriod,
  SensorKind,
  TemperatureForecast,
} from "./monitoring-types";

let pool: Pool | null = null;
/** Akses MySQL hanya SELECT. Schema dan data Mas Togar tidak diubah oleh dashboard. */
export function mysqlPool() {
  if (pool) return pool;
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER)
    throw new Error("MYSQL_NOT_CONFIGURED");
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "iot_binus",
    connectionLimit: 2,
    waitForConnections: true,
    queueLimit: 10,
    connectTimeout: 5000,
    dateStrings: true,
    enableKeepAlive: true,
    ...(process.env.MYSQL_SSL === "true"
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  });
  return pool;
}
export function mysqlNamespace() {
  return (
    "mysql:" +
    createHash("sha256")
      .update(
        `${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || "iot_binus"}`,
      )
      .digest("hex")
      .slice(0, 12)
  );
}
/** Cursor ID membuat sinkronisasi inkremental. Baris lama merupakan arsip dan tidak memicu email. */
export async function syncMySql(
  database: Pick<Pool, "query" | "execute"> = mysqlPool(),
) {
  const namespace = mysqlNamespace();
  let total = 0;
  const failures: string[] = [];
  for (const kind of ["dht", "pir", "mq"] as SensorKind[]) {
    try {
      // Nama tabel berasal dari whitelist, bukan input pengguna.
      const cursorKey = `${namespace}:${kind}:cursor`,
        bootstrapKey = `${namespace}:${kind}:bootstrap`;
      let bootstrap = state(bootstrapKey);
      if (bootstrap === null) {
        const [maximum] = await database.query<RowDataPacket[]>({
          sql: `SELECT COALESCE(MAX(id),0) maximum FROM \`${kind}\``,
          timeout: 5000,
        });
        bootstrap = String(maximum[0].maximum);
        setState(bootstrapKey, bootstrap);
      }
      const cursor = Number(state(cursorKey) || 0);
      const columns =
        kind === "dht"
          ? "id,suhu,kelembapan,status,create_date"
          : "id,status,create_date";
      const [batch] = await database.execute<RowDataPacket[]>({
        sql: `SELECT ${columns} FROM \`${kind}\` WHERE id>? ORDER BY id LIMIT 500`,
        // Baca ulang 200 ID untuk menangkap commit yang terlambat dalam jendela terbatas.
        values: [Math.max(0, cursor - 200)],
        timeout: 5000,
      });
      if (!batch.length) continue;
      const archive: IncomingRecord[] = [],
        live: IncomingRecord[] = [];
      for (const row of batch) {
        try {
          const record = adaptLegacyRow(
            kind,
            row as unknown as LegacyRow,
            "mysql",
            namespace,
          );
          const existing = one<{ payload_hash: string }>(
            "SELECT payload_hash FROM sensor_records WHERE record_key=?",
            record.record_key,
          );
          if (existing) {
            const digest = createHash("sha256")
              .update(JSON.stringify(record))
              .digest("hex");
            if (existing.payload_hash !== digest)
              throw new Error(
                "ROW_CHANGED: record lama berubah; kirim koreksi sebagai ID baru.",
              );
            continue;
          }
          (Number(row.id) <= Number(bootstrap) ? archive : live).push(record);
        } catch (error) {
          // DATETIME null, status di luar 0/1, atau jam masa depan tidak boleh memblokir MQ.
          const reason =
            error instanceof Error
              ? error.message.slice(0, 300)
              : "INVALID_SOURCE_ROW";
          execute(
            "INSERT OR IGNORE INTO source_rejections(record_key,kind,source_id,rejected_at,reason) VALUES(?,?,?,?,?)",
            `${namespace}:${kind}:${row.id}`,
            kind,
            String(row.id),
            isoNow(),
            reason,
          );
        }
      }
      if (archive.length)
        total += saveRecords(archive, { live: false }).inserted;
      const recent = live.some((row) => {
        const age = Date.now() - Date.parse(row.measured_at);
        return age >= -30_000 && age < 30_000;
      });
      if (live.length)
        total += saveRecords(live, { live: true, contact: recent }).inserted;
      setState(cursorKey, String(batch[batch.length - 1].id));
    } catch (error) {
      // Jika satu tabel gagal dibaca, tabel lain (terutama MQ) masih mendapat giliran.
      const code = String((error as { code?: string }).code || "SYNC_ERROR");
      failures.push(`${kind}: ${code}`);
    }
  }
  try {
    await syncForecast(database);
  } catch (error) {
    failures.push(
      `prediksi_suhu: ${String((error as { code?: string }).code || "SYNC_ERROR")}`,
    );
  }
  setState("mysql_last_sync", isoNow());
  setState(
    "mysql_error",
    failures.length
      ? `Sinkronisasi sebagian gagal (${failures.join(", ")}). Periksa tabel dan koneksi MySQL.`
      : "",
  );
  return total;
}
/**
 * Prediksi suhu besok dari model ML Mas Togar (tabel prediksi_suhu: tanggal, waktu, suhu).
 * Setiap waktu (pagi/siang/malam) memakai baris terbaru. Tabel opsional: jika belum dibuat,
 * dashboard menampilkan "menunggu prediksi" tanpa pesan error.
 */
async function syncForecast(database: Pick<Pool, "execute">) {
  const tanggal = tomorrowWib();
  let batch: RowDataPacket[];
  try {
    [batch] = await database.execute<RowDataPacket[]>({
      sql: "SELECT waktu,suhu,create_date FROM `prediksi_suhu` WHERE tanggal=? ORDER BY id DESC LIMIT 50",
      values: [tanggal],
      timeout: 5000,
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_NO_SUCH_TABLE") {
      setState("forecast", "");
      return;
    }
    throw error;
  }
  const result: TemperatureForecast = {
    tanggal,
    updated_at: null,
    suhu: { pagi: null, siang: null, malam: null },
  };
  for (const row of batch) {
    const waktu = String(row.waktu ?? "").trim().toLowerCase() as ForecastPeriod;
    if (!(waktu in result.suhu) || result.suhu[waktu] !== null) continue;
    const suhu = Number(row.suhu);
    if (String(row.suhu ?? "").trim() === "" || !Number.isFinite(suhu) || suhu < -40 || suhu > 80)
      continue;
    result.suhu[waktu] = suhu;
    let created: string | null = null;
    try {
      created = legacyTime(row.create_date);
    } catch {
      // Waktu pembuatan hanya informasi; prediksi tetap ditampilkan.
    }
    if (created && (!result.updated_at || created > result.updated_at))
      result.updated_at = created;
  }
  const filled = Object.values(result.suhu).some((value) => value !== null);
  setState("forecast", filled ? JSON.stringify(result) : "");
}
export async function closeMySql() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
