import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SMTPServer } from "smtp-server";
import type {
  MonitorConfig,
  MonitorSummary,
  Recipient,
  SensorRecord,
  SmokeIncident,
} from "../src/lib/monitoring-types";

/**
 * HTTP produksi sungguhan, tetapi seluruh state berada di direktori sementara.
 * Tidak memakai server port 3000, kredensial pengguna, MySQL live, atau browser.
 * Jalankan npm run build terlebih dahulu, lalu npm run test:e2e.
 */
const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const tempPrefix = "kelapa-monitor-http-e2e-";
const secrets: string[] = [];
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}
interface OwnedProcess {
  name: string;
  child: ChildProcess;
  output: string;
  result: Promise<ProcessResult>;
}
interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}
interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
interface Telemetry {
  sample_id: string;
  measured_at: string;
  dht: {
    suhu: number | null;
    kelembapan: number | null;
    status: 0 | 1 | null;
    error_code: string | null;
  };
  pir: { status: 0 | 1 | null; lamp_on?: boolean | null };
  mq: { status: 0 | 1 | null };
}

function safeText(value: unknown, limit = 6000) {
  let result = String(value);
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result.slice(-limit);
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: timeout ${milliseconds} ms.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function freePort() {
  const probe = createServer();
  try {
    probe.listen(0, "127.0.0.1");
    await within(once(probe, "listening"), 5000, "Reservasi port");
    const address = probe.address();
    assert.ok(address && typeof address === "object");
    return address.port;
  } finally {
    if (probe.listening)
      await new Promise<void>((done, reject) =>
        probe.close((error) => (error ? reject(error) : done())),
      );
  }
}

function isStopped(process: OwnedProcess) {
  return (
    process.child.exitCode !== null ||
    process.child.signalCode !== null ||
    !process.child.pid
  );
}

/** Hanya hentikan ChildProcess yang dibuat harness ini, tanpa pkill/taskkill global. */
async function stopOwned(process: OwnedProcess | undefined) {
  if (!process || isStopped(process)) return;
  process.child.kill("SIGTERM");
  try {
    await within(process.result, 5000, `Berhenti ${process.name}`);
  } catch {
    if (!isStopped(process)) process.child.kill("SIGKILL");
    await within(process.result, 5000, `Paksa berhenti ${process.name}`);
  }
}

/** Cek realpath dan parent sebelum recursive cleanup, khususnya di Windows. */
async function removeOwnedTemp(dataDir: string) {
  const root = await realpath(tmpdir());
  const target = await realpath(dataDir);
  const normalize = (value: string) =>
    process.platform === "win32"
      ? resolve(value).toLowerCase()
      : resolve(value);
  assert.equal(
    normalize(dirname(target)),
    normalize(root),
    "Cleanup di luar OS temp ditolak.",
  );
  assert.ok(
    basename(target).startsWith(tempPrefix),
    "Prefix cleanup tidak sesuai.",
  );
  assert.equal(
    normalize(target),
    normalize(dataDir),
    "Cleanup symlink/target lain ditolak.",
  );
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 250,
  });
}

