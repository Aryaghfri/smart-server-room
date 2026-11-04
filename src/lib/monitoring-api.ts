import { randomUUID } from "node:crypto";
import { z } from "zod";
import { settings } from "./env";
import { isoNow } from "./time";
import {
  ApiError,
  csrfSession,
  dashboardMutation,
  deviceAuth,
  jsonBody,
  rateLimit,
} from "./security";
import { transaction } from "./db";
import {
  currentConfig,
  dataSource,
  execute,
  incidentList,
  one,
  rows,
  saveRecords,
  setState,
  summary,
} from "./monitoring-store";
import type { IncomingRecord } from "./monitoring-store";
import type { Recipient } from "./monitoring-types";

const bit = z.union([z.literal(0), z.literal(1)]).nullable();
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString())
  .refine(
    (s) => Date.parse(s) <= Date.now() + 30_000,
    "Jam perangkat lebih dari 30 detik di masa depan.",
  );
const telemetry = z
  .object({
    sample_id: z.uuid(),
    measured_at: timestamp,
    dht: z
      .object({
        suhu: z.number().min(-40).max(80).nullable(),
        kelembapan: z.number().min(0).max(100).nullable(),
        status: bit,
        error_code: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .nullable()
          .optional()
          .default(null),
      })
      .strict()
      .superRefine((v, ctx) => {
        if (
          (v.suhu === null) !== (v.kelembapan === null) ||
          (v.suhu === null && !v.error_code) ||
          (v.suhu !== null && v.error_code)
        )
          ctx.addIssue({
            code: "custom",
            message:
              "Sensor gagal: suhu dan kelembapan null dengan error_code; sensor normal: dua angka dan error_code null.",
          });
      }),
    pir: z
      .object({
        status: bit,
        lamp_on: z.boolean().nullable().optional().default(null),
      })
      .strict(),
    mq: z.object({ status: bit }).strict(),
  })
  .strict();
const recipientSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    name: z.string().trim().max(100).default(""),
  })
  .strict();
const configSchema = z
  .object({
    expected_version: z.number().int().min(1),
    fan_on_c: z.number().min(-39).max(80),
    fan_off_c: z.number().min(-40).max(79),
  })
  .strict()
  .refine(
    (v) => v.fan_off_c < v.fan_on_c,
    "Ambang OFF harus lebih rendah dari ON.",
  );

