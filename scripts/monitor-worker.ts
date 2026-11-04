import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import fs from "node:fs";
import path from "node:path";
import { settings } from "../src/lib/env";
import { dataSource, setState } from "../src/lib/monitoring-store";
import { closeMySql, syncMySql } from "../src/lib/mysql-sync";
import {
  deliverPendingEmails,
  recoverSendingEmails,
} from "../src/lib/mail-worker";
import { closeDbs } from "../src/lib/db";
import { isoNow } from "../src/lib/time";

// Satu worker per mode dan DATA_DIR mencegah dua proses mengambil pekerjaan yang sama.
const env = settings(),
  filename = path.join(env.dataDir, `monitor-worker-${env.mode}.lock`);
fs.mkdirSync(env.dataDir, { recursive: true });
if (fs.existsSync(filename)) {
  const pid = Number(fs.readFileSync(filename, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
  }
  if (alive)
    throw new Error(
      "Worker lain masih berjalan. Hentikan proses lama secara normal.",
    );
  fs.unlinkSync(filename);
}
fs.writeFileSync(filename, String(process.pid), { flag: "wx" });
let stopped = false;
let mailTask: Promise<unknown> | null = null;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  recoverSendingEmails();
  console.log(
    `Worker aktif: ${env.mode}, sumber ${dataSource()}. Ctrl+C untuk berhenti.`,
  );
  do {
    setState("worker_last_seen", isoNow());
    if (dataSource() === "mysql") {
      try {
        await syncMySql();
      } catch (error) {
        // Tampilkan kode umum, tidak pernah password atau string koneksi.
        const code = String(
          (error as { code?: string }).code || "MYSQL_SYNC_FAILED",
        );
        setState(
          "mysql_error",
          `Sinkronisasi MySQL gagal (${code}). Periksa koneksi, hak SELECT, schema dan zona waktu.`,
        );
        console.error(`MySQL: ${code}`);
      }
    }
    // SMTP bisa lambat. Satu pengirim berjalan di latar tanpa menahan polling MySQL.
    if (!mailTask)
      mailTask = deliverPendingEmails()
        .catch(() =>
          console.error("Email worker gagal; periksa antrean lokal."),
        )
        .finally(() => {
          mailTask = null;
        });
    setState("worker_last_seen", isoNow());
    if (process.argv.includes("--once")) {
      await mailTask;
      break;
    }
    for (let i = 0; i < 5 && !stopped; i++) await wait(1000);
  } while (!stopped);
} finally {
  await mailTask;
  await closeMySql();
  closeDbs();
  if (
    fs.existsSync(filename) &&
    fs.readFileSync(filename, "utf8") === String(process.pid)
  )
    fs.unlinkSync(filename);
}