async function main() {
  try {
    await access(join(projectRoot, ".next", "BUILD_ID"));
  } catch {
    throw new Error(
      "Build produksi belum tersedia. Jalankan npm run build terlebih dahulu.",
    );
  }

  const port = await freePort();
  const dataDir = await mkdtemp(join(await realpath(tmpdir()), tempPrefix));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deviceKey = randomBytes(32).toString("hex");
  const csrfSecret = randomBytes(32).toString("hex");
  secrets.push(deviceKey, csrfSecret);
  // Nilai kosong sengaja menimpa .env.local: dotenv tidak boleh mengisi kredensial nyata.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    APP_MODE: "simulation",
    DATA_SOURCE: "api",
    DATA_DIR: dataDir,
    DEVICE_ID: "kelapa-monitor-e2e",
    DEVICE_API_KEY: deviceKey,
    CSRF_SECRET: csrfSecret,
    ALLOWED_ORIGINS: baseUrl,
    BASE_URL: baseUrl,
    DASHBOARD_POLL_SECONDS: "300",
    OFFLINE_AFTER_SECONDS: "30",
    SENSOR_STALE_SECONDS: "30",
    MYSQL_HOST: "127.0.0.1",
    MYSQL_PORT: "3306",
    MYSQL_DATABASE: "unused_e2e_database",
    MYSQL_USER: "",
    MYSQL_PASSWORD: "",
    MYSQL_TIME_ZONE: "+07:00",
    MYSQL_SSL: "false",
    SMTP_HOST: "",
    SMTP_PORT: "587",
    SMTP_FROM: "",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    SMTP_SECURE: "false",
    SMTP_REQUIRE_TLS: "true",
  };
  const children = new Set<OwnedProcess>();
  const passed: string[] = [];
  let server: OwnedProcess | undefined;
  let smtp: SMTPServer | undefined;
  let smtpFailure: Error | undefined;
  let cookie = "";
  let csrf = "";
  let measurementClock = Date.now() - 1;
  const captured: string[] = [];
  let smtpAttempts = 0;
  let smtpMode: "accept" | "temporary-rejection" = "accept";

  function check(label: string) {
    passed.push(label);
    console.log(`PASS ${label}`);
  }

  function launch(
    name: string,
    args: string[],
    overrides: Partial<NodeJS.ProcessEnv> = {},
  ) {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...env, ...overrides },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owned: OwnedProcess = {
      name,
      child,
      output: "",
      result: new Promise<ProcessResult>((done) => {
        child.once("error", (error) =>
          done({ code: null, signal: null, error }),
        );
        child.once("exit", (code, signal) => done({ code, signal }));
      }),
    };
    children.add(owned);
    const log = (chunk: Buffer) => {
      owned.output = (owned.output + chunk.toString("utf8")).slice(-12000);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    return owned;
  }

  async function runScript(
    script: string,
    args: string[] = [],
    overrides: Partial<NodeJS.ProcessEnv> = {},
  ) {
    const child = launch(
      script,
      ["--import", "tsx", script, ...args],
      overrides,
    );
    try {
      const result = await within(child.result, 35_000, script);
      assert.equal(
        result.code,
        0,
        `${script} gagal (${result.error?.message || result.signal || result.code}).\n${safeText(child.output)}`,
      );
      return child.output;
    } finally {
      await stopOwned(child);
      children.delete(child);
    }
  }

  async function start(overrides: Partial<NodeJS.ProcessEnv> = {}) {
    server = launch(
      "Next produksi",
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      overrides,
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (isStopped(server))
        throw new Error(
          `Server berhenti sebelum siap.\n${safeText(server.output)}`,
        );
      try {
        const response = await fetch(`${baseUrl}/api/v2/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          const body = (await response.json()) as Envelope<{
            mode: string;
            version: number;
          }>;
          assert.equal(body.data?.version, 2);
          assert.equal(body.data?.mode, overrides.APP_MODE || "simulation");
          return;
        }
      } catch {
        // Readiness hanya GET. Tidak ada retry otomatis terhadap mutasi.
      }
      await pause(150);
    }
    throw new Error(
      `Server tidak siap dalam 30 detik.\n${safeText(server.output)}`,
    );
  }

  async function stopServer() {
    const previous = server;
    await stopOwned(previous);
    if (previous) children.delete(previous);
    server = undefined;
  }

  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      expected?: number;
    } = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json()) as Envelope<T>;
    assert.equal(
      response.status,
      options.expected ?? 200,
      `${options.method || "GET"} ${path}: HTTP ${response.status}, code ${body.error?.code || "none"}`,
    );
    return { response, body };
  }

  const deviceHeaders = {
    "X-Device-ID": env.DEVICE_ID!,
    "X-API-Key": deviceKey,
  };
  function device<T>(path: string, body?: unknown, expected = 200) {
    return request<T>("/api/v2/device/" + path, {
      method: body === undefined ? "GET" : "POST",
      body,
      expected,
      headers: deviceHeaders,
    });
  }
  async function dashboard<T>(path: string) {
    const result = await request<T>("/api/v2/dashboard/" + path);
    assert.ok(
      result.body.data !== undefined,
      "Respons dashboard tidak mempunyai data.",
    );
    return result.body.data;
  }
  function mutation<T>(
    path: string,
    method: string,
    body?: unknown,
    expected = 200,
  ) {
    return request<T>("/api/v2/dashboard/" + path, {
      method,
      body,
      expected,
      headers: { Origin: baseUrl, Cookie: cookie, "X-CSRF-Token": csrf },
    });
  }
  async function session() {
    const result = await request<{ csrf_token: string }>(
      "/api/v2/dashboard/session",
    );
    const setCookie = result.response.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    cookie = setCookie.split(";")[0];
    csrf = result.body.data!.csrf_token;
    secrets.push(cookie, csrf);
  }
  const summary = () => dashboard<MonitorSummary>("summary");
  const incidents = () =>
    dashboard<Page<SmokeIncident>>("alerts?page_size=100");

  function telemetry(
    mq: 0 | 1 = 0,
    overrides: Partial<Telemetry> = {},
  ): Telemetry {
    measurementClock = Math.max(Date.now(), measurementClock + 1);
    return {
      sample_id: randomUUID(),
      measured_at: new Date(measurementClock).toISOString(),
      dht: { suhu: 31.2, kelembapan: 67, status: 1, error_code: null },
      pir: { status: 1, lamp_on: true },
      mq: { status: mq },
      ...overrides,
    };
  }

  try {
    // Gunakan parser/import child asli; tidak memasukkan fixture langsung melalui SQL.
    await runScript("scripts/import-sql.ts", ["examples/iot_binus.sql"]);
    await start();
    const health = await request<{
      status: string;
      mode: string;
      data_source: string;
    }>("/api/v2/health");
    assert.equal(health.body.data?.status, "ok");
    assert.equal(health.body.data?.data_source, "api");
    const html = await fetch(baseUrl, { signal: AbortSignal.timeout(8000) });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Smart Server Room/);
    check("Next produksi dan API v2 berjalan di loopback terisolasi");

    let state = await summary();
    assert.deepEqual(
      [state.counts.dht, state.counts.pir, state.counts.mq],
      [69, 69, 69],
    );
    assert.equal(state.counts.dht + state.counts.pir + state.counts.mq, 207);
    assert.equal(state.latest.dht?.suhu, 30.9);
    assert.equal(state.latest.dht?.kelembapan, 68.1);
    assert.equal(state.latest.dht?.status, 0);
    assert.equal(state.latest.pir?.lamp_on, null);
    assert.equal(state.online, false);
    assert.deepEqual(state.stale, { dht: true, pir: true, mq: true });
    assert.equal(state.dashboard_poll_seconds, 300);
    assert.equal(state.incidents.length, 0);
    assert.equal(state.email.configured, false);
    assert.deepEqual(state.source_counts, [
      { source: "sql_import", total: 207 },
    ]);
    check(
      "arsip asli 207 record, stale/offline, LED belum dilaporkan, refresh 300 detik",
    );

    await runScript("scripts/import-sql.ts", ["examples/iot_binus.sql"]);
    state = await summary();
    assert.deepEqual(
      [state.counts.dht, state.counts.pir, state.counts.mq],
      [69, 69, 69],
    );
    assert.equal(state.incidents.length, 0);
    check(
      "import SQL asli berulang tidak menggandakan histori atau mengirim alarm",
    );

    await request("/api/v2/device/config", { expected: 401 });
    await request("/api/v2/device/config", {
      expected: 401,
      headers: { ...deviceHeaders, "X-API-Key": "invalid-test-key" },
    });
    await request("/api/v2/device/config", {
      expected: 403,
      headers: { ...deviceHeaders, Origin: baseUrl },
    });
    const retiredGet = await request("/api/v1/health", { expected: 410 });
    assert.equal(retiredGet.body.error?.code, "API_RETIRED");
    const retiredPost = await request("/api/v1/dashboard/commands", {
      method: "POST",
      body: { type: "unlock", command_id: randomUUID() },
      expected: 410,
    });
    assert.equal(retiredPost.body.error?.code, "API_RETIRED");
    check("auth perangkat dan Origin ditolak; endpoint v1 telah dipensiunkan");

    await device("heartbeat", {
      heartbeat_id: randomUUID(),
      reported_at: new Date().toISOString(),
    });
    state = await summary();
    assert.equal(state.online, true);
    assert.deepEqual(state.stale, { dht: true, pir: true, mq: true });
    assert.equal(state.applied_config_version, 0);
    check(
      "heartbeat menyatakan kontak, bukan sensor segar atau ACK konfigurasi",
    );

    const recipientBody = {
      email: "togar-e2e@example.test",
      name: "Penerima uji lokal",
    };
    await request("/api/v2/dashboard/recipients", {
      method: "POST",
      body: recipientBody,
      headers: { Origin: baseUrl },
      expected: 403,
    });
    await session();
    await request("/api/v2/dashboard/recipients", {
      method: "POST",
      body: recipientBody,
      headers: {
        Origin: "http://invalid.example.test",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
      expected: 403,
    });
    await mutation("recipients", "POST", recipientBody, 201);
    await mutation(
      "recipients",
      "POST",
      { ...recipientBody, email: "TOGAR-E2E@EXAMPLE.TEST" },
      409,
    );
    const recipient = (await dashboard<Recipient[]>("recipients")).find(
      (row) => row.email === recipientBody.email,
    );
    assert.ok(recipient);
    await mutation(`recipients/${recipient.id}`, "DELETE");
    assert.equal((await summary()).email.recipients, 0);
    await mutation("recipients", "POST", recipientBody, 201);
    assert.equal((await summary()).email.recipients, 1);
    check("CSRF/Origin, deduplikasi email, nonaktifkan dan aktifkan penerima");

    const normal = telemetry();
    const created = await device<{ inserted: number; duplicates: number }>(
      "telemetry",
      normal,
      201,
    );
    assert.equal(created.body.data?.inserted, 3);
    const retry = await device<{ inserted: number; duplicates: number }>(
      "telemetry",
      normal,
    );
    assert.equal(retry.body.data?.inserted, 0);
    assert.equal(retry.body.data?.duplicates, 3);
    const conflict = await device(
      "telemetry",
      { ...normal, mq: { status: 1 } },
      409,
    );
    assert.equal(conflict.body.error?.code, "ID_CONFLICT");
    state = await summary();
    assert.deepEqual(
      [state.counts.dht, state.counts.pir, state.counts.mq],
      [70, 70, 70],
    );
    assert.equal(state.latest.dht?.source_id, normal.sample_id);
    assert.equal(state.latest.pir?.lamp_on, 1);
    assert.equal(state.incidents.length, 0);
    check(
      "telemetri HTTP menyimpan tiga record; retry idempoten dan konflik atomik",
    );

    await device(
      "telemetry",
      {
        ...telemetry(),
        dht: { suhu: null, kelembapan: 67, status: 1, error_code: null },
      },
      422,
    );
    await device("telemetry", { ...telemetry(), mq: { status: "1" } }, 422);
    await device(
      "telemetry",
      {
        ...telemetry(),
        measured_at: new Date(Date.now() + 60_000).toISOString(),
      },
      422,
    );
    await device("telemetry", { ...telemetry(), unexpected_field: true }, 422);
    assert.equal((await summary()).counts.dht, 70);
    check(
      "validasi menolak null parsial, status string, waktu masa depan, dan field tambahan",
    );

    const late = telemetry(0, {
      measured_at: new Date(Date.now() - 120_000).toISOString(),
      dht: { suhu: 20, kelembapan: 40, status: 0, error_code: null },
    });
    await device("telemetry", late, 201);
    state = await summary();
    assert.equal(state.latest.dht?.source_id, normal.sample_id);
    const simulatorHistory = await dashboard<Page<SensorRecord>>(
      "history?source=simulator&page_size=100",
    );
    assert.ok(
      simulatorHistory.items.some(
        (record) => record.source_id === late.sample_id,
      ),
    );
    check("data terlambat masuk histori tanpa mengganti pembacaan terbaru");

    const sensorError = telemetry(0, {
      dht: {
        suhu: null,
        kelembapan: null,
        status: 1,
        error_code: "DHT_TEST_FAILURE",
      },
      pir: { status: null, lamp_on: null },
      mq: { status: null },
    });
    await device("telemetry", sensorError, 201);
    state = await summary();
    assert.equal(state.latest.dht?.suhu, null);
    assert.equal(state.latest.dht?.kelembapan, null);
    assert.equal(state.latest.dht?.error_code, "DHT_TEST_FAILURE");
    assert.equal(state.latest.pir?.status, null);
    assert.equal(state.latest.mq?.status, null);
    assert.equal(state.online, true);
    await device("telemetry", telemetry(), 201);
    check("sensor gagal tetap null dengan kode error, bukan angka nol");

    const current = (await device<MonitorConfig>("config")).body.data!;
    const update = {
      expected_version: current.version,
      fan_on_c: 32,
      fan_off_c: 30,
    };
    const changed = (await mutation<MonitorConfig>("settings", "PUT", update))
      .body.data!;
    assert.equal(changed.version, current.version + 1);
    assert.equal((await summary()).applied_config_version, 0);
    await mutation("settings", "PUT", update, 409);
    await device("config/ack", { version: changed.version + 1 }, 422);
    await device("heartbeat", {
      heartbeat_id: randomUUID(),
      reported_at: new Date().toISOString(),
    });
    assert.equal((await summary()).applied_config_version, 0);
    await device("config/ack", { version: changed.version });
    await device("config/ack", { version: current.version });
    assert.equal((await summary()).applied_config_version, changed.version);
    check(
      "versi konfigurasi optimistis dan ACK eksplisit tidak diturunkan oleh ACK lama",
    );

    const archiveFilter =
      "history?kind=pir&source=sql_import&from=2026-10-25&to=2026-10-25&page_size=10";
    const firstPage = await dashboard<Page<SensorRecord>>(
      archiveFilter + "&page=1",
    );
    const secondPage = await dashboard<Page<SensorRecord>>(
      archiveFilter + "&page=2",
    );
    assert.equal(firstPage.total, 69);
    assert.equal(secondPage.total, 69);
    assert.equal(firstPage.items.length, 10);
    assert.equal(secondPage.items.length, 10);
    assert.equal(secondPage.page, 2);
    assert.ok(
      !firstPage.items.some((first) =>
        secondPage.items.some(
          (second) => first.record_key === second.record_key,
        ),
      ),
    );
    assert.ok(
      firstPage.items.every(
        (row) => row.kind === "pir" && row.source === "sql_import",
      ),
    );
    const wrongDay = await dashboard<Page<SensorRecord>>(
      "history?source=sql_import&from=2026-10-26&to=2026-10-26",
    );
    assert.equal(wrongDay.total, 0);
    await request("/api/v2/dashboard/history?from=2026-10-26&to=2026-10-25", {
      expected: 422,
    });
    await request("/api/v2/dashboard/history?kind=invalid", { expected: 422 });
    check("filter sensor/sumber/tanggal WIB dan pagination lewat HTTP");

    await device("telemetry", telemetry(1), 201);
    await device("telemetry", telemetry(1), 201);
    let alarms = await incidents();
    assert.equal(alarms.total, 1);
    assert.equal(alarms.items[0].emails.length, 1);
    assert.equal(alarms.items[0].emails[0].status, "pending");
    await runScript("scripts/monitor-worker.ts", ["--once"]);
    alarms = await incidents();
    assert.equal(alarms.items[0].emails[0].status, "pending");
    assert.ok((await summary()).email.worker_last_seen);
    check(
      "satu periode MQ membentuk satu insiden/outbox; tanpa SMTP tetap pending",
    );

    smtp = new SMTPServer({
      disabledCommands: ["AUTH", "STARTTLS"],
      authOptional: true,
      logger: false,
      onData(stream, _session, done) {
        let message = "";
        stream.on("data", (chunk: Buffer) => {
          message = (message + chunk.toString("utf8")).slice(-200_000);
        });
        stream.once("error", done);
        stream.on("end", () => {
          smtpAttempts++;
          if (smtpMode === "temporary-rejection") {
            const error = Object.assign(
              new Error("Temporary E2E SMTP rejection"),
              { responseCode: 451 },
            );
            done(error);
          } else {
            captured.push(message);
            done();
          }
        });
      },
    });
    smtp.on("error", (error: Error) => {
      smtpFailure = error;
    });
    await within(
      new Promise<void>((done) => smtp!.listen(0, "127.0.0.1", done)),
      5000,
      "SMTP lokal",
    );
    const smtpAddress = smtp.server.address();
    assert.ok(smtpAddress && typeof smtpAddress === "object");
    const localSmtp: Partial<NodeJS.ProcessEnv> = {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtpAddress.port),
      SMTP_FROM: "smart-room-e2e@example.test",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      SMTP_SECURE: "false",
      SMTP_REQUIRE_TLS: "false", // Hanya fixture loopback milik harness, bukan SMTP eksternal.
    };
    await runScript("scripts/monitor-worker.ts", ["--once"], localSmtp);
    assert.equal(smtpFailure, undefined);
    assert.equal(captured.length, 1);
    assert.match(captured[0], /togar-e2e@example\.test/i);
    assert.match(captured[0], /Smart Server Room/i);
    alarms = await incidents();
    assert.equal(alarms.items[0].emails[0].status, "sent");
    assert.match(
      alarms.items[0].emails[0].detail || "",
      /inbox belum dapat dipastikan/i,
    );
    await runScript("scripts/monitor-worker.ts", ["--once"], localSmtp);
    assert.equal(captured.length, 1);
    assert.equal(smtpAttempts, 1);
    check(
      "worker --once mengirim ke SMTP loopback sungguhan, tanpa browser atau duplikasi",
    );

    await device("telemetry", telemetry(0), 201);
    await device("telemetry", telemetry(1), 201);
    alarms = await incidents();
    assert.equal(alarms.total, 2);
    assert.equal(
      alarms.items.filter((incident) => incident.resolved_at !== null).length,
      1,
    );
    smtpMode = "temporary-rejection";
    await runScript("scripts/monitor-worker.ts", ["--once"], localSmtp);
    alarms = await incidents();
    const unknown = alarms.items.find((incident) =>
      incident.emails.some((mail) => mail.status === "unknown"),
    );
    assert.ok(unknown, "Kegagalan SMTP ambigu harus tersimpan unknown.");
    smtpMode = "accept";
    const attemptsBeforeRetry = smtpAttempts;
    await runScript("scripts/monitor-worker.ts", ["--once"], localSmtp);
    assert.equal(smtpAttempts, attemptsBeforeRetry);
    assert.equal(captured.length, 1);
    check(
      "episode asap baru terpisah; hasil SMTP unknown tidak dikirim ulang otomatis",
    );

    await device("telemetry", telemetry(0), 201);
    await device("telemetry", telemetry(1), 201);
    await device("telemetry", telemetry(0), 201);
    await runScript("scripts/monitor-worker.ts", ["--once"], localSmtp);
    alarms = await incidents();
    assert.equal(alarms.total, 3);
    assert.ok(
      alarms.items.some(
        (incident) =>
          incident.resolved_at &&
          incident.emails.some((mail) => mail.status === "sent"),
      ),
    );
    assert.equal(captured.length, 2);
    check("insiden baru yang sudah berakhir tetap diberitahukan oleh worker");

    const beforeRestart = await summary();
    const historyCount = (await dashboard<Page<SensorRecord>>("history")).total;
    const incidentSnapshot = (await incidents()).items;
    await stopServer();
    await start();
    await session();
    const afterRestart = await summary();
    assert.deepEqual(afterRestart.counts, beforeRestart.counts);
    assert.deepEqual(afterRestart.config, beforeRestart.config);
    assert.equal(afterRestart.applied_config_version, changed.version);
    assert.equal(afterRestart.email.recipients, 1);
    assert.equal(afterRestart.dashboard_poll_seconds, 300);
    assert.equal(
      (await dashboard<Page<SensorRecord>>("history")).total,
      historyCount,
    );
    assert.deepEqual((await incidents()).items, incidentSnapshot);
    check(
      "histori, penerima, konfigurasi, ACK dan hasil email bertahan setelah restart",
    );

    // Hanya uji guard sumber, tidak membuat koneksi ke MySQL eksternal.
    await stopServer();
    await start({ DATA_SOURCE: "mysql" });
    await session();
    assert.equal((await summary()).online, false);
    const sourceMismatch = await device("telemetry", telemetry(), 409);
    assert.equal(sourceMismatch.body.error?.code, "SOURCE_MISMATCH");
    const noWriteBack = await mutation(
      "settings",
      "PUT",
      {
        expected_version: changed.version,
        fan_on_c: 33,
        fan_off_c: 30,
      },
      409,
    );
    assert.equal(noWriteBack.body.error?.code, "MYSQL_LOCAL_CONFIG");
    check(
      "mode MySQL menolak telemetri API dan konfigurasi balik tanpa menyentuh MySQL live",
    );

    await stopServer();
    await start({ APP_MODE: "real" });
    state = await summary();
    assert.equal(state.mode, "real");
    assert.equal(state.counts.dht + state.counts.pir + state.counts.mq, 0);
    assert.equal(state.email.recipients, 0);
    assert.equal(state.incidents.length, 0);
    check(
      "mode real memakai database terpisah dari arsip dan fixture simulasi",
    );

    console.log(
      `\n${passed.length} pemeriksaan HTTP produksi lulus. SMTP diuji hanya pada server loopback lokal.`,
    );
    console.log(
      "MySQL live Mas Togar, SMTP eksternal, inbox penerima, browser visual, dan hardware fisik belum diuji.",
    );
  } catch (error) {
    if (server?.output)
      console.error("Tail server uji:\n" + safeText(server.output));
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    for (const child of children) {
      try {
        await stopOwned(child);
      } catch (error) {
        cleanupErrors.push(safeText(error, 1000));
      }
    }
    if (smtp) {
      try {
        await within(
          new Promise<void>((done) => smtp!.close(done)),
          5000,
          "Tutup SMTP lokal",
        );
      } catch (error) {
        cleanupErrors.push(safeText(error, 1000));
      }
    }
    // Jangan hapus database sementara jika child sendiri belum berhasil dihentikan.
    if (cleanupErrors.length)
      throw new Error(
        "Cleanup belum selesai; direktori sementara dipertahankan. " +
          cleanupErrors.join(" | "),
      );
    await removeOwnedTemp(dataDir);
  }
}

main().catch((error: unknown) => {
  console.error(
    safeText(error instanceof Error ? error.stack || error.message : error),
  );
  process.exitCode = 1;
});
