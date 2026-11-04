import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SMTPServer } from "smtp-server";
import { handleMonitoringApi } from "../src/lib/monitoring-api";
import { closeDbs } from "../src/lib/db";
import { adaptLegacyRow, parseLegacyDump } from "../src/lib/legacy-adapter";
import {
  currentConfig,
  execute,
  one,
  rows,
  saveRecords,
  summary,
} from "../src/lib/monitoring-store";
import {
  deliverPendingEmails,
  recoverSendingEmails,
} from "../src/lib/mail-worker";

let directory = "";
const original = { ...process.env };
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "smart-room-v2-"));
  Object.assign(process.env, {
    APP_MODE: "simulation",
    DATA_SOURCE: "api",
    DATA_DIR: directory,
    DEVICE_ID: "test-device",
    DEVICE_API_KEY: "d".repeat(40),
    CSRF_SECRET: "c".repeat(40),
    ALLOWED_ORIGINS: "http://localhost:3000",
    MYSQL_TIME_ZONE: "+07:00",
  });
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
});
afterEach(() => {
  closeDbs();
  process.env = { ...original };
  assert.ok(
    path
      .resolve(directory)
      .startsWith(path.join(os.tmpdir(), "smart-room-v2-")),
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
function telemetry(mq = 0, overrides: Record<string, unknown> = {}) {
  return {
    sample_id: randomUUID(),
    measured_at: new Date().toISOString(),
    dht: { suhu: 31.2, kelembapan: 67, status: 1, error_code: null },
    pir: { status: 1, lamp_on: true },
    mq: { status: mq },
    ...overrides,
  };
}
async function call(
  endpoint: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await handleMonitoringApi(
    new Request("http://localhost:3000/api/v2/" + endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Device-ID": "test-device",
        "X-API-Key": "d".repeat(40),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    endpoint.split("?")[0].split("/"),
  );
  return { response, body: await response.json() };
}
async function session() {
  const r = await call("dashboard/session");
  return {
    Origin: "http://localhost:3000",
    "X-CSRF-Token": r.body.data.csrf_token,
    Cookie: r.response.headers.get("set-cookie")!.split(";")[0],
  };
}
async function recipient() {
  return call(
    "dashboard/recipients",
    "POST",
    { email: "togar@example.test", name: "Mas Togar" },
    await session(),
  );
}

test("dump asli berisi 69 record per tabel, angka benar, timezone WIB dan tanpa alarm lama", () => {
  const dump = fs.readFileSync("examples/iot_binus.sql", "utf8"),
    records = parseLegacyDump(dump, "fixture");
  for (const kind of ["dht", "pir", "mq"])
    assert.equal(records.filter((r) => r.kind === kind).length, 69);
  assert.equal(records[0].measured_at, "2026-10-25T07:55:13.000Z");
  assert.equal(records[0].suhu, 31.8);
  saveRecords(records, { live: false });
  const result = summary();
  assert.equal(result.counts.dht, 69);
  assert.equal(result.online, false);
  assert.equal(result.latest.dht?.suhu, 30.9);
  assert.equal(result.latest.pir?.lamp_on, null);
  assert.equal(result.incidents.length, 0);
  assert.equal(saveRecords(records, { live: false }).duplicates, 207);
});
test("API key dan Origin menolak klien yang tidak valid", async () => {
  assert.equal(
    (
      await call("device/telemetry", "POST", telemetry(), {
        "X-API-Key": "wrong",
      })
    ).response.status,
    401,
  );
  assert.equal(
    (
      await call("device/config", "GET", undefined, {
        Origin: "http://localhost:3000",
      })
    ).response.status,
    403,
  );
});
test("telemetri menyimpan 3 record, retry idempoten, konflik rollback atomik", async () => {
  const b = telemetry();
  assert.equal(
    (await call("device/telemetry", "POST", b)).response.status,
    201,
  );
  assert.equal(
    (await call("device/telemetry", "POST", b)).body.data.duplicates,
    3,
  );
  assert.equal(
    (await call("device/telemetry", "POST", { ...b, mq: { status: 1 } }))
      .response.status,
    409,
  );
  assert.equal(
    one<{ n: number }>("SELECT COUNT(*) n FROM sensor_records")!.n,
    3,
  );
});
test("sensor error null, boolean bukan angka string, future timestamp dan field tambahan divalidasi", async () => {
  const bad = telemetry(0, {
    dht: { suhu: null, kelembapan: 67, status: 1, error_code: null },
  });
  assert.equal(
    (await call("device/telemetry", "POST", bad)).response.status,
    422,
  );
  assert.equal(
    (
      await call(
        "device/telemetry",
        "POST",
        telemetry(0, { mq: { status: "1" } }),
      )
    ).response.status,
    422,
  );
  assert.equal(
    (
      await call(
        "device/telemetry",
        "POST",
        telemetry(0, {
          measured_at: new Date(Date.now() + 60000).toISOString(),
        }),
      )
    ).response.status,
    422,
  );
  assert.equal(
    (
      await call("device/telemetry", "POST", {
        ...telemetry(),
        device_id: "extra",
      })
    ).response.status,
    422,
  );
  const valid = telemetry(0, {
    dht: { suhu: null, kelembapan: null, status: 1, error_code: "DHT_FAILED" },
  });
  assert.equal(
    (await call("device/telemetry", "POST", valid)).response.status,
    201,
  );
  assert.equal(summary().latest.dht?.suhu, null);
});
test("data usang, GET dan heartbeat tidak menyatakan sensor normal", async () => {
  assert.equal(summary().online, false);
  await call(
    "device/telemetry",
    "POST",
    telemetry(0, { measured_at: new Date(Date.now() - 120000).toISOString() }),
  );
  assert.equal(summary().online, true);
  assert.equal(summary().stale.dht, true);
  await call("device/heartbeat", "POST", {
    heartbeat_id: randomUUID(),
    reported_at: new Date().toISOString(),
  });
  assert.equal(summary().stale.mq, true);
  assert.equal(summary().applied_config_version, 0);
});
test("data terlambat tidak mengganti nilai sensor terbaru", async () => {
  await call("device/telemetry", "POST", telemetry());
  await call(
    "device/telemetry",
    "POST",
    telemetry(1, {
      measured_at: new Date(Date.now() - 300000).toISOString(),
      dht: { suhu: 20, kelembapan: 40, status: 0, error_code: null },
    }),
  );
  assert.equal(summary().latest.dht?.suhu, 31.2);
  assert.equal(summary().latest.mq?.status, 0);
  assert.equal(summary().incidents.length, 0);
});
test("mutasi dashboard butuh CSRF, email dideduplikasi dan bisa dinonaktifkan", async () => {
  assert.equal(
    (
      await call("dashboard/recipients", "POST", {
        email: "togar@example.test",
      })
    ).response.status,
    403,
  );
  assert.equal((await recipient()).response.status, 201);
  assert.equal((await recipient()).response.status, 409);
  const id = rows<{ id: number }>("SELECT id FROM email_recipients")[0].id;
  assert.equal(
    (
      await call(
        `dashboard/recipients/${id}`,
        "DELETE",
        undefined,
        await session(),
      )
    ).response.status,
    200,
  );
  assert.equal(summary().email.recipients, 0);
});
test("satu episode asap satu insiden/email, reset asap membentuk episode baru", async () => {
  await recipient();
  await call("device/telemetry", "POST", telemetry(1));
  await call("device/telemetry", "POST", telemetry(1));
  assert.equal(rows("SELECT * FROM smoke_incidents").length, 1);
  assert.equal(rows("SELECT * FROM email_outbox").length, 1);
  await new Promise((r) => setTimeout(r, 4));
  await call("device/telemetry", "POST", telemetry(0));
  await new Promise((r) => setTimeout(r, 4));
  await call("device/telemetry", "POST", telemetry(1));
  assert.equal(rows("SELECT * FROM smoke_incidents").length, 2);
  assert.equal(rows("SELECT * FROM email_outbox").length, 2);
});
test("tanpa SMTP tetap pending dan tidak mengklaim email berhasil", async () => {
  await recipient();
  await call("device/telemetry", "POST", telemetry(1));
  assert.equal(await deliverPendingEmails(), 0);
  assert.equal(
    one<{ status: string }>("SELECT status FROM email_outbox")!.status,
    "pending",
  );
});
test("pengiriman email nyata ke server SMTP lokal dan tidak diulang", async () => {
  let received = "";
  const smtp = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, done) {
      stream.on("data", (chunk) => (received += chunk.toString()));
      stream.on("end", () => done());
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  try {
    const address = smtp.server.address();
    assert.ok(address && typeof address === "object");
    Object.assign(process.env, {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(address.port),
      SMTP_FROM: "lab@example.test",
      SMTP_SECURE: "false",
      SMTP_REQUIRE_TLS: "false",
    });
    delete process.env.SMTP_USER;
    await recipient();
    await call("device/telemetry", "POST", telemetry(1));
    assert.equal(await deliverPendingEmails(), 1);
    assert.match(received, /togar@example.test/);
    assert.equal(
      one<{ status: string }>("SELECT status FROM email_outbox")!.status,
      "sent",
    );
    assert.equal(await deliverPendingEmails(), 0);
  } finally {
    await new Promise<void>((resolve) => smtp.close(resolve));
  }
});
test("worker restart tidak menggandakan pengiriman yang hasilnya ambigu", async () => {
  await recipient();
  await call("device/telemetry", "POST", telemetry(1));
  execute("UPDATE email_outbox SET status='sending'");
  recoverSendingEmails();
  assert.equal(
    one<{ status: string }>("SELECT status FROM email_outbox")!.status,
    "unknown",
  );
  assert.equal(await deliverPendingEmails(), 0);
});
test("histori punya filter sensor, tanggal WIB dan pagination", async () => {
  saveRecords(
    parseLegacyDump(
      fs.readFileSync("examples/iot_binus.sql", "utf8"),
      "fixture",
    ),
    { live: false },
  );
  const first = await call(
    "dashboard/history?kind=pir&from=2026-10-25&to=2026-10-25&page=2&page_size=10",
  );
  assert.equal(first.body.data.total, 69);
  assert.equal(first.body.data.items.length, 10);
  assert.equal(first.body.data.page, 2);
  assert.equal(
    (await call("dashboard/history?from=2026-10-26&to=2026-10-25")).response
      .status,
    422,
  );
  assert.equal(
    (await call("dashboard/history?kind=nope")).response.status,
    422,
  );
});
test("konfigurasi optimistis dan ACK eksplisit; mode MySQL menolak mutasi balik", async () => {
  const auth = await session();
  assert.equal(
    (
      await call(
        "dashboard/settings",
        "PUT",
        { expected_version: 1, fan_on_c: 32, fan_off_c: 30 },
        auth,
      )
    ).response.status,
    200,
  );
  assert.equal(currentConfig().version, 2);
  assert.equal(summary().applied_config_version, 0);
  assert.equal(
    (
      await call(
        "dashboard/settings",
        "PUT",
        { expected_version: 1, fan_on_c: 32, fan_off_c: 30 },
        auth,
      )
    ).response.status,
    409,
  );
  assert.equal(
    (await call("device/config/ack", "POST", { version: 3 })).response.status,
    422,
  );
  await call("device/config/ack", "POST", { version: 2 });
  assert.equal(summary().applied_config_version, 2);
  process.env.DATA_SOURCE = "mysql";
  assert.equal(
    (await call("device/telemetry", "POST", telemetry())).response.status,
    409,
  );
  assert.equal(
    (
      await call(
        "dashboard/settings",
        "PUT",
        { expected_version: 2, fan_on_c: 32, fan_off_c: 30 },
        auth,
      )
    ).response.status,
    409,
  );
});
test("adapter MySQL mempertahankan fan status, PIR null, dan menolak status tidak dikenal", () => {
  const row = adaptLegacyRow(
    "dht",
    {
      id: 1,
      suhu: "31.8",
      kelembapan: "65.0",
      status: 1,
      create_date: "2026-10-25 14:55:13",
    },
    "mysql",
    "mysql-test",
  );
  assert.equal(row.status, 1);
  assert.equal(row.suhu, 31.8);
  assert.equal(row.measured_at, "2026-10-25T07:55:13.000Z");
  assert.equal(
    adaptLegacyRow(
      "pir",
      { id: 1, status: null, create_date: "2026-10-25 14:55:13" },
      "mysql",
      "test",
    ).lamp_on,
    null,
  );
  assert.throws(() =>
    adaptLegacyRow(
      "mq",
      { id: 1, status: 2, create_date: "2026-10-25 14:55:13" },
      "mysql",
      "test",
    ),
  );
});