function ok(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(
    { data },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}
function pagination(params: URLSearchParams) {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(params.get("page") || 1);
  const size = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(params.get("page_size") || 15);
  return { page, size, offset: (page - 1) * size };
}
/** Jalur HTTP versi dua: field `status` sengaja mengikuti dht/pir/mq milik Mas Togar. */
export async function handleMonitoringApi(request: Request, path: string[]) {
  const requestId = randomUUID(),
    endpoint = path.join("/"),
    method = request.method;
  try {
    if (endpoint === "health" && method === "GET")
      return ok({
        status: "ok",
        version: 2,
        mode: settings().mode,
        data_source: dataSource(),
      });
    if (endpoint.startsWith("device/")) {
      deviceAuth(request);
      rateLimit(`v2-device:${settings().deviceId}`);
      if (dataSource() !== "api")
        throw new ApiError(
          409,
          "SOURCE_MISMATCH",
          "DATA_SOURCE=mysql aktif. Gunakan satu jalur aktif agar data tidak bercampur.",
        );
    } else if (endpoint.startsWith("dashboard/") && method !== "GET") {
      dashboardMutation(request);
      rateLimit("v2-dashboard", 120);
    }
    if (endpoint === "dashboard/session" && method === "GET") {
      const session = csrfSession();
      return ok({ csrf_token: session.token }, 200, {
        "Set-Cookie": `ssr_csrf=${session.cookie}; Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
      });
    }
    if (endpoint === "device/telemetry" && method === "POST") {
      const body = telemetry.parse(await jsonBody(request));
      const common = {
        source:
          settings().mode === "simulation"
            ? ("simulator" as const)
            : ("api" as const),
        source_id: body.sample_id,
        measured_at: body.measured_at,
      };
      const records: IncomingRecord[] = (["dht", "pir", "mq"] as const).map(
        (kind) => ({
          ...common,
          record_key: `${common.source}:${kind}:${body.sample_id}`,
          kind,
          suhu: kind === "dht" ? body.dht.suhu : null,
          kelembapan: kind === "dht" ? body.dht.kelembapan : null,
          status: body[kind].status,
          lamp_on:
            kind === "pir" && body.pir.lamp_on !== null
              ? body.pir.lamp_on
                ? 1
                : 0
              : null,
          error_code:
            kind === "dht"
              ? body.dht.error_code
              : body[kind].status === null
                ? "SENSOR_UNAVAILABLE"
                : null,
        }),
      );
      const result = saveRecords(records, { live: true, contact: true });
      return ok(
        { sample_id: body.sample_id, ...result },
        result.inserted ? 201 : 200,
      );
    }
    if (endpoint === "device/config" && method === "GET")
      return ok(currentConfig());
    if (endpoint === "device/config/ack" && method === "POST") {
      const b = z
        .object({ version: z.number().int().min(1) })
        .strict()
        .parse(await jsonBody(request));
      if (b.version > currentConfig().version)
        throw new ApiError(
          422,
          "CONFIG_VERSION",
          "Versi tersebut belum diterbitkan.",
        );
      execute(
        "UPDATE monitor_device SET applied_config_version=MAX(applied_config_version,?),last_contact_at=? WHERE singleton=1",
        b.version,
        isoNow(),
      );
      return ok({
        applied_config_version: one<{ applied_config_version: number }>(
          "SELECT applied_config_version FROM monitor_device",
        )!.applied_config_version,
      });
    }
    if (endpoint === "device/heartbeat" && method === "POST") {
      // Heartbeat hanya kontak; tidak mengakui konfigurasi dan tidak menyatakan sensor normal.
      const b = z
        .object({ heartbeat_id: z.uuid(), reported_at: timestamp })
        .strict()
        .parse(await jsonBody(request));
      execute(
        "UPDATE monitor_device SET last_contact_at=? WHERE singleton=1",
        isoNow(),
      );
      setState("last_contact_source", "api");
      return ok({ heartbeat_id: b.heartbeat_id });
    }
    if (endpoint === "dashboard/summary" && method === "GET")
      return ok(summary());
    if (endpoint === "dashboard/history" && method === "GET") {
      const params = new URL(request.url).searchParams,
        p = pagination(params);
      const kind = z
        .enum(["all", "dht", "pir", "mq"])
        .parse(params.get("kind") || "all");
      const source = z
        .enum(["all", "api", "mysql", "sql_import", "simulator"])
        .parse(params.get("source") || "all");
      const clauses: string[] = [],
        args: (string | number)[] = [];
      if (kind !== "all") {
        clauses.push("kind=?");
        args.push(kind);
      }
      if (source !== "all") {
        clauses.push("source=?");
        args.push(source);
      }
      for (const key of ["from", "to"] as const) {
        const day = params.get(key);
        if (day) {
          z.iso.date().parse(day);
          const time =
            new Date(`${day}T00:00:00+07:00`).getTime() +
            (key === "to" ? 86400000 : 0);
          clauses.push(`measured_at${key === "from" ? ">=" : "<"}?`);
          args.push(new Date(time).toISOString());
        }
      }
      if (
        params.get("from") &&
        params.get("to") &&
        params.get("from")! > params.get("to")!
      )
        throw new ApiError(
          422,
          "INVALID_RANGE",
          "Tanggal awal harus sebelum atau sama dengan tanggal akhir.",
        );
      const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
      return ok({
        items: rows(
          `SELECT record_key,kind,source,source_id,measured_at,received_at,suhu,kelembapan,status,lamp_on,error_code FROM sensor_records${where} ORDER BY measured_at DESC,record_key DESC LIMIT ? OFFSET ?`,
          ...args,
          p.size,
          p.offset,
        ),
        total: one<{ n: number }>(
          `SELECT COUNT(*) n FROM sensor_records${where}`,
          ...args,
        )!.n,
        page: p.page,
        page_size: p.size,
      });
    }
    if (endpoint === "dashboard/alerts" && method === "GET") {
      const p = pagination(new URL(request.url).searchParams);
      return ok({
        items: incidentList(p.size, p.offset),
        total: one<{ n: number }>("SELECT COUNT(*) n FROM smoke_incidents")!.n,
        page: p.page,
        page_size: p.size,
      });
    }
    if (endpoint === "dashboard/recipients" && method === "GET")
      return ok(
        rows<Recipient>("SELECT * FROM email_recipients ORDER BY id DESC"),
      );
    if (endpoint === "dashboard/recipients" && method === "POST") {
      const b = recipientSchema.parse(await jsonBody(request));
      const existing = one<Recipient>(
        "SELECT * FROM email_recipients WHERE email=?",
        b.email,
      );
      if (existing?.enabled)
        throw new ApiError(
          409,
          "EMAIL_EXISTS",
          "Email tersebut sudah terdaftar.",
        );
      if (existing)
        execute(
          "UPDATE email_recipients SET enabled=1,name=? WHERE id=?",
          b.name,
          existing.id,
        );
      else
        execute(
          "INSERT INTO email_recipients(email,name,created_at) VALUES(?,?,?)",
          b.email,
          b.name,
          isoNow(),
        );
      return ok({ email: b.email, enabled: true }, 201);
    }
    if (
      path.length === 3 &&
      path[0] === "dashboard" &&
      path[1] === "recipients" &&
      method === "DELETE"
    ) {
      const id = z.coerce.number().int().positive().parse(path[2]);
      if (!one("SELECT id FROM email_recipients WHERE id=?", id))
        throw new ApiError(404, "NOT_FOUND", "Penerima tidak ditemukan.");
      execute("UPDATE email_recipients SET enabled=0 WHERE id=?", id);
      return ok({ id, enabled: false });
    }
    if (endpoint === "dashboard/settings" && method === "PUT") {
      if (dataSource() === "mysql")
        throw new ApiError(
          409,
          "MYSQL_LOCAL_CONFIG",
          "MySQL tidak mempunyai jalur konfigurasi balik. Sesuaikan ambang pada firmware Mas Togar.",
        );
      const b = configSchema.parse(await jsonBody(request));
      const config = transaction(() => {
        if (currentConfig().version !== b.expected_version)
          throw new ApiError(
            409,
            "CONFIG_CONFLICT",
            "Konfigurasi berubah. Muat ulang form.",
          );
        execute(
          "UPDATE monitor_config SET version=version+1,fan_on_c=?,fan_off_c=?,updated_at=?",
          b.fan_on_c,
          b.fan_off_c,
          isoNow(),
        );
        return currentConfig();
      });
      return ok(config);
    }
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Endpoint atau metode tidak tersedia.",
    );
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : error instanceof z.ZodError
          ? new ApiError(
              422,
              "VALIDATION_ERROR",
              "Payload tidak valid.",
              error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            )
          : new ApiError(
              500,
              "INTERNAL_ERROR",
              "Server gagal memproses permintaan. Periksa log server.",
            );
    if (failure.status >= 500)
      console.error(
        JSON.stringify({ request_id: requestId, endpoint, code: failure.code }),
      );
    return Response.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details ? { details: failure.details } : {}),
        },
        request_id: requestId,
      },
      {
        status: failure.status,
        headers: {
          "Cache-Control": "no-store",
          ...(failure.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  }
}
