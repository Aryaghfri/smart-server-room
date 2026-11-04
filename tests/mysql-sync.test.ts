import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "mysql2/promise";
import { closeDbs } from "../src/lib/db";
import { mysqlNamespace, syncMySql } from "../src/lib/mysql-sync";
import {
  execute,
  latest,
  one,
  rows,
  state,
  summary,
} from "../src/lib/monitoring-store";
import type { LegacyRow } from "../src/lib/legacy-adapter";
import type { SensorKind } from "../src/lib/monitoring-types";

interface SqlRequest {
  sql: string;
  values?: unknown[];
  timeout?: number;
}
interface SqlCall {
  method: "query" | "execute";
  kind: SensorKind;
  sql: string;
  values: unknown[];
}

/** Reader tiruan saja: tidak membuka koneksi MySQL dan menolak semua SQL non-SELECT. */
class MockSqlReader {
  tables: Record<SensorKind, LegacyRow[]> = { dht: [], pir: [], mq: [] };
  calls: SqlCall[] = [];
  failTables = new Set<SensorKind>();

  private inspect(method: "query" | "execute", options: SqlRequest) {
    assert.match(
      options.sql,
      /^SELECT\s/i,
      "Sinkronisasi tidak boleh menulis ke MySQL sumber",
    );
    const match = options.sql.match(/\bFROM\s+`(dht|pir|mq)`/i);
    assert.ok(match, "Nama tabel harus berasal dari whitelist dht/pir/mq");
    const kind = match[1] as SensorKind;
    this.calls.push({
      method,
      kind,
      sql: options.sql,
      values: [...(options.values ?? [])],
    });
    if (this.failTables.has(kind)) {
      throw Object.assign(new Error(`Simulated SELECT failure for ${kind}`), {
        code: "ER_TABLEACCESS_DENIED_ERROR",
      });
    }
    return kind;
  }

  async query(options: SqlRequest) {
    const kind = this.inspect("query", options);
    assert.match(options.sql, /COALESCE\(MAX\(id\),\s*0\)\s+maximum/i);
    const maximum = Math.max(
      0,
      ...this.tables[kind].map((row) => Number(row.id)),
    );
    return [[{ maximum }], []];
  }

  async execute(options: SqlRequest) {
    const kind = this.inspect("execute", options);
    const comparison = options.sql.match(/\bWHERE\s+id\s*(>=|>)\s*\?/i);
    assert.ok(
      comparison,
      "Mock harus mencerminkan filter cursor yang benar-benar dipakai query",
    );
    assert.match(options.sql, /ORDER BY id\s+LIMIT 500\s*$/i);
    assert.equal(options.values?.length, 1);
    const boundary = Number(options.values![0]);
    assert.equal(Number.isFinite(boundary), true);
    const batch = this.tables[kind]
      .filter((row) =>
        comparison[1] === ">="
          ? Number(row.id) >= boundary
          : Number(row.id) > boundary,
      )
      .sort((left, right) => Number(left.id) - Number(right.id))
      .slice(0, 500)
      .map((row) => ({ ...row }));
    return [batch, []];
  }

  // mysql2 exposes generic overloads. This boundary adapts only those two read methods;
  // every query still executes the assertions above and reads the mutable fixture tables.
  asDatabase(): Pick<Pool, "query" | "execute"> {
    return {
      query: this.query.bind(this),
      execute: this.execute.bind(this),
    } as unknown as Pick<Pool, "query" | "execute">;
  }
}

