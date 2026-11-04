import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "simulation";
if (!["simulation", "real"].includes(mode))
  throw new Error("--mode simulation|real");
const filename = path.resolve(".env.local");
if (fs.existsSync(filename)) {
  console.log(
    ".env.local sudah ada; tidak ditimpa. Edit APP_MODE atau gunakan salinan proyek dengan data terpisah.",
  );
} else {
  const template = fs.readFileSync(".env.example", "utf8");
  fs.writeFileSync(
    filename,
    template
      .replace("APP_MODE=simulation", `APP_MODE=${mode}`)
      .replace(
        "DEVICE_API_KEY=",
        `DEVICE_API_KEY=${crypto.randomBytes(32).toString("hex")}`,
      )
      .replace(
        "CSRF_SECRET=",
        `CSRF_SECRET=${crypto.randomBytes(32).toString("hex")}`,
      ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `Environment ${mode} dibuat di .env.local. Secret disimpan lokal, tidak dicetak.`,
  );
}
