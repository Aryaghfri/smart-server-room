import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Command, Configuration } from "../src/lib/contracts";

export type Scenario =
  | "normal"
  | "offline"
  | "sensor-error"
  | "duplicate"
  | "late"
  | "lost-confirmation";
export type AccessSample =
  "cycle" | "allowed" | "known-denied" | "unknown-denied";
export interface SimulatorOptions {
  baseUrl: string;
  deviceId: string;
  apiKey: string;
  statePath: string;
  scenario: Scenario;
  sensorSeconds: number;
  heartbeatSeconds: number;
  commandSeconds: number;
  configSeconds: number;
  accessSeconds: number;
  offlineSeconds: number;
  timeoutMs: number;
  retries: number;
  access: AccessSample;
}
interface ExecutionResult {
  status: "succeeded" | "failed";
  executed_at: string;
  message: string;
}
interface LedgerEntry {
  claimed_at: string;
  phase: "claimed" | "executing" | "finished" | "uncertain" | "reported";
  result?: ExecutionResult;
  suppress_result?: boolean;
}
interface PersistedState {
  format: 1;
  device_id: string;
  mode: "simulation";
  config: Configuration;
  fan_on: boolean;
  lock_state: "locked" | "unlocked";
  unlock_until: number | null;
  sequence: number;
  ledger: Record<string, LedgerEntry>;
}
interface Outgoing {
  endpoint: string;
  payload: Record<string, unknown>;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaults: Configuration = {
  version: 0,
  fan_on_c: 30,
  fan_off_c: 28,
  fan_mode: "automatic",
  unlock_duration_seconds: 5,
  updated_at: "1970-01-01T00:00:00.000Z",
};

/** Hardware behavior is simulated in this process; this is not firmware or a physical safety guarantee. */
export class Simulator {
  private state: PersistedState;
  private localTimer?: ReturnType<typeof setInterval>;
  private lockPath: string;
  private ownsLock = false;
  private running = false;
  private runActive = false;
  private outbox: Outgoing[] = [];
  private latestSample: {
    temperature: number | null;
    humidity: number | null;
  } = { temperature: null, humidity: null };
  private nextSensor = 0;
  private nextHeartbeat = 0;
  private nextAccess = 0;
  private startedAt = Date.now();
  private offlineUntil = 0;
  private offlineWasLogged = false;
  private localFailure: Error | null = null;
  private rateLimitedUntil = 0;

  constructor(readonly options: SimulatorOptions) {
    mkdirSync(dirname(options.statePath), { recursive: true });
    this.lockPath = `${options.statePath}.lock`;
    this.acquireLock();
    try {
      if (existsSync(options.statePath)) {
        const parsed = JSON.parse(
          readFileSync(options.statePath, "utf8"),
        ) as PersistedState;
        if (
          parsed.format !== 1 ||
          parsed.mode !== "simulation" ||
          parsed.device_id !== options.deviceId ||
          !parsed.ledger ||
          !parsed.config
        ) {
          throw new Error(
            "State simulator tidak cocok atau rusak. Periksa berkas; jangan hapus ledger ketika hasil perintah masih belum diketahui.",
          );
        }
        this.state = parsed;
      } else {
        this.state = {
          format: 1,
          device_id: options.deviceId,
          mode: "simulation",
          config: defaults,
          fan_on: true,
          lock_state: "locked",
          unlock_until: null,
          sequence: 0,
          ledger: {},
        };
      }
      // A crash between receipt and result is deliberately never replayed.
      for (const entry of Object.values(this.state.ledger)) {
        if (entry.phase === "claimed" || entry.phase === "executing")
          entry.phase = "uncertain";
      }
      this.state.lock_state = "locked";
      this.state.unlock_until = null;
      if (this.state.config.fan_mode === "automatic") this.state.fan_on = true;
      this.save();
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  private acquireLock() {
    if (existsSync(this.lockPath)) {
      const previousPid = Number(readFileSync(this.lockPath, "utf8"));
      if (!Number.isInteger(previousPid) || previousPid <= 0)
        throw new Error(`Lock simulator rusak: ${this.lockPath}`);
      let alive = true;
      try {
        process.kill(previousPid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive)
        throw new Error(
          "Simulator untuk perangkat ini sudah berjalan. Hentikan proses sebelumnya terlebih dahulu.",
        );
      unlinkSync(this.lockPath);
    }
    const descriptor = openSync(this.lockPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, String(process.pid));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.ownsLock = true;
  }
  private releaseLock() {
    if (this.ownsLock) {
      unlinkSync(this.lockPath);
      this.ownsLock = false;
    }
  }
  private save() {
    const temporary = `${this.options.statePath}.tmp`;
    const descriptor = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(this.state, null, 2));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.options.statePath);
  }
  private log(message: string) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  async request<T>(
    endpoint: string,
    method = "GET",
    payload?: unknown,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(
          `${this.options.baseUrl}/api/v1${endpoint}`,
          {
            method,
            headers: {
              "Content-Type": "application/json",
              "X-Device-ID": this.options.deviceId,
              "X-API-Key": this.options.apiKey,
            },
            body: payload === undefined ? undefined : JSON.stringify(payload),
            signal: AbortSignal.timeout(this.options.timeoutMs),
            redirect: "error",
          },
        );
        const envelope = (await response.json()) as {
          data?: T;
          error?: { code: string; message: string };
        };
        if (response.status === 429) {
          const retrySeconds = Number(
            response.headers.get("retry-after") ?? "60",
          );
          this.rateLimitedUntil =
            Date.now() +
            (Number.isFinite(retrySeconds)
              ? Math.max(1, Math.min(3600, retrySeconds))
              : 60) *
              1000;
        }
        if (!response.ok)
          throw new ApiError(
            response.status,
            envelope.error?.code ?? "HTTP_ERROR",
            envelope.error?.message ?? `HTTP ${response.status}`,
          );
        if (!("data" in envelope))
          throw new Error("Respons API tidak menggunakan envelope data.");
        return envelope.data as T;
      } catch (error) {
        const retryable = !(error instanceof ApiError) || error.status >= 500;
        if (!retryable || attempt >= this.options.retries) throw error;
        await sleep(250 * 2 ** attempt);
      }
    }
  }

