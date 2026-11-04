export type FanMode = "automatic" | "manual";
export type CommandStatus =
  "pending" | "received" | "succeeded" | "failed" | "expired" | "unknown";
export interface Configuration {
  version: number;
  fan_on_c: number;
  fan_off_c: number;
  fan_mode: FanMode;
  unlock_duration_seconds: number;
  updated_at: string;
}
export interface AccessEvent {
  event_id: string;
  device_id: string;
  occurred_at: string;
  received_at: string;
  person_id: string | null;
  person_name: string | null;
  recognition: "known" | "unknown";
  decision: "allowed" | "denied";
  reason: string | null;
}
export interface Reading {
  reading_id: string;
  device_id: string;
  measured_at: string;
  received_at: string;
  status: "ok" | "error";
  temperature_c: number | null;
  humidity_percent: number | null;
  error_code: string | null;
}
export interface DeviceReport {
  heartbeat_id: string;
  device_id: string;
  reported_at: string;
  received_at: string;
  lock_state: "locked" | "unlocked" | "unknown";
  fan_on: boolean;
  fan_mode: FanMode;
  applied_config_version: number;
}
export interface Command {
  command_id: string;
  device_id: string;
  type: "unlock" | "set_fan";
  duration_seconds: number | null;
  fan_on: boolean | null;
  config_version: number;
  created_at: string;
  expires_at: string;
  result_deadline: string;
  received_at: string | null;
  completed_at: string | null;
  status: CommandStatus;
  message: string | null;
  source: "dashboard internal";
}
export interface AuditEntry {
  id: number;
  action: string;
  created_at: string;
  device_id: string;
  source: string;
  command_id: string | null;
  detail: string;
}
export interface FanChange {
  id: number;
  reported_at: string;
  fan_on: boolean;
  fan_mode: FanMode;
}
export interface Summary {
  mode: "simulation" | "real";
  server_time: string;
  device_id: string;
  online: boolean;
  last_contact_at: string | null;
  latest_reading: Reading | null;
  latest_valid_reading: Reading | null;
  sensor_failed: boolean;
  sensor_stale: boolean;
  device_status: DeviceReport | null;
  config: Configuration;
  applied_config_version: number;
  config_synced: boolean;
  today: { total: number; allowed: number; denied: number };
  recent_access: AccessEvent[];
  recent_commands: Command[];
  intervals: {
    dashboard_poll_seconds: number;
    sensor_seconds: number;
    heartbeat_seconds: number;
    command_poll_seconds: number;
    offline_after_seconds: number;
    sensor_stale_seconds: number;
  };
}
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
export interface EnvironmentResult {
  readings: Reading[];
  total: number;
  page: number;
  page_size: number;
  chart: Reading[];
  fan_changes: FanChange[];
  config: Configuration;
}