let directory = "";
let originalEnvironment: NodeJS.ProcessEnv;
let measuredNow = 0;
beforeEach(() => {
  originalEnvironment = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "smart-room-mysql-test-"));
  measuredNow = Date.now();
  Object.assign(process.env, {
    APP_MODE: "simulation",
    DATA_SOURCE: "mysql",
    DATA_DIR: directory,
    DEVICE_ID: "mysql-test-device",
    DEVICE_API_KEY: "d".repeat(40),
    CSRF_SECRET: "c".repeat(40),
    MYSQL_HOST: "mock.invalid",
    MYSQL_PORT: "3306",
    MYSQL_DATABASE: "iot_test",
    MYSQL_USER: "select_only",
    MYSQL_TIME_ZONE: "+07:00",
    OFFLINE_AFTER_SECONDS: "30",
    SENSOR_STALE_SECONDS: "30",
  });
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
});
afterEach(() => {
  try {
    closeDbs();
    const resolved = path.resolve(directory);
    assert.equal(
      path.dirname(resolved),
      path.resolve(os.tmpdir()),
      "Cleanup hanya boleh di direktori temp pengujian",
    );
    assert.match(
      path.basename(resolved),
      /^smart-room-mysql-test-[a-zA-Z0-9]+$/,
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  } finally {
    process.env = { ...originalEnvironment };
  }
});

function mysqlTime(offsetMs = -1000) {
  return new Date(measuredNow + offsetMs + 7 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}
function sample(
  kind: SensorKind,
  id: number,
  status = 0,
  offsetMs = -1000,
): LegacyRow {
  return {
    id,
    status,
    create_date: mysqlTime(offsetMs),
    ...(kind === "dht" ? { suhu: "31.2", kelembapan: "67.0" } : {}),
  };
}
function addRecipient() {
  execute(
    "INSERT INTO email_recipients(email,name,created_at) VALUES(?,?,?)",
    "togar@example.test",
    "Penerima pengujian",
    new Date().toISOString(),
  );
}
function count(
  table:
    "sensor_records" | "smoke_incidents" | "email_outbox" | "source_rejections",
) {
  return one<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n;
}
function cursor(kind: SensorKind) {
  return state(`${mysqlNamespace()}:${kind}:cursor`);
}
async function sync(reader: MockSqlReader) {
  return syncMySql(reader.asDatabase());
}

test("bootstrap MySQL mengarsipkan MQ segar tanpa email atau online palsu", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  reader.tables.dht = [sample("dht", 1, 1)];
  reader.tables.pir = [sample("pir", 1, 1)];
  reader.tables.mq = [sample("mq", 1, 1)];
  assert.equal(await sync(reader), 3);
  assert.equal(count("sensor_records"), 3);
  assert.equal(count("smoke_incidents"), 0);
  assert.equal(count("email_outbox"), 0);
  assert.equal(summary().online, false);
  assert.equal(summary().stale.mq, false);
  for (const kind of ["dht", "pir", "mq"] as const) {
    assert.equal(state(`${mysqlNamespace()}:${kind}:bootstrap`), "1");
    assert.equal(cursor(kind), "1");
  }
  // DHT/PIR baru tidak boleh mengubah sampel MQ arsip menjadi pemicu live.
  reader.tables.dht.push(sample("dht", 2, 1, 0));
  reader.tables.pir.push(sample("pir", 2, 1, 0));
  assert.equal(await sync(reader), 2);
  assert.equal(count("smoke_incidents"), 0);
  assert.equal(count("email_outbox"), 0);
});

test("baris DHT/PIR null, future, dan status invalid dikarantina tanpa menghambat MQ", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader); // bootstrap kosong: baris sesudahnya merupakan live.
  reader.tables.dht = [
    { ...sample("dht", 1), create_date: null },
    sample("dht", 2, 0, 120_000),
    sample("dht", 3, 1),
  ];
  reader.tables.pir = [
    { ...sample("pir", 1), create_date: null },
    sample("pir", 2, 0, 120_000),
    { ...sample("pir", 3), status: 2 },
    sample("pir", 4, 1),
  ];
  reader.tables.mq = [sample("mq", 1, 1)];
  assert.equal(await sync(reader), 3);
  assert.equal(count("source_rejections"), 5);
  assert.equal(latest("dht")?.source_id, "3");
  assert.equal(latest("pir")?.source_id, "4");
  assert.equal(latest("mq")?.status, 1);
  assert.equal(count("smoke_incidents"), 1);
  assert.equal(count("email_outbox"), 1);
  assert.equal(cursor("dht"), "3");
  assert.equal(cursor("pir"), "4");
  assert.equal(cursor("mq"), "1");
  assert.equal(summary().integration.rejected_rows, 5);
  assert.equal(await sync(reader), 0);
  assert.equal(count("source_rejections"), 5);
});

test("pulsa MQ 1 lalu 0 dalam satu batch tetap menyimpan insiden selesai dan email pending", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader);
  reader.tables.mq = [sample("mq", 1, 1, -2000), sample("mq", 2, 0, -1000)];
  assert.equal(await sync(reader), 2);
  const incident = one<{ detected_at: string; resolved_at: string | null }>(
    "SELECT detected_at,resolved_at FROM smoke_incidents",
  );
  assert.ok(incident, "Pulsa asap harus tetap menghasilkan insiden");
  assert.equal(incident.resolved_at !== null, true);
  assert.equal(
    Date.parse(incident.resolved_at!) > Date.parse(incident.detected_at),
    true,
  );
  assert.equal(latest("mq")?.status, 0);
  assert.equal(count("email_outbox"), 1);
  assert.equal(
    one<{ status: string }>("SELECT status FROM email_outbox")!.status,
    "pending",
  );
});