  async verifyMode() {
    const health = await this.request<{ status: string; mode: string }>(
      "/health",
    );
    if (health.status !== "ok" || health.mode !== "simulation")
      throw new Error("Simulator menolak server yang bukan MODE SIMULASI.");
  }

  private applyFanPolicy() {
    if (this.state.config.fan_mode !== "automatic") return;
    if (this.latestSample.temperature === null) this.state.fan_on = true;
    else if (this.latestSample.temperature >= this.state.config.fan_on_c)
      this.state.fan_on = true;
    else if (this.latestSample.temperature <= this.state.config.fan_off_c)
      this.state.fan_on = false;
  }

  private enqueue(endpoint: string, payload: Record<string, unknown>) {
    if (this.outbox.length >= 200) {
      this.outbox.shift();
      this.log(
        "Buffer telemetry penuh (200); sampel tertua dibuang. Ledger perintah tetap tersimpan.",
      );
    }
    this.outbox.push({ endpoint, payload });
  }

  private enqueueHeartbeat(now = Date.now()) {
    this.enqueue("/device/heartbeat", {
      heartbeat_id: randomUUID(),
      reported_at: new Date(now).toISOString(),
      lock_state: this.state.lock_state,
      fan_on: this.state.fan_on,
      fan_mode: this.state.config.fan_mode,
      applied_config_version: this.state.config.version,
    });
  }

  private localTick() {
    const now = Date.now();
    let changed = false;
    if (this.state.unlock_until !== null && now >= this.state.unlock_until) {
      this.state.lock_state = "locked";
      this.state.unlock_until = null;
      changed = true;
      this.enqueueHeartbeat(now);
      this.log("Timer lokal selesai: kunci kembali LOCKED (simulasi).");
    }
    if (now >= this.nextSensor) {
      this.nextSensor = now + this.options.sensorSeconds * 1000;
      const failure = this.options.scenario === "sensor-error";
      const phase = (now - this.startedAt) / 1000;
      this.latestSample = {
        temperature: failure
          ? null
          : Math.round((29.5 + 3 * Math.sin(phase / 24)) * 10) / 10,
        humidity: failure
          ? null
          : Math.round((51 + 7 * Math.cos(phase / 31)) * 10) / 10,
      };
      this.applyFanPolicy();
      changed = true;
      this.enqueue("/device/readings", {
        reading_id: randomUUID(),
        measured_at: new Date(now).toISOString(),
        status: failure ? "error" : "ok",
        temperature_c: this.latestSample.temperature,
        humidity_percent: this.latestSample.humidity,
        error_code: failure ? "DHT22_READ_FAILED" : null,
      });
      if (this.options.scenario === "late")
        this.enqueue("/device/readings", {
          reading_id: randomUUID(),
          measured_at: new Date(now - 300_000).toISOString(),
          status: "ok",
          temperature_c: 23.5,
          humidity_percent: 42,
          error_code: null,
        });
    }
    if (now >= this.nextAccess) {
      this.nextAccess = now + this.options.accessSeconds * 1000;
      const samples: Exclude<AccessSample, "cycle">[] = [
        "allowed",
        "known-denied",
        "unknown-denied",
      ];
      const sample =
        this.options.access === "cycle"
          ? samples[this.state.sequence++ % samples.length]
          : this.options.access;
      const known = sample !== "unknown-denied";
      this.enqueue("/device/access-events", {
        event_id: randomUUID(),
        occurred_at: new Date(now).toISOString(),
        person_id: known
          ? sample === "allowed"
            ? "KLP-001"
            : "KLP-002"
          : null,
        person_name: known
          ? sample === "allowed"
            ? "Operator Simulasi"
            : "Tamu Simulasi"
          : null,
        recognition: known ? "known" : "unknown",
        decision: sample === "allowed" ? "allowed" : "denied",
        reason:
          sample === "allowed"
            ? "Identitas simulasi memiliki izin"
            : known
              ? "Dikenal tetapi tidak memiliki izin"
              : "Wajah tidak dikenal (simulasi)",
      });
      if (sample === "allowed" && this.state.lock_state === "locked")
        this.unlockLocally(this.state.config.unlock_duration_seconds);
      changed = true;
    }
    if (now >= this.nextHeartbeat) {
      this.nextHeartbeat = now + this.options.heartbeatSeconds * 1000;
      this.enqueueHeartbeat(now);
    }
    if (changed) this.save();
  }

