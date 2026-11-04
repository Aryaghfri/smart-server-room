import nodemailer from "nodemailer";
import { emailConfigured, execute, one, rows } from "./monitoring-store";
import { transaction } from "./db";
import { isoNow } from "./time";

interface Job {
  id: number;
  incident_id: string;
  recipient_email: string;
  status: string;
  detected_at: string;
  resolved_at: string | null;
  enabled: number;
}
/** SMTP berjalan di worker terpisah agar request sensor tidak menunggu server email. */
export async function deliverPendingEmails() {
  const jobs = rows<Job>(
    "SELECT o.*,s.detected_at,s.resolved_at,r.enabled FROM email_outbox o JOIN smoke_incidents s ON s.id=o.incident_id JOIN email_recipients r ON r.id=o.recipient_id WHERE o.status='pending' ORDER BY o.id LIMIT 10",
  );
  let sent = 0;
  for (const job of jobs) {
    // Alarm lebih dari lima menit atau penerima nonaktif tidak dikirim. Insiden baru yang
    // sudah berakhir tetap diberitahukan, agar pulsa asap singkat tidak kehilangan email.
    if (Date.now() - Date.parse(job.detected_at) > 300_000 || !job.enabled) {
      execute(
        "UPDATE email_outbox SET status='skipped',completed_at=?,detail=? WHERE id=? AND status='pending'",
        isoNow(),
        "Alarm sudah lama atau penerima dinonaktifkan.",
        job.id,
      );
      continue;
    }
    if (!emailConfigured()) continue;
    const claimed = transaction(
      () =>
        execute(
          "UPDATE email_outbox SET status='sending' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM email_recipients r WHERE r.id=email_outbox.recipient_id AND r.enabled=1)",
          job.id,
        ).changes,
    );
    if (!claimed) continue;
    const messageId = `<smoke-${job.incident_id}-${job.id}@smart-server-room.internal>`;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      ...(process.env.SMTP_USER
        ? {
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASSWORD || "",
            },
          }
        : {}),
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      // Sertifikat selalu diverifikasi; SMTP tanpa TLS hanya diizinkan untuk lab lokal yang dikonfigurasi operator.
      requireTLS:
        process.env.SMTP_REQUIRE_TLS !== "false" &&
        process.env.SMTP_SECURE !== "true",
      tls: { rejectUnauthorized: true },
    });
    try {
      const result = await transport.sendMail({
        from: process.env.SMTP_FROM,
        to: job.recipient_email,
        messageId,
        subject: "[Smart Server Room] Sensor mendeteksi asap",
        text: `Sensor MQ melaporkan asap.\nWaktu: ${new Date(job.detected_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB\nID insiden: ${job.incident_id}\nPeriksa kondisi ruangan dan dashboard internal.\nIni laporan sensor prototype; perangkat belum menggantikan sistem alarm tersertifikasi.`,
      });
      if (!result.accepted?.length)
        throw Object.assign(new Error("SMTP_REJECTED"), { code: "EENVELOPE" });
      execute(
        "UPDATE email_outbox SET status='sent',completed_at=?,message_id=?,detail=? WHERE id=?",
        isoNow(),
        messageId,
        "Server SMTP menerima pesan. Penerimaan inbox belum dapat dipastikan.",
        job.id,
      );
      sent++;
    } catch (error) {
      const code = (error as { code?: string }).code || "SMTP_ERROR";
      const definite = ["EAUTH", "EENVELOPE", "EDNS"].includes(code);
      execute(
        "UPDATE email_outbox SET status=?,completed_at=?,message_id=?,detail=? WHERE id=?",
        definite ? "failed" : "unknown",
        isoNow(),
        messageId,
        definite
          ? `SMTP menolak atau tidak dapat tersambung (${code}).`
          : `Hasil SMTP belum dapat dipastikan (${code}). Tidak diulang otomatis.`,
        job.id,
      );
    } finally {
      transport.close();
    }
  }
  return sent;
}
/** Crash setelah SMTP menerima pesan bersifat ambigu; jangan otomatis mengirim ulang email tersebut. */
export function recoverSendingEmails() {
  execute(
    "UPDATE email_outbox SET status='unknown',completed_at=?,detail=? WHERE status='sending'",
    isoNow(),
    "Worker restart saat pengiriman. Hasil belum diketahui; tidak diulang otomatis.",
  );
}
