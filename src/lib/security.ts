import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { settings } from "./env";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
export function deviceAuth(request: Request) {
  const env = settings();
  if (env.apiKey.length < 32)
    throw new ApiError(
      503,
      "NOT_CONFIGURED",
      "API key perangkat belum dikonfigurasi.",
    );
  if (request.headers.get("origin"))
    throw new ApiError(
      403,
      "DEVICE_ORIGIN",
      "API perangkat hanya untuk klien perangkat, bukan browser.",
    );
  if (
    request.headers.get("x-device-id") !== env.deviceId ||
    !equal(request.headers.get("x-api-key") || "", env.apiKey)
  ) {
    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "Kredensial perangkat tidak valid.",
    );
  }
}
export function csrfSession() {
  const secret = settings().csrfSecret;
  if (secret.length < 32)
    throw new ApiError(
      503,
      "NOT_CONFIGURED",
      "CSRF secret belum dikonfigurasi.",
    );
  const token = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret).update(token).digest("hex");
  return { token, cookie: `${token}.${signature}` };
}
export function dashboardMutation(request: Request) {
  const env = settings();
  const origin = request.headers.get("origin");
  if (!origin || !env.origins.includes(origin))
    throw new ApiError(403, "INVALID_ORIGIN", "Origin tidak diizinkan.");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new ApiError(403, "CROSS_SITE", "Request lintas situs ditolak.");
  const cookie =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("ssr_csrf="))
      ?.slice(9) || "";
  const [token, signature] = cookie.split(".");
  const header = request.headers.get("x-csrf-token") || "";
  if (
    env.csrfSecret.length < 32 ||
    !token ||
    !signature ||
    !equal(header, token) ||
    !equal(
      signature,
      createHmac("sha256", env.csrfSecret).update(token).digest("hex"),
    )
  ) {
    throw new ApiError(
      403,
      "CSRF_INVALID",
      "Token keamanan tidak valid. Muat ulang halaman.",
    );
  }
}
const buckets = new Map<string, { at: number; count: number }>();
export function rateLimit(key: string, maximum = 240) {
  const current = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || current - bucket.at >= 60000) {
    bucket = { at: current, count: 0 };
    buckets.set(key, bucket);
  }
  if (++bucket.count > maximum)
    throw new ApiError(
      429,
      "RATE_LIMIT",
      "Terlalu banyak permintaan. Tunggu 60 detik.",
    );
}
export async function jsonBody(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(415, "CONTENT_TYPE", "Gunakan application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "Body JSON diperlukan.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16384) {
      await reader.cancel();
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Payload maksimal 16 KiB.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "JSON tidak valid.");
  }
}