  private unlockLocally(seconds: number) {
    this.state.lock_state = "unlocked";
    this.state.unlock_until = Date.now() + seconds * 1000;
    this.log(`Kunci UNLOCKED selama ${seconds} detik; timer lokal aktif.`);
  }

  async syncConfiguration() {
    const configuration = await this.request<Configuration>("/device/config");
    if (configuration.version !== this.state.config.version) {
      this.state.config = configuration;
      this.applyFanPolicy();
      this.save();
      this.log(
        `Konfigurasi v${configuration.version} diterapkan: ${configuration.fan_mode}, ON ≥${configuration.fan_on_c}°C, OFF ≤${configuration.fan_off_c}°C.`,
      );
    }
    await this.request("/device/config/ack", "POST", {
      version: this.state.config.version,
    });
  }

  private async flushTelemetry(limit = 20) {
    for (let i = 0; i < limit && this.outbox.length > 0; i++) {
      const event = this.outbox[0];
      try {
        await this.request(event.endpoint, "POST", event.payload);
        if (this.options.scenario === "duplicate")
          await this.request(event.endpoint, "POST", event.payload);
        if (this.outbox[0] === event) this.outbox.shift();
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          if (this.outbox[0] === event) this.outbox.shift();
          this.log(
            `Telemetry ditolak ${error.code}; catatan dibuang, tidak diubah untuk menghindari penyamaran error.`,
          );
        }
        throw error;
      }
    }
  }

  private async reportStoredResults() {
    for (const [commandId, entry] of Object.entries(this.state.ledger)) {
      if (entry.phase !== "finished" || !entry.result || entry.suppress_result)
        continue;
      await this.request(
        `/device/commands/${commandId}/result`,
        "POST",
        entry.result,
      );
      entry.phase = "reported";
      this.save();
      this.log(
        `Hasil ${commandId}: ${entry.result.status} dikonfirmasi server.`,
      );
    }
  }

  async pollCommands() {
    await this.reportStoredResults();
    const commands = await this.request<Command[]>("/device/commands");
    for (const command of commands) {
      if (this.state.ledger[command.command_id]) continue;
      if (
        command.type === "set_fan" &&
        (command.config_version !== this.state.config.version ||
          this.state.config.fan_mode !== "manual")
      )
        continue;
      const entry: LedgerEntry = {
        claimed_at: new Date().toISOString(),
        phase: "claimed",
      };
      this.state.ledger[command.command_id] = entry;
      // Persist first. If the process dies anywhere after this, this ID is never actuated on restart.
      this.save();
      if (
        command.status !== "pending" ||
        Date.now() >= Date.parse(command.expires_at)
      ) {
        entry.phase = "uncertain";
        this.save();
        continue;
      }
      let receipt: { command: Command; execute_allowed: boolean };
      try {
        receipt = await this.request(
          `/device/commands/${command.command_id}/receipt`,
          "POST",
          {},
        );
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          error.code === "CONFIG_NOT_APPLIED"
        ) {
          // A definitive refusal confirms no receipt was accepted; wait for configuration ACK.
          delete this.state.ledger[command.command_id];
          this.save();
          continue;
        }
        entry.phase = "uncertain";
        this.save();
        throw error;
      }
      if (
        !this.running ||
        !receipt.execute_allowed ||
        Date.now() >= Date.parse(receipt.command.expires_at)
      ) {
        entry.phase = "uncertain";
        this.save();
        this.log(
          `Perintah ${command.command_id} tidak dieksekusi: penerimaan ulang atau sudah kedaluwarsa.`,
        );
        continue;
      }
      entry.phase = "executing";
      this.save();
      const executedAt = new Date().toISOString();
      if (Date.parse(executedAt) >= Date.parse(receipt.command.expires_at)) {
        entry.phase = "uncertain";
        this.save();
        continue;
      }
      let failure: string | undefined;
      if (command.type === "unlock") {
        if (this.state.lock_state !== "locked")
          failure =
            "Kunci simulasi sedang terbuka; tidak memperpanjang durasi.";
        else
          this.unlockLocally(
            command.duration_seconds ??
              this.state.config.unlock_duration_seconds,
          );
      } else if (
        this.state.config.fan_mode !== "manual" ||
        command.config_version !== this.state.config.version
      ) {
        failure =
          "Mode atau versi konfigurasi lokal tidak cocok; kipas tidak diubah.";
      } else if (command.fan_on === null)
        failure = "Nilai fan_on tidak tersedia.";
      else this.state.fan_on = command.fan_on;
      entry.result = {
        status: failure ? "failed" : "succeeded",
        executed_at: executedAt,
        message:
          failure ??
          (command.type === "unlock"
            ? "Relay kunci simulasi dibuka; timer lokal mengunci kembali."
            : "Relay kipas simulasi diterapkan."),
      };
      entry.phase = "finished";
      entry.suppress_result = this.options.scenario === "lost-confirmation";
      this.save();
      this.enqueueHeartbeat();
      if (entry.suppress_result)
        this.log(
          `Konfirmasi ${command.command_id} sengaja dihilangkan. Aktuator tidak akan diulang, termasuk setelah restart.`,
        );
    }
    await this.reportStoredResults();
  }

  async run(once = false) {
    this.runActive = true;
    this.running = true;
    try {
      await this.verifyMode();
      if (!this.running) return;
      await this.syncConfiguration();
      if (!this.running) return;
      this.localTick();
      this.localTimer = setInterval(() => {
        try {
          this.localTick();
        } catch (error) {
          this.localFailure =
            error instanceof Error ? error : new Error(String(error));
          this.running = false;
        }
      }, 100);
      await this.flushTelemetry();
      if (!this.running) return;
      await this.pollCommands();
      this.log(
        `MODE SIMULASI • ${this.options.deviceId} • skenario ${this.options.scenario} • Ctrl+C untuk berhenti.`,
      );
      if (once) {
        // Allow the local unlock timer to finish before exiting a one-shot run.
        while (this.running && this.state.unlock_until !== null)
          await sleep(100);
        this.enqueueHeartbeat();
        await this.flushTelemetry();
        return;
      }
      if (this.options.scenario === "offline")
        this.offlineUntil = Date.now() + this.options.offlineSeconds * 1000;
      let nextConfig = Date.now() + this.options.configSeconds * 1000;
      let nextCommands = Date.now() + this.options.commandSeconds * 1000;
      while (this.running) {
        if (Date.now() < this.offlineUntil) {
          if (!this.offlineWasLogged) {
            this.offlineWasLogged = true;
            this.log(
              `Jaringan simulasi OFFLINE ${this.options.offlineSeconds} detik; sensor, kipas otomatis, dan timer kunci tetap lokal.`,
            );
          }
          await sleep(100);
          continue;
        }
        if (this.offlineWasLogged) {
          this.offlineWasLogged = false;
          this.log(
            "Jaringan simulasi kembali online; kirim buffer berdasarkan waktu pengukuran asli.",
          );
        }
        if (Date.now() < this.rateLimitedUntil) {
          await sleep(100);
          continue;
        }
        try {
          if (Date.now() >= nextConfig) {
            nextConfig = Date.now() + this.options.configSeconds * 1000;
            await this.syncConfiguration();
          }
          if (Date.now() >= nextCommands) {
            nextCommands = Date.now() + this.options.commandSeconds * 1000;
            await this.pollCommands();
          }
          await this.flushTelemetry();
        } catch (error) {
          this.log(
            `Komunikasi gagal: ${error instanceof Error ? error.message : "error"}. Kontrol lokal tetap berjalan; retry dibatasi.`,
          );
          await sleep(1000);
        }
        await sleep(100);
      }
      if (this.localFailure) throw this.localFailure;
    } finally {
      this.runActive = false;
      this.stop();
    }
  }

  stop() {
    this.running = false;
    if (this.localTimer) clearInterval(this.localTimer);
    if (this.ownsLock) {
      this.state.lock_state = "locked";
      this.state.unlock_until = null;
      this.save();
    }
    // Keep ownership until in-flight HTTP finishes; another process must not write this ledger yet.
    if (this.runActive) return;
    if (this.ownsLock) {
      this.state.lock_state = "locked";
      this.state.unlock_until = null;
      try {
        this.save();
      } finally {
        this.releaseLock();
      }
    }
  }
}
