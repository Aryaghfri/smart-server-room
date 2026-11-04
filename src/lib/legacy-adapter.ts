import { z } from "zod";
import type { SensorKind, Source } from "./monitoring-types";
import type { IncomingRecord } from "./monitoring-store";

export interface LegacyRow {
  id: unknown;
  suhu?: unknown;
  kelembapan?: unknown;
  status: unknown;
  create_date: unknown;
}
/** MySQL DATETIME tidak menyimpan zona. SQL Mas Togar dibaca sebagai WIB secara eksplisit. */
export function legacyTime(value: unknown) {
  if (typeof value !== "string")
    throw new Error("create_date wajib DATETIME yang tidak kosong.");
  const zone = process.env.MYSQL_TIME_ZONE || "+07:00";
  if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(zone))
    throw new Error("MYSQL_TIME_ZONE harus offset seperti +07:00.");
  const result = z.iso
    .datetime({ offset: true })
    .parse(value.replace(" ", "T") + zone);
  if (Date.parse(result) > Date.now() + 30_000)
    throw new Error(
      "create_date lebih dari 30 detik di masa depan; periksa jam dan MYSQL_TIME_ZONE.",
    );
  return new Date(result).toISOString();
}
function numberOrNull(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || String(value).trim() === "")
    return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
/** `dht.status` = kipas, `pir.status` = deteksi orang, `mq.status` = deteksi asap. */
export function adaptLegacyRow(
  kind: SensorKind,
  row: LegacyRow,
  source: Source,
  namespace: string,
): IncomingRecord {
  const id = z.coerce.number().int().positive().parse(row.id);
  const status =
    row.status === null
      ? null
      : z.union([z.literal(0), z.literal(1)]).parse(Number(row.status));
  let suhu = kind === "dht" ? numberOrNull(row.suhu, -40, 80) : null;
  let kelembapan = kind === "dht" ? numberOrNull(row.kelembapan, 0, 100) : null;
  const invalid = kind === "dht" && (suhu === null || kelembapan === null);
  if (invalid) {
    suhu = null;
    kelembapan = null;
  }
  return {
    record_key: `${namespace}:${kind}:${id}`,
    kind,
    source,
    source_id: String(id),
    measured_at: legacyTime(row.create_date),
    suhu,
    kelembapan,
    status,
    // Tabel PIR tidak mempunyai kolom umpan balik LED. Jangan menyatakan LED fisik sudah ON.
    lamp_on: null,
    error_code: invalid
      ? "INVALID_DHT_VALUE"
      : status === null && kind !== "dht"
        ? "SENSOR_UNAVAILABLE"
        : null,
  };
}
/** Parser terbatas untuk dump INSERT, tanpa menjalankan DROP TABLE maupun SQL dari berkas. */
export function parseLegacyDump(
  text: string,
  namespace: string,
): IncomingRecord[] {
  const result: IncomingRecord[] = [];
  const pattern =
    /INSERT\s+INTO\s+`?(dht|pir|mq)`?\s+VALUES\s*\(([^;]+)\)\s*;/gi;
  for (const match of text.matchAll(pattern)) {
    const fields = match[2].match(/'(?:\\.|''|[^'])*'|NULL|-?\d+(?:\.\d+)?/gi);
    if (!fields) throw new Error("Format INSERT tidak dikenal.");
    const values = fields.map((v) =>
      v.toUpperCase() === "NULL"
        ? null
        : v.startsWith("'")
          ? v.slice(1, -1).replace(/''/g, "'")
          : Number(v),
    );
    const kind = match[1].toLowerCase() as SensorKind;
    if (values.length !== (kind === "dht" ? 6 : 4))
      throw new Error(
        `Jumlah kolom ${kind} tidak cocok dengan dump Mas Togar.`,
      );
    const row: LegacyRow =
      kind === "dht"
        ? {
            id: values[0],
            suhu: values[1],
            kelembapan: values[2],
            status: values[3],
            create_date: values[4],
          }
        : { id: values[0], status: values[1], create_date: values[2] };
    result.push(adaptLegacyRow(kind, row, "sql_import", namespace));
  }
  if (!result.length)
    throw new Error(
      "Tidak ada INSERT dht/pir/mq yang dapat dibaca. Gunakan dump Navicat berisi satu baris INSERT per record.",
    );
  return result;
}
