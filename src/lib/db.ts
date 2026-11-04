import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { settings } from "./env";
import { isoNow } from "./time";

const connections = new Map<string, DatabaseSync>();
export function getDb() {
  const env = settings();
  const filename = path.join(env.dataDir, `${env.mode}.sqlite`);
  const cached = connections.get(filename);
  if (cached) return cached;
  fs.mkdirSync(env.dataDir, { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const directory = path.join(process.cwd(), "migrations");
  for (const migration of fs
    .readdirSync(directory)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (
      db
        .prepare("SELECT version FROM schema_migrations WHERE version=?")
        .get(migration)
    )
      continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(fs.readFileSync(path.join(directory, migration), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(
        migration,
        isoNow(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  const marker = db
    .prepare("SELECT value FROM metadata WHERE key='mode'")
    .get() as { value: string } | undefined;
  if (marker && marker.value !== env.mode) {
    db.close();
    throw new Error("Database mode mismatch");
  }
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('mode',?)").run(env.mode);
  const device = db.prepare("SELECT device_id FROM device LIMIT 1").get() as
    { device_id: string } | undefined;
  if (device && device.device_id !== env.deviceId) {
    db.close();
    throw new Error("Device ID differs from database; use a separate DATA_DIR");
  }
  db.prepare("INSERT OR IGNORE INTO device(device_id) VALUES (?)").run(
    env.deviceId,
  );
  db.prepare(
    "INSERT OR IGNORE INTO configurations VALUES (1,30,28,'automatic',5,?)",
  ).run(isoNow());
  connections.set(filename, db);
  return db;
}
export function closeDbs() {
  for (const db of connections.values()) db.close();
  connections.clear();
}
export function transaction<T>(callback: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
