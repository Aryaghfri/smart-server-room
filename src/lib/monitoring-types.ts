/** Kontrak bersama backend, dashboard, dan simulator. `status` selalu mengikuti tabel Mas Togar. */
export type SensorKind = "dht" | "pir" | "mq";
export type Source = "api" | "mysql" | "sql_import" | "simulator";
export interface SensorRecord {
  record_key: string;
  kind: SensorKind;
  source: Source;
  source_id: string;
  measured_at: string;
  received_at: string;
  suhu: number | null;
  kelembapan: number | null;
  status: 0 | 1 | null;
  lamp_on: 0 | 1 | null;
  error_code: string | null;
}
export interface MonitorConfig {
  version: number;
  fan_on_c: number;
  fan_off_c: number;
  updated_at: string;
}
export interface Recipient {
  id: number;
  email: string;
  name: string;
  enabled: number;
  created_at: string;
}
export interface SmokeIncident {
  id: string;
  detected_at: string;
  resolved_at: string | null;
  source: Source;
  emails: {
    recipient_email: string;
    status: string;
    completed_at: string | null;
    detail: string | null;
  }[];
}
export interface MonitorSummary {
  dashboard_poll_seconds: number;
  mode: "simulation" | "real";
  data_source: "api" | "mysql";
  device_id: string;
  server_time: string;
  online: boolean;
  last_contact_at: string | null;
  latest: Record<SensorKind, SensorRecord | null>;
  stale: Record<SensorKind, boolean>;
  counts: {
    dht: number;
    pir: number;
    mq: number;
    motion_samples_today: number;
    smoke_samples_today: number;
  };
  chart: SensorRecord[];
  recent: SensorRecord[];
  incidents: SmokeIncident[];
  config: MonitorConfig;
  applied_config_version: number;
  source_counts: { source: Source; total: number }[];
  email: {
    configured: boolean;
    recipients: number;
    worker_last_seen: string | null;
  };
  integration: {
    rejected_rows: number;
    last_sync_at: string | null;
    last_error: string | null;
    worker_last_seen: string | null;
  };
}
