import path from "node:path";
export function settings() {
  const mode = process.env.APP_MODE || "simulation";
  if (!["simulation", "real"].includes(mode))
    throw new Error("APP_MODE must be simulation or real");
  const integer = (name: string, fallback: number) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > 3600)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    mode: mode as "simulation" | "real",
    dataDir: path.resolve(
      /* turbopackIgnore: true */ process.env.DATA_DIR || "./data",
    ),
    deviceId: process.env.DEVICE_ID || "kelapa-esp32-01",
    apiKey: process.env.DEVICE_API_KEY || "",
    csrfSecret: process.env.CSRF_SECRET || "",
    origins: (
      process.env.ALLOWED_ORIGINS ||
      "http://localhost:3000,http://127.0.0.1:3000"
    )
      .split(",")
      .map((s) => s.trim()),
    sensor: integer("SENSOR_INTERVAL_SECONDS", 10),
    heartbeat: integer("HEARTBEAT_INTERVAL_SECONDS", 10),
    commandPoll: integer("COMMAND_POLL_SECONDS", 2),
    dashboardPoll: integer("DASHBOARD_POLL_SECONDS", 300),
    offline: integer("OFFLINE_AFTER_SECONDS", 30),
    stale: integer("SENSOR_STALE_SECONDS", 30),
    unlockTtl: integer("UNLOCK_TTL_SECONDS", 10),
    resultGrace: integer("RESULT_GRACE_SECONDS", 30),
  };
}
