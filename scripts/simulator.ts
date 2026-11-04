import { config } from "dotenv";
import { resolve } from "node:path";
import {
  Simulator,
  type AccessSample,
  type Scenario,
} from "./simulator-engine";

config({ path: ".env.local", quiet: true });
const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Nilai ${flag} wajib diisi.`);
  return args[index + 1];
};
function numberOption(
  flag: string,
  fallback: string,
  min: number,
  max: number,
) {
  const number = Number(value(flag, fallback));
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`${flag} harus bilangan bulat ${min}..${max}.`);
  return number;
}
if (args.includes("--help")) {
  console.log(`Simulator Smart Server Room — hanya MODE SIMULASI
npm run simulator -- [opsi]
  --scenario normal|offline|sensor-error|duplicate|late|lost-confirmation
  --access cycle|allowed|known-denied|unknown-denied
  --once                         Satu putaran; tunggu timer kunci selesai
  --offline-seconds 45           Putus jaringan setelah putaran awal, lalu pulih
  --sensor-seconds 10            Interval akuisisi sensor lokal
  --heartbeat-seconds 10         Interval laporan status
  --command-seconds 2            Interval ambil perintah
  --config-seconds 10            Interval sinkronisasi dan ACK konfigurasi
  --access-seconds 30            Interval contoh akses
  --timeout-ms 3000              Timeout tiap HTTP request
  --retries 2                    Retry maksimal tambahan (0..3), ID tetap
  --state <path>                 Default data/simulator-<device>.json
BASE_URL, DEVICE_ID, DEVICE_API_KEY, APP_MODE dibaca dari .env.local.
Skenario offline membutuhkan mode kontinu. Ctrl+C mengakhiri simulasi.`);
  process.exit(0);
}

async function main() {
  const flagsWithValue = new Set([
    "--scenario",
    "--access",
    "--offline-seconds",
    "--sensor-seconds",
    "--heartbeat-seconds",
    "--command-seconds",
    "--config-seconds",
    "--access-seconds",
    "--timeout-ms",
    "--retries",
    "--state",
  ]);
  for (let index = 0; index < args.length; index++) {
    if (flagsWithValue.has(args[index])) {
      value(args[index], "");
      index++;
    } else if (args[index] !== "--once")
      throw new Error(`Opsi tidak dikenal: ${args[index]}. Gunakan --help.`);
  }
  if (process.env.APP_MODE !== "simulation")
    throw new Error(
      "APP_MODE wajib simulation; simulator tidak diizinkan mengirim ke mode real.",
    );
  const deviceId = process.env.DEVICE_ID;
  const apiKey = process.env.DEVICE_API_KEY;
  if (!deviceId || !apiKey)
    throw new Error(
      "DEVICE_ID dan DEVICE_API_KEY wajib diisi. Jalankan npm run setup -- --mode simulation.",
    );
  const baseUrl = new URL(process.env.BASE_URL ?? "http://127.0.0.1:3000");
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== "/"
  ) {
    throw new Error(
      "BASE_URL harus origin HTTP(S), tanpa path, query, atau kredensial.",
    );
  }
  const scenario = value("--scenario", "normal") as Scenario;
  if (
    ![
      "normal",
      "offline",
      "sensor-error",
      "duplicate",
      "late",
      "lost-confirmation",
    ].includes(scenario)
  )
    throw new Error("Skenario tidak dikenal.");
  const access = value("--access", "cycle") as AccessSample;
  if (!["cycle", "allowed", "known-denied", "unknown-denied"].includes(access))
    throw new Error("Contoh akses tidak dikenal.");
  if (scenario === "offline" && args.includes("--once"))
    throw new Error(
      "Skenario offline membutuhkan mode kontinu, jangan gunakan --once.",
    );
  const simulator = new Simulator({
    baseUrl: baseUrl.origin,
    deviceId,
    apiKey,
    scenario,
    access,
    statePath: resolve(
      value(
        "--state",
        `${process.env.DATA_DIR ?? "./data"}/simulator-${deviceId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
      ),
    ),
    sensorSeconds: numberOption(
      "--sensor-seconds",
      process.env.SENSOR_INTERVAL_SECONDS ?? "10",
      1,
      3600,
    ),
    heartbeatSeconds: numberOption(
      "--heartbeat-seconds",
      process.env.HEARTBEAT_INTERVAL_SECONDS ?? "10",
      1,
      3600,
    ),
    commandSeconds: numberOption(
      "--command-seconds",
      process.env.COMMAND_POLL_SECONDS ?? "2",
      1,
      3600,
    ),
    configSeconds: numberOption(
      "--config-seconds",
      process.env.CONFIG_POLL_SECONDS ?? "10",
      1,
      3600,
    ),
    accessSeconds: numberOption("--access-seconds", "30", 1, 86400),
    offlineSeconds: numberOption("--offline-seconds", "45", 1, 86400),
    timeoutMs: numberOption("--timeout-ms", "3000", 100, 30000),
    retries: numberOption("--retries", "2", 0, 3),
  });
  process.once("SIGINT", () => simulator.stop());
  process.once("SIGTERM", () => simulator.stop());
  await simulator.run(args.includes("--once"));
}
main().catch((error) => {
  console.error(
    `Simulator berhenti: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