test("kegagalan SELECT satu tabel tidak menghalangi MQ dan status pulih setelah sumber diperbaiki", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader);
  reader.failTables.add("dht");
  reader.tables.pir = [sample("pir", 1, 1)];
  reader.tables.mq = [sample("mq", 1, 1)];
  assert.equal(await sync(reader), 2);
  assert.equal(latest("mq")?.status, 1);
  assert.equal(count("email_outbox"), 1);
  assert.match(state("mysql_error")!, /dht: ER_TABLEACCESS_DENIED_ERROR/);
  assert.equal(cursor("mq"), "1");
  reader.failTables.clear();
  reader.tables.dht = [sample("dht", 1, 1)];
  assert.equal(await sync(reader), 1);
  assert.equal(state("mysql_error"), "");
  assert.equal(count("sensor_records"), 3);
  assert.equal(count("email_outbox"), 1);
});

test("overlap pembacaan berulang tidak menggandakan data, alarm, email, atau kontak perangkat", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader);
  for (const kind of ["dht", "pir", "mq"] as const)
    reader.tables[kind] = [sample(kind, 1, 1)];
  assert.equal(await sync(reader), 3);
  const firstContact = summary().last_contact_at;
  assert.equal(typeof firstContact, "string");
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let repeat = 0; repeat < 3; repeat++)
    assert.equal(await sync(reader), 0);
  assert.equal(count("sensor_records"), 3);
  assert.equal(count("smoke_incidents"), 1);
  assert.equal(count("email_outbox"), 1);
  assert.equal(
    summary().last_contact_at,
    firstContact,
    "SELECT ulang data lama bukan komunikasi baru dari perangkat",
  );
  assert.equal(cursor("mq"), "1");
});

test("commit terlambat dalam overlap masuk histori tanpa menurunkan cursor", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader);
  assert.equal(state(`${mysqlNamespace()}:mq:bootstrap`), "0");
  reader.tables.mq = [sample("mq", 2, 0, -2000)];
  assert.equal(await sync(reader), 1);
  assert.equal(cursor("mq"), "2");
  // ID rendah baru terlihat setelah ID tinggi; waktu pengukurannya justru lebih baru.
  reader.tables.mq.push(sample("mq", 1, 1, -1000));
  assert.equal(await sync(reader), 1);
  assert.equal(cursor("mq"), "2");
  assert.equal(count("sensor_records"), 2);
  assert.equal(latest("mq")?.source_id, "1");
  assert.equal(count("smoke_incidents"), 1);
  assert.equal(count("email_outbox"), 1);
  const recentMqRead = reader.calls
    .filter((call) => call.kind === "mq" && call.method === "execute")
    .at(-1)!;
  assert.equal(
    Number(recentMqRead.values[0]) < 1,
    true,
    "Query overlap harus masih mencakup ID 1",
  );
});

test("perubahan row historis dikarantina sementara record baru dan cursor tetap maju", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader);
  reader.tables.dht = [sample("dht", 1, 1, -2000)];
  reader.tables.mq = [sample("mq", 1, 0, -2000)];
  assert.equal(await sync(reader), 2);
  reader.tables.dht[0] = { ...reader.tables.dht[0], suhu: "24.0" };
  reader.tables.dht.push(sample("dht", 2, 1, -1000));
  reader.tables.mq.push(sample("mq", 2, 1, -1000));
  assert.equal(await sync(reader), 2);
  assert.equal(count("source_rejections"), 1);
  const old = one<{ suhu: number }>(
    "SELECT suhu FROM sensor_records WHERE kind='dht' AND source_id='1'",
  )!;
  assert.equal(old.suhu, 31.2);
  assert.equal(latest("dht")?.source_id, "2");
  assert.equal(latest("mq")?.status, 1);
  assert.equal(count("email_outbox"), 1);
  assert.equal(cursor("dht"), "2");
  assert.equal(cursor("mq"), "2");
  const rejected = rows<{ kind: string; source_id: string; reason: string }>(
    "SELECT kind,source_id,reason FROM source_rejections",
  );
  assert.equal(rejected[0].kind, "dht");
  assert.equal(rejected[0].source_id, "1");
  assert.equal(rejected[0].reason.length > 0, true);
  assert.equal(await sync(reader), 0);
  assert.equal(count("source_rejections"), 1);
});

test("record baru dengan waktu pengukuran usang tidak mengirim alarm atau membuat perangkat online", async () => {
  addRecipient();
  const reader = new MockSqlReader();
  await sync(reader);
  reader.tables.mq = [sample("mq", 1, 1, -120_000)];
  assert.equal(await sync(reader), 1);
  assert.equal(count("sensor_records"), 1);
  assert.equal(latest("mq")?.status, 1);
  assert.equal(summary().stale.mq, true);
  assert.equal(summary().online, false);
  assert.equal(count("smoke_incidents"), 0);
  assert.equal(count("email_outbox"), 0);
  assert.equal(typeof state("mysql_last_sync"), "string");
});
