import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { getDb, transaction } from "./db";
import { settings } from "./env";
import { isoNow, now, todayWibBounds } from "./time";
import {
  ApiError,
  csrfSession,
  dashboardMutation,
  deviceAuth,
  jsonBody,
  rateLimit,
} from "./security";
import * as schema from "./validation";
import type {
  Command,
  Configuration,
  DeviceReport,
  Reading,
  AccessEvent,
  AuditEntry,
  FanChange,
} from "./contracts";

function one<T>(sql: string, ...args: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .get(...args) as T | undefined;
}
function all<T>(sql: string, ...args: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .all(...args) as T[];
}
function run(sql: string, ...args: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .run(...args);
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function config() {
  return one<Configuration>(
    "SELECT * FROM configurations ORDER BY version DESC LIMIT 1",
  )!;
}
function device() {
  return one<{
    device_id: string;
    last_contact_at: string | null;
    applied_config_version: number;
  }>("SELECT * FROM device")!;
}
function touch() {
  run(
    "UPDATE device SET last_contact_at=CASE WHEN last_contact_at IS NULL OR last_contact_at<? THEN ? ELSE last_contact_at END",
    isoNow(),
    isoNow(),
  );
}
function audit(
  action: string,
  detail: string,
  commandId: string | null = null,
) {
  run(
    "INSERT INTO audit_log(action,created_at,device_id,source,command_id,detail) VALUES (?,?,?,?,?,?)",
    action,
    isoNow(),
    settings().deviceId,
    "dashboard internal",
    commandId,
    detail,
  );
}
function configState() {
  const c = config();
  const d = device();
  return {
    config: c,
    applied_config_version: d.applied_config_version,
    config_synced: d.applied_config_version === c.version,
    device_id: d.device_id,
  };
}
function publicRow<T>(input: T): T {
  const row = { ...input } as T & {
    payload_hash?: string;
    result_hash?: string;
  };
  delete row.payload_hash;
  delete row.result_hash;
  return row;
}
function report(row: DeviceReport | undefined) {
  return row ? { ...publicRow(row), fan_on: !!row.fan_on } : null;
}
export function effectiveCommand(row: Command): Command {
  const c = {
    ...publicRow(row),
    fan_on: row.fan_on === null ? null : !!row.fan_on,
  };
  if (
    c.status === "pending" &&
    (c.expires_at <= isoNow() ||
      (c.type === "set_fan" && c.config_version !== config().version))
  )
    c.status = "expired";
  if (c.status === "received" && c.result_deadline <= isoNow())
    c.status = "unknown";
  return c;
}
function getCommand(id: string) {
  const c = one<Command>("SELECT * FROM commands WHERE command_id=?", id);
  if (!c) throw new ApiError(404, "NOT_FOUND", "Perintah tidak ditemukan.");
  return c;
}
function pagination(params: URLSearchParams, defaultSize = 10) {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(params.get("page") || 1);
  const pageSize = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(params.get("page_size") || defaultSize);
  return { page, page_size: pageSize, offset: (page - 1) * pageSize };
}
function dedup(
  table: "access_events" | "readings" | "heartbeats",
  column: string,
  id: string,
  payload: unknown,
  insert: () => void,
) {
  return transaction(() => {
    const previous = one<{ payload_hash: string }>(
      `SELECT payload_hash FROM ${table} WHERE ${column}=?`,
      id,
    );
    if (previous && previous.payload_hash !== hash(payload))
      throw new ApiError(
        409,
        "ID_CONFLICT",
        "ID sama digunakan dengan payload berbeda.",
      );
    if (!previous) insert();
    touch();
    return { [column]: id, duplicate: !!previous };
  });
}
function summary() {
  const env = settings(),
    d = device(),
    c = config();
  const latest = one<Reading>(
    "SELECT * FROM readings ORDER BY measured_at DESC,received_at ASC,reading_id ASC LIMIT 1",
  );
  const valid = one<Reading>(
    "SELECT * FROM readings WHERE status='ok' ORDER BY measured_at DESC,received_at ASC,reading_id ASC LIMIT 1",
  );
  const hb = one<DeviceReport>(
    "SELECT * FROM heartbeats ORDER BY reported_at DESC,received_at ASC,heartbeat_id ASC LIMIT 1",
  );
  const [start, end] = todayWibBounds();
  const counts = one<{ total: number; allowed: number; denied: number }>(
    "SELECT COUNT(*) total,COALESCE(SUM(decision='allowed'),0) allowed,COALESCE(SUM(decision='denied'),0) denied FROM access_events WHERE occurred_at>=? AND occurred_at<?",
    start,
    end,
  )!;
  return {
    mode: env.mode,
    server_time: isoNow(),
    device_id: env.deviceId,
    online:
      !!d.last_contact_at &&
      now().getTime() - Date.parse(d.last_contact_at) < env.offline * 1000,
    last_contact_at: d.last_contact_at,
    latest_reading: latest ? publicRow(latest) : null,
    latest_valid_reading: valid ? publicRow(valid) : null,
    sensor_failed: latest?.status === "error",
    sensor_stale:
      !valid ||
      now().getTime() - Date.parse(valid.measured_at) >= env.stale * 1000,
    device_status: report(hb),
    config: c,
    applied_config_version: d.applied_config_version,
    config_synced: c.version === d.applied_config_version,
    today: counts,
    recent_access: all<AccessEvent>(
      "SELECT * FROM access_events ORDER BY occurred_at DESC LIMIT 6",
    ).map(publicRow),
    recent_commands: all<Command>(
      "SELECT * FROM commands ORDER BY created_at DESC,rowid DESC LIMIT 6",
    ).map(effectiveCommand),
    intervals: {
      dashboard_poll_seconds: env.dashboardPoll,
      sensor_seconds: env.sensor,
      heartbeat_seconds: env.heartbeat,
      command_poll_seconds: env.commandPoll,
      offline_after_seconds: env.offline,
      sensor_stale_seconds: env.stale,
    },
  };
}
function accessHistory(params: URLSearchParams) {
  const p = pagination(params);
  const clauses: string[] = [];
  const args: SQLInputValue[] = [];
  const q = z
    .string()
    .max(160)
    .parse(params.get("q") || "");
  if (q) {
    clauses.push(
      "(person_name LIKE ? ESCAPE '\\' OR person_id LIKE ? ESCAPE '\\' OR event_id LIKE ? ESCAPE '\\')",
    );
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    args.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }
  const decision = params.get("decision");
  if (decision) {
    z.enum(["allowed", "denied"]).parse(decision);
    clauses.push("decision=?");
    args.push(decision);
  }
  let fromDate: string | undefined, toDate: string | undefined;
  for (const field of ["from", "to"]) {
    const value = params.get(field);
    if (!value) continue;
    z.iso.date().parse(value);
    const start = new Date(`${value}T00:00:00+07:00`);
    if (field === "from") {
      fromDate = value;
      clauses.push("occurred_at>=?");
      args.push(start.toISOString());
    } else {
      toDate = value;
      clauses.push("occurred_at<?");
      args.push(new Date(start.getTime() + 86400000).toISOString());
    }
  }
  if (fromDate && toDate && fromDate > toDate)
    throw new ApiError(
      422,
      "INVALID_RANGE",
      "Tanggal awal harus sebelum tanggal akhir.",
    );
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return {
    items: all<AccessEvent>(
      `SELECT * FROM access_events${where} ORDER BY occurred_at DESC,event_id DESC LIMIT ? OFFSET ?`,
      ...args,
      p.page_size,
      p.offset,
    ).map(publicRow),
    total: one<{ count: number }>(
      `SELECT COUNT(*) count FROM access_events${where}`,
      ...args,
    )!.count,
    page: p.page,
    page_size: p.page_size,
  };
}
function environment(params: URLSearchParams) {
  const p = pagination(params, 20);
  const hours = z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .parse(params.get("hours") || 24);
  const start = new Date(now().getTime() - hours * 3600000).toISOString(),
    end = isoNow();
  const total = one<{ count: number }>(
    "SELECT COUNT(*) count FROM readings WHERE measured_at>=? AND measured_at<=?",
    start,
    end,
  )!.count;
  const stride = Math.max(1, Math.ceil(total / 179));
  const chart = all<Reading>(
    `WITH numbered AS (SELECT *,ROW_NUMBER() OVER (ORDER BY measured_at ASC,reading_id ASC) rn FROM readings WHERE measured_at>=? AND measured_at<=?) SELECT * FROM numbered WHERE (rn-1)%?=0 OR rn=? ORDER BY measured_at LIMIT 180`,
    start,
    end,
    stride,
    total,
  ).map((r) => {
    const c = { ...publicRow(r) } as Reading & { rn?: number };
    delete c.rn;
    return c;
  });
  const changes = all<FanChange>(
    `WITH changes AS (SELECT rowid id,reported_at,fan_on,fan_mode,LAG(fan_on) OVER (ORDER BY reported_at,rowid) previous_on,LAG(fan_mode) OVER (ORDER BY reported_at,rowid) previous_mode FROM heartbeats WHERE reported_at>=? AND reported_at<=?) SELECT id,reported_at,fan_on,fan_mode FROM changes WHERE previous_on IS NULL OR previous_on!=fan_on OR previous_mode!=fan_mode ORDER BY reported_at DESC LIMIT 50`,
    start,
    end,
  ).map((r) => ({ ...r, fan_on: !!r.fan_on }));
  return {
    readings: all<Reading>(
      "SELECT * FROM readings WHERE measured_at>=? AND measured_at<=? ORDER BY measured_at DESC,reading_id DESC LIMIT ? OFFSET ?",
      start,
      end,
      p.page_size,
      p.offset,
    ).map(publicRow),
    total,
    page: p.page,
    page_size: p.page_size,
    chart,
    fan_changes: changes,
    config: config(),
  };
}
function createCommand(body: z.infer<typeof schema.commandSchema>) {
  return transaction(() => {
    const old = one<Command & { payload_hash: string }>(
      "SELECT * FROM commands WHERE command_id=?",
      body.command_id,
    );
    if (old) {
      if (old.payload_hash !== hash(body))
        throw new ApiError(
          409,
          "ID_CONFLICT",
          "ID perintah memiliki payload berbeda.",
        );
      return { command: effectiveCommand(old), duplicate: true };
    }
    const c = config(),
      env = settings();
    if (body.type === "set_fan" && c.fan_mode !== "manual")
      throw new ApiError(
        409,
        "MANUAL_MODE_REQUIRED",
        "Pilih mode manual sebelum mengontrol kipas.",
      );
    const pending = all<Command>(
      "SELECT * FROM commands WHERE type=? AND status IN ('pending','received')",
      body.type,
    )
      .map(effectiveCommand)
      .some((v) => ["pending", "received"].includes(v.status));
    if (pending)
      throw new ApiError(
        409,
        "COMMAND_IN_FLIGHT",
        "Masih ada perintah dengan hasil belum final. Pastikan keadaan perangkat sebelum membuat perintah baru.",
      );
    const created = isoNow(),
      expires = new Date(now().getTime() + env.unlockTtl * 1000).toISOString();
    const duration = body.type === "unlock" ? c.unlock_duration_seconds : null;
    const deadline = new Date(
      Date.parse(expires) + ((duration || 0) + env.resultGrace) * 1000,
    ).toISOString();
    run(
      "INSERT INTO commands(command_id,device_id,type,duration_seconds,fan_on,config_version,created_at,expires_at,result_deadline,status,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      body.command_id,
      env.deviceId,
      body.type,
      duration,
      body.type === "set_fan" ? Number(body.fan_on) : null,
      c.version,
      created,
      expires,
      deadline,
      "pending",
      hash(body),
    );
    audit(
      "command.created",
      body.type === "unlock"
        ? `Buka kunci selama ${duration} detik`
        : `Kipas ${body.fan_on ? "ON" : "OFF"}`,
      body.command_id,
    );
    return {
      command: effectiveCommand(getCommand(body.command_id)),
      duplicate: false,
    };
  });
}
function receipt(id: string) {
  return transaction(() => {
    const raw = getCommand(id),
      c = effectiveCommand(raw);
    if (c.status === "expired")
      throw new ApiError(
        410,
        "COMMAND_EXPIRED",
        "Perintah kedaluwarsa; jangan jalankan aktuator.",
      );
    if (c.status !== "pending") {
      touch();
      return { command: c, execute_allowed: false };
    }
    if (
      c.type === "set_fan" &&
      device().applied_config_version !== c.config_version
    )
      throw new ApiError(
        409,
        "CONFIG_NOT_APPLIED",
        "Terapkan dan konfirmasi konfigurasi terbaru sebelum menerima perintah kipas.",
      );
    run(
      "UPDATE commands SET status='received',received_at=? WHERE command_id=?",
      isoNow(),
      id,
    );
    touch();
    audit(
      "command.received",
      "Perangkat menerima perintah; eksekusi belum dikonfirmasi.",
      id,
    );
    return { command: effectiveCommand(getCommand(id)), execute_allowed: true };
  });
}
function commandResult(id: string, body: z.infer<typeof schema.resultSchema>) {
  return transaction(() => {
    const raw = getCommand(id) as Command & { result_hash: string | null };
    if (raw.result_hash) {
      if (raw.result_hash !== hash(body))
        throw new ApiError(
          409,
          "RESULT_CONFLICT",
          "Hasil final berbeda telah tersimpan.",
        );
      touch();
      return effectiveCommand(raw);
    }
    if (raw.status !== "received")
      throw new ApiError(
        409,
        "RECEIPT_REQUIRED",
        "Penerimaan perintah belum dikonfirmasi.",
      );
    if (body.executed_at < raw.created_at || body.executed_at > raw.expires_at)
      throw new ApiError(
        422,
        "EXECUTION_TIME",
        "Waktu mulai eksekusi harus dalam masa berlaku perintah.",
      );
    run(
      "UPDATE commands SET status=?,completed_at=?,message=?,result_hash=? WHERE command_id=?",
      body.status,
      isoNow(),
      body.message,
      hash(body),
      id,
    );
    touch();
    audit(`command.${body.status}`, body.message || body.status, id);
    return effectiveCommand(getCommand(id));
  });
}
function success(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(
    { data },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export async function handleApi(
  request: Request,
  path: string[],
): Promise<Response> {
  const requestId = randomUUID();
  const endpoint = path.join("/");
  const method = request.method;
  const params = new URL(request.url).searchParams;
  try {
    if (endpoint === "health" && method === "GET") {
      getDb();
      return success({ status: "ok", mode: settings().mode });
    }
    if (path[0] === "device") {
      deviceAuth(request);
      rateLimit(`device:${settings().deviceId}`);
    } else if (path[0] === "dashboard") {
      if (method !== "GET") {
        dashboardMutation(request);
        rateLimit("dashboard:mutations", 120);
      }
    } else throw new ApiError(404, "NOT_FOUND", "Endpoint tidak ditemukan.");
    if (endpoint === "dashboard/session" && method === "GET") {
      const { token, cookie } = csrfSession();
      const secure =
        new URL(request.url).protocol === "https:" ? "; Secure" : "";
      return success({ csrf_token: token }, 200, {
        "Set-Cookie": `ssr_csrf=${cookie}; Path=/; HttpOnly; SameSite=Strict${secure}`,
      });
    }
    if (endpoint === "device/access-events" && method === "POST") {
      const b = schema.accessSchema.parse(await jsonBody(request));
      const data = dedup("access_events", "event_id", b.event_id, b, () =>
        run(
          "INSERT INTO access_events VALUES (?,?,?,?,?,?,?,?,?,?)",
          b.event_id,
          settings().deviceId,
          b.occurred_at,
          isoNow(),
          b.person_id,
          b.person_name,
          b.recognition,
          b.decision,
          b.reason,
          hash(b),
        ),
      );
      return success(data, data.duplicate ? 200 : 201);
    }
    if (endpoint === "device/readings" && method === "POST") {
      const b = schema.readingSchema.parse(await jsonBody(request));
      const data = dedup("readings", "reading_id", b.reading_id, b, () =>
        run(
          "INSERT INTO readings VALUES (?,?,?,?,?,?,?,?,?)",
          b.reading_id,
          settings().deviceId,
          b.measured_at,
          isoNow(),
          b.status,
          b.temperature_c,
          b.humidity_percent,
          b.error_code,
          hash(b),
        ),
      );
      return success(data, data.duplicate ? 200 : 201);
    }
    if (endpoint === "device/heartbeat" && method === "POST") {
      const b = schema.heartbeatSchema.parse(await jsonBody(request));
      if (b.applied_config_version > config().version)
        throw new ApiError(
          422,
          "CONFIG_VERSION",
          "Versi konfigurasi belum diterbitkan.",
        );
      const data = dedup("heartbeats", "heartbeat_id", b.heartbeat_id, b, () =>
        run(
          "INSERT INTO heartbeats VALUES (?,?,?,?,?,?,?,?,?)",
          b.heartbeat_id,
          settings().deviceId,
          b.reported_at,
          isoNow(),
          b.lock_state,
          Number(b.fan_on),
          b.fan_mode,
          b.applied_config_version,
          hash(b),
        ),
      );
      return success(data, data.duplicate ? 200 : 201);
    }
    if (endpoint === "device/config" && method === "GET")
      return success(config());
    if (endpoint === "device/config/ack" && method === "POST") {
      const b = schema.ackSchema.parse(await jsonBody(request));
      const data = transaction(() => {
        if (b.version > config().version)
          throw new ApiError(
            422,
            "CONFIG_VERSION",
            "Versi konfigurasi belum diterbitkan.",
          );
        run(
          "UPDATE device SET applied_config_version=MAX(applied_config_version,?)",
          b.version,
        );
        touch();
        return { applied_config_version: device().applied_config_version };
      });
      return success(data);
    }
    if (endpoint === "device/commands" && method === "GET")
      return success(
        all<Command>(
          "SELECT * FROM commands WHERE status IN ('pending','received') AND expires_at>? ORDER BY created_at ASC LIMIT 50",
          isoNow(),
        )
          .map(effectiveCommand)
          .filter((c) => c.status === "pending" || c.status === "received"),
      );
    if (
      path[0] === "device" &&
      path[1] === "commands" &&
      path.length === 4 &&
      method === "POST"
    ) {
      const id = z.uuid().parse(path[2]);
      if (path[3] === "receipt") {
        schema.receiptSchema.parse(await jsonBody(request));
        return success(receipt(id));
      }
      if (path[3] === "result") {
        const body = schema.resultSchema.parse(await jsonBody(request));
        return success(commandResult(id, body));
      }
    }
    if (endpoint === "dashboard/summary" && method === "GET")
      return success(summary());
    if (endpoint === "dashboard/access-events" && method === "GET")
      return success(accessHistory(params));
    if (endpoint === "dashboard/environment" && method === "GET")
      return success(environment(params));
    if (endpoint === "dashboard/config" && method === "GET")
      return success(configState());
    if (endpoint === "dashboard/config" && method === "PUT") {
      const b = schema.configSchema.parse(await jsonBody(request));
      const data = transaction(() => {
        const c = config();
        if (c.version !== b.expected_version)
          throw new ApiError(
            409,
            "CONFIG_CONFLICT",
            "Konfigurasi telah berubah. Muat ulang sebelum menyimpan.",
          );
        run(
          "INSERT INTO configurations VALUES (?,?,?,?,?,?)",
          c.version + 1,
          b.fan_on_c,
          b.fan_off_c,
          b.fan_mode,
          b.unlock_duration_seconds,
          isoNow(),
        );
        audit(
          "config.updated",
          `Konfigurasi v${c.version + 1}: mode ${b.fan_mode}, ON ${b.fan_on_c}°C, OFF ${b.fan_off_c}°C, buka ${b.unlock_duration_seconds}s`,
        );
        return configState();
      });
      return success(data);
    }
    if (endpoint === "dashboard/commands" && method === "POST") {
      const b = schema.commandSchema.parse(await jsonBody(request)),
        data = createCommand(b);
      return success(data.command, data.duplicate ? 200 : 201);
    }
    if (endpoint === "dashboard/commands" && method === "GET") {
      const p = pagination(params);
      return success({
        items: all<Command>(
          "SELECT * FROM commands ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?",
          p.page_size,
          p.offset,
        ).map(effectiveCommand),
        total: one<{ count: number }>("SELECT COUNT(*) count FROM commands")!
          .count,
        page: p.page,
        page_size: p.page_size,
      });
    }
    if (endpoint === "dashboard/audit" && method === "GET") {
      const p = pagination(params, 20);
      const items = all<AuditEntry>(
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?",
        p.page_size,
        p.offset,
      ).map((a) =>
        a.command_id
          ? {
              ...a,
              detail: `${a.detail} · Status saat ini: ${effectiveCommand(getCommand(a.command_id)).status}`,
            }
          : a,
      );
      return success({
        items,
        total: one<{ count: number }>("SELECT COUNT(*) count FROM audit_log")!
          .count,
        page: p.page,
        page_size: p.page_size,
      });
    }
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Endpoint atau metode tidak tersedia.",
    );
  } catch (error) {
    let failure: ApiError;
    if (error instanceof ApiError) failure = error;
    else if (error instanceof z.ZodError)
      failure = new ApiError(
        422,
        "VALIDATION_ERROR",
        "Payload atau parameter tidak valid.",
        error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      );
    else {
      failure = new ApiError(
        500,
        "INTERNAL_ERROR",
        "Terjadi kesalahan server.",
      );
      console.error(
        JSON.stringify({
          request_id: requestId,
          endpoint,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
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
