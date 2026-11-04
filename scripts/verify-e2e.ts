import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, access as fileAccess } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { Command, Configuration, Summary } from "../src/lib/contracts";

// Uses an isolated server, SQLite directory, API key and simulator ledger.
// No writes are made to the user's .env.local or data directory.
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function main() {
  try {
    await fileAccess(".next/BUILD_ID");
  } catch {
    throw new Error("Jalankan npm run build sebelum npm run test:e2e.");
  }
  const dataDir = await mkdtemp(join(tmpdir(), "kelapa-http-e2e-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    APP_MODE: "simulation",
    DATA_DIR: dataDir,
    DEVICE_ID: "kelapa-e2e-device",
    DEVICE_API_KEY: randomBytes(32).toString("hex"),
    CSRF_SECRET: randomBytes(32).toString("hex"),
    ALLOWED_ORIGINS: baseUrl,
    BASE_URL: baseUrl,
    UNLOCK_TTL_SECONDS: "3",
    RESULT_GRACE_SECONDS: "1",
  };
  let server: ChildProcess | undefined;
  let serverLog = "";
  let cookie = "";
  let csrf = "";
  let passed = 0;
  function check(label: string) {
    passed++;
    console.log(`PASS ${label}`);
  }

  async function start(mode: "simulation" | "real" = "simulation") {
    serverLog = "";
    server = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: { ...env, APP_MODE: mode },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout?.on("data", (chunk) => {
      serverLog = (serverLog + chunk.toString()).slice(-12000);
    });
    server.stderr?.on("data", (chunk) => {
      serverLog = (serverLog + chunk.toString()).slice(-12000);
    });
    let spawnError: Error | undefined;
    server.on("error", (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError || server.exitCode !== null)
        throw new Error(`Server tidak berjalan: ${spawnError ?? serverLog}`);
      try {
        const response = await fetch(`${baseUrl}/api/v1/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          const payload = await response.json();
          assert.equal(payload.data.mode, mode);
          return;
        }
      } catch {
        /* Bound readiness wait; do not retry any actuator request. */
      }
      await pause(200);
    }
    throw new Error(`Server belum siap setelah 30 detik:\n${serverLog}`);
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([stopped, pause(5000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await stopped;
    }
    server = undefined;
  }
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${baseUrl}/api/v1/dashboard/${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        Origin: baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    assert.ok(
      response.ok,
      `${method} ${path}: HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
    return { data: payload.data, response };
  }
  async function session() {
    const result = await api("session");
    cookie = result.response.headers.get("set-cookie")!.split(";")[0];
    csrf = result.data.csrf_token;
  }
  async function config(overrides: Partial<Configuration>) {
    const current = (await api("config")).data.config as Configuration;
    return (
      await api("config", "PUT", {
        expected_version: current.version,
        fan_on_c: current.fan_on_c,
        fan_off_c: current.fan_off_c,
        fan_mode: current.fan_mode,
        unlock_duration_seconds: current.unlock_duration_seconds,
        ...overrides,
      })
    ).data;
  }
  async function simulator(scenario = "normal") {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/simulator.ts",
        "--once",
        "--access",
        "known-denied",
        "--scenario",
        scenario,
      ],
      {
        cwd: process.cwd(),
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [code] = await once(child, "exit");
      assert.equal(code, 0, `Simulator gagal:\n${output}`);
    } finally {
      clearTimeout(deadline);
    }
  }
  async function command(
    type: "unlock" | "set_fan",
    fanOn?: boolean,
  ): Promise<Command> {
    return (
      await api("commands", "POST", {
        command_id: randomUUID(),
        type,
        ...(fanOn === undefined ? {} : { fan_on: fanOn }),
      })
    ).data;
  }
  async function findCommand(id: string): Promise<Command> {
    const list = (await api("commands?page_size=100")).data.items as Command[];
    const item = list.find((c) => c.command_id === id);
    assert.ok(item);
    return item;
  }
  async function summary(): Promise<Summary> {
    return (await api("summary")).data;
  }

  try {
    await start();
    await session();
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Smart Server Room/);
    assert.equal((await summary()).today.total, 0);
    check("server produksi dan dashboard merespons, database awal kosong");

    await simulator();
    let s = await summary();
    assert.equal(s.mode, "simulation");
    assert.equal(s.online, true);
    assert.equal(s.sensor_failed, false);
    assert.equal(s.sensor_stale, false);
    assert.ok(s.latest_valid_reading);
    assert.equal(s.today.total, 1);
    assert.equal(s.today.denied, 1);
    assert.equal(s.recent_access[0].recognition, "known");
    assert.equal(s.recent_access[0].decision, "denied");
    assert.equal(s.config_synced, true);
    check("simulator → HTTP API → SQLite → data dashboard dan ACK konfigurasi");

    const beforeDuplicates = s.today.total;
    await simulator("duplicate");
    assert.equal((await summary()).today.total, beforeDuplicates + 1);
    check("retry simulator tidak menggandakan kejadian akses");

    await config({ fan_mode: "manual", unlock_duration_seconds: 1 });
    const manualOn = await command("set_fan", true);
    assert.equal(manualOn.status, "pending");
    await simulator();
    assert.equal((await findCommand(manualOn.command_id)).status, "succeeded");
    s = await summary();
    assert.equal(s.config_synced, true);
    assert.equal(s.device_status?.fan_on, true);
    assert.equal(s.device_status?.fan_mode, "manual");
    const manualOff = await command("set_fan", false);
    await simulator();
    assert.equal((await findCommand(manualOff.command_id)).status, "succeeded");
    assert.equal((await summary()).device_status?.fan_on, false);
    check(
      "mode manual, kipas ON/OFF, command receipt/result, dan status laporan perangkat",
    );

    await config({ fan_mode: "automatic", fan_on_c: 40, fan_off_c: 38 });
    await simulator();
    assert.equal((await summary()).device_status?.fan_on, false);
    await config({ fan_mode: "automatic", fan_on_c: 20, fan_off_c: 18 });
    await simulator();
    assert.equal((await summary()).device_status?.fan_on, true);
    check(
      "simulator menjalankan ambang otomatis melalui konfigurasi yang sama",
    );

    const unlock = await command("unlock");
    assert.equal(unlock.status, "pending");
    await simulator();
    assert.equal((await findCommand(unlock.command_id)).status, "succeeded");
    assert.equal((await summary()).device_status?.lock_state, "locked");
    check(
      "buka selama 1 detik, konfirmasi hasil, lalu laporan penguncian kembali",
    );

    const expiry = await command("unlock");
    await pause(Math.max(0, Date.parse(expiry.expires_at) - Date.now() + 150));
    await simulator();
    assert.equal((await findCommand(expiry.command_id)).status, "expired");
    check("perintah kedaluwarsa tidak dijalankan ketika simulator kembali");

    const uncertain = await command("unlock");
    await simulator("lost-confirmation");
    await pause(
      Math.max(0, Date.parse(uncertain.result_deadline) - Date.now() + 150),
    );
    assert.equal((await findCommand(uncertain.command_id)).status, "unknown");
    await simulator();
    assert.equal((await findCommand(uncertain.command_id)).status, "unknown");
    check(
      "konfirmasi hilang tetap hasil belum diketahui setelah simulator restart",
    );

    await simulator("sensor-error");
    s = await summary();
    assert.equal(s.online, true);
    assert.equal(s.sensor_failed, true);
    assert.equal(s.latest_reading?.temperature_c, null);
    assert.ok(s.latest_valid_reading);
    check("sensor gagal menyimpan null dan mempertahankan data valid terakhir");

    await simulator("late");
    s = await summary();
    const history = (await api("environment?hours=24&page_size=100")).data
      .readings;
    assert.ok(
      history.some(
        (r: { measured_at: string }) =>
          Date.parse(r.measured_at) <
          Date.parse(s.latest_reading!.measured_at) - 30_000,
      ),
    );
    assert.equal(s.sensor_failed, false);
    assert.equal(s.sensor_stale, false);
    check(
      "pembacaan terlambat tersedia di histori tanpa mengganti status terbaru",
    );

    const countBeforeRestart = (await api("access-events")).data.total;
    await stop();
    await start();
    await session();
    assert.equal((await api("access-events")).data.total, countBeforeRestart);
    assert.equal((await findCommand(uncertain.command_id)).status, "unknown");
    check("database dan hasil perintah bertahan setelah proses server restart");

    await stop();
    await start("real");
    await session();
    assert.equal((await api("access-events")).data.total, 0);
    assert.equal((await summary()).mode, "real");
    check("environment real memakai database terpisah dari simulation");
    console.log(
      `\n${passed} pemeriksaan HTTP end-to-end lulus. Hardware fisik belum diuji.`,
    );
  } finally {
    await stop();
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 250,
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
