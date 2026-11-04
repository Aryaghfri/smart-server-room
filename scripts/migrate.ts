import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
const { getDb, closeDbs } = await import("../src/lib/db");
const { isoNow } = await import("../src/lib/time");
const db = getDb();

// Penerima awal dari ALERT_RECIPIENTS (pisahkan dengan koma). Email yang sudah
// ada tidak diubah, sehingga penerima yang dinonaktifkan di dashboard tetap nonaktif.
const recipients = (process.env.ALERT_RECIPIENTS || "")
  .split(",")
  .map((email) => email.trim())
  .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
for (const email of recipients) {
  const added = db
    .prepare(
      "INSERT OR IGNORE INTO email_recipients(email,name,created_at) VALUES(?,?,?)",
    )
    .run(email, "Penerima awal", isoNow());
  if (added.changes) console.log(`Penerima email ditambahkan: ${email}`);
}

closeDbs();
console.log("Migrasi SQLite selesai.");
