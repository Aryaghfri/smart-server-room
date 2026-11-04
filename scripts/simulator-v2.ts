import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import { randomUUID } from "node:crypto";
import { settings } from "../src/lib/env";

const env = settings(),
  base = process.env.BASE_URL || "http://127.0.0.1:3000";
if (env.mode !== "simulation")
  throw new Error("Simulator tidak boleh berjalan dalam mode real.");
const headers = {
  "Content-Type": "application/json",
  "X-Device-ID": env.deviceId,
  "X-API-Key": env.apiKey,
};
const scenario =
  process.argv.find((s) => s.startsWith("--scenario="))?.split("=")[1] ||
  "normal";
if (!["normal", "motion", "smoke", "sensor-error"].includes(scenario))
  throw new Error("Skenario: normal, motion, smoke, sensor-error.");
/** Contoh klien nyata HTTP. Timeout tidak membuat data palsu dinyatakan berhasil. */
async function request(path: string, body?: unknown) {
  const res = await fetch(base + "/api/v2/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${result.error?.code}`);
  return result.data;
}
const health = await request("health");
if (health.mode !== "simulation" || health.data_source !== "api")
  throw new Error("Server bukan mode simulasi dengan sumber API.");
let stopped = false,
  fanOn = false,
  index = 0;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
// Payload yang gagal dikirim disimpan utuh: ID dan timestamp tidak diganti saat retry.
let pending: unknown = null;
console.log(
  `Simulator v2: ${scenario}. Data ilustrasi, bukan laporan hardware.`,
);
do {
  try {
    const config = await request("device/config");
    // Firmware nyata menerapkan dan menyimpan konfigurasi sebelum ACK.
    await request("device/config/ack", { version: config.version });
    if (!pending) {
      const error = scenario === "sensor-error";
      const suhu = Number((30.6 + Math.sin(index / 4) * 1.8).toFixed(1));
      if (error || suhu >= config.fan_on_c) fanOn = true;
      else if (suhu <= config.fan_off_c) fanOn = false;
      const person =
        scenario === "motion" || (scenario === "normal" && index % 8 < 2);
      pending = {
        sample_id: randomUUID(),
        measured_at: new Date().toISOString(),
        dht: {
          suhu: error ? null : suhu,
          kelembapan: error
            ? null
            : Number((64 + Math.cos(index / 3) * 3).toFixed(1)),
          status: fanOn ? 1 : 0,
          error_code: error ? "DHT_READ_FAILED" : null,
        },
        pir: { status: person ? 1 : 0, lamp_on: person },
        mq: { status: scenario === "smoke" ? 1 : 0 },
      };
    }
    const result = await request("device/telemetry", pending);
    console.log(
      `Sampel ${result.sample_id} tersimpan (${result.inserted} record).`,
    );
    pending = null;
    index++;
  } catch (error) {
    console.error(
      `Belum terkirim: ${(error as Error).message}. Payload dipertahankan untuk retry.`,
    );
  }
  if (process.argv.includes("--once")) break;
  for (let i = 0; i < 5 && !stopped; i++)
    await new Promise((resolve) => setTimeout(resolve, 1000));
} while (!stopped);
