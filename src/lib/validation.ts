import { z } from "zod";
import { now } from "./time";
export const timestamp = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString())
  .refine(
    (s) => new Date(s).getTime() <= now().getTime() + 30000,
    "Waktu lebih dari 30 detik di masa depan.",
  );
const nullableText = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .nullable()
  .optional()
  .default(null);
export const accessSchema = z
  .object({
    event_id: z.uuid(),
    occurred_at: timestamp,
    person_id: nullableText,
    person_name: nullableText,
    recognition: z.enum(["known", "unknown"]),
    decision: z.enum(["allowed", "denied"]),
    reason: z.string().trim().max(500).nullable().optional().default(null),
  })
  .strict();
export const readingSchema = z
  .object({
    reading_id: z.uuid(),
    measured_at: timestamp,
    status: z.enum(["ok", "error"]),
    temperature_c: z.number().min(-40).max(80).nullable(),
    humidity_percent: z.number().min(0).max(100).nullable(),
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
      v.status === "ok" &&
      (v.temperature_c === null ||
        v.humidity_percent === null ||
        v.error_code !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Status ok memerlukan angka sensor dan error_code null.",
      });
    if (
      v.status === "error" &&
      (v.temperature_c !== null || v.humidity_percent !== null || !v.error_code)
    )
      ctx.addIssue({
        code: "custom",
        message: "Status error memerlukan nilai null dan error_code.",
      });
  });
export const heartbeatSchema = z
  .object({
    heartbeat_id: z.uuid(),
    reported_at: timestamp,
    lock_state: z.enum(["locked", "unlocked", "unknown"]),
    fan_on: z.boolean(),
    fan_mode: z.enum(["automatic", "manual"]),
    applied_config_version: z.number().int().min(0),
  })
  .strict();
export const configSchema = z
  .object({
    expected_version: z.number().int().min(1),
    fan_on_c: z.number().min(-39).max(80),
    fan_off_c: z.number().min(-40).max(79),
    fan_mode: z.enum(["automatic", "manual"]),
    unlock_duration_seconds: z.number().int().min(1).max(30),
  })
  .strict()
  .refine(
    (v) => v.fan_off_c < v.fan_on_c,
    "Ambang OFF harus lebih rendah daripada ON.",
  );
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ command_id: z.uuid(), type: z.literal("unlock") }).strict(),
  z
    .object({
      command_id: z.uuid(),
      type: z.literal("set_fan"),
      fan_on: z.boolean(),
    })
    .strict(),
]);
export const ackSchema = z
  .object({ version: z.number().int().min(1) })
  .strict();
export const receiptSchema = z.object({}).strict();
export const resultSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    executed_at: timestamp,
    message: z.string().trim().max(500).optional().default(""),
  })
  .strict();
