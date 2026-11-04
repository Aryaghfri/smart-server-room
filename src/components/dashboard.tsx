"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  Fan,
  Fingerprint,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Menu,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Thermometer,
  UnlockKeyhole,
  Waves,
  WifiOff,
  X,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AccessEvent,
  AuditEntry,
  Command,
  Configuration,
  EnvironmentResult,
  PageResult,
  Summary,
} from "@/lib/contracts";

type Tab = "overview" | "access" | "environment" | "control" | "settings";
type Tone = "green" | "amber" | "red" | "blue" | "gray";
type ConfigResult = {
  config: Configuration;
  applied_config_version: number;
  config_synced: boolean;
  device_id: string;
};
type Attempt = {
  command_id: string;
  type: "unlock" | "set_fan";
  fan_on?: boolean;
};
const navigation = [
  { id: "overview" as const, title: "Ringkasan", icon: LayoutDashboard },
  { id: "access" as const, title: "Riwayat akses", icon: Fingerprint },
  { id: "environment" as const, title: "Lingkungan", icon: Activity },
  { id: "control" as const, title: "Kontrol manual", icon: SlidersHorizontal },
  { id: "settings" as const, title: "Pengaturan", icon: Settings2 },
];
const titles: Record<Tab, { heading: string; subtitle: string }> = {
  overview: {
    heading: "Ringkasan ruang server",
    subtitle: "Pantau akses dan kondisi ruangan, dalam satu tempat.",
  },
  access: {
    heading: "Riwayat akses",
    subtitle:
      "Setiap percobaan akses tercatat. Keputusan izin terpisah dari pengenalan wajah.",
  },
  environment: {
    heading: "Monitoring lingkungan",
    subtitle: "Suhu, kelembapan, dan aktivitas kipas sepanjang waktu.",
  },
  control: {
    heading: "Kontrol manual",
    subtitle: "Kirim perintah ke perangkat dan pantau hasil eksekusinya.",
  },
  settings: {
    heading: "Pengaturan sistem",
    subtitle: "Satu konfigurasi untuk dashboard dan perangkat pengendali.",
  },
};
const commandLabels: Record<Command["status"], { label: string; tone: Tone }> =
  {
    pending: { label: "Menunggu", tone: "amber" },
    received: { label: "Diterima perangkat", tone: "blue" },
    succeeded: { label: "Berhasil", tone: "green" },
    failed: { label: "Gagal", tone: "red" },
    expired: { label: "Kedaluwarsa", tone: "gray" },
    unknown: { label: "Hasil belum diketahui", tone: "amber" },
  };
const attemptKey = "smart-server-room:v1:unresolved-command";
function time(value: string | null | undefined, full = false) {
  if (!value) return "Belum tersedia";
  return (
    new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      ...(full
        ? ({ day: "2-digit", month: "short", year: "numeric" } as const)
        : {}),
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(value)) + " WIB"
  );
}
function value(number: number | null | undefined) {
  return number == null
    ? "—"
    : number.toLocaleString("id-ID", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
}
function newCommandId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // getRandomValues remains available on internal HTTP origins without randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message || `Server mengembalikan HTTP ${response.status}.`,
    );
  if (!body || !("data" in body))
    throw new Error("Format respons server tidak sesuai.");
  return body.data as T;
}

function useApi<T>(path: string | null, seconds: number, revision: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    setLoading(true);
    setData(null);
    async function refresh() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const result = await api<T>(path!, { signal: controller.signal });
        if (live) {
          setData(result);
          setError("");
          setUpdatedAt(new Date().toISOString());
        }
      } catch (error) {
        if (live)
          setError(
            error instanceof Error && error.name !== "AbortError"
              ? error.message
              : "Koneksi ke server melewati batas waktu.",
          );
      } finally {
        clearTimeout(timeout);
        if (live) {
          setLoading(false);
          timer = setTimeout(refresh, seconds * 1000);
        }
      }
    }
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [path, seconds, revision]);
  return { data, error, loading, updatedAt };
}

function Badge({
  children,
  tone = "gray",
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="status-dot" />}
      {children}
    </span>
  );
}
function Empty({
  text = "Belum ada data",
  detail = "Data akan muncul setelah perangkat mengirimkannya.",
}: {
  text?: string;
  detail?: string;
}) {
  return (
    <div className="empty">
      <Activity size={25} />
      <strong>{text}</strong>
      <p>{detail}</p>
    </div>
  );
}
function Loading({ text = "Memuat data perangkat…" }: { text?: string }) {
  return (
    <div className="loading">
      <LoaderCircle size={19} className="spin" />
      {text}
    </div>
  );
}
function ErrorState({ message }: { message: string }) {
  return (
    <div className="inline-error" role="alert">
      <CircleAlert size={17} />
      <span>{message}</span>
    </div>
  );
}
function Pagination({
  page,
  total,
  size,
  onChange,
}: {
  page: number;
  total: number;
  size: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pagination">
      <span>
        {total === 0
          ? "0 catatan"
          : `${(page - 1) * size + 1}–${Math.min(page * size, total)} dari ${total} catatan`}
      </span>
      <div>
        <button
          aria-label="Halaman sebelumnya"
          className="icon-button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          Halaman {page} / {pages}
        </span>
        <button
          aria-label="Halaman berikutnya"
          className="icon-button"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function AccessTable({
  events,
  compact = false,
  filtered = false,
}: {
  events: AccessEvent[];
  compact?: boolean;
  filtered?: boolean;
}) {
  if (!events.length)
    return (
      <Empty
        text={
          filtered ? "Tidak ada hasil yang sesuai" : "Belum ada percobaan akses"
        }
        detail={
          filtered
            ? "Ubah kata pencarian atau rentang filter untuk melihat catatan lain."
            : "Kejadian akses dari perangkat akan tercatat di sini."
        }
      />
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Identitas</th>
            <th>Waktu kejadian</th>
            <th>Pengenalan</th>
            <th>Keputusan</th>
            {!compact && (
              <>
                <th>Alasan</th>
                <th>ID & penerimaan</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.event_id}>
              <td>
                <div className="person">
                  <span
                    className={`avatar ${event.recognition === "unknown" ? "avatar-unknown" : ""}`}
                  >
                    {event.person_name ? (
                      event.person_name
                        .split(" ")
                        .slice(0, 2)
                        .map((n) => n[0])
                        .join("")
                        .toUpperCase()
                    ) : (
                      <Fingerprint size={17} />
                    )}
                  </span>
                  <div>
                    <strong>{event.person_name || "Tidak dikenal"}</strong>
                    <small>
                      {event.person_id || "Identitas tidak tersedia"}
                    </small>
                  </div>
                </div>
              </td>
              <td className="nowrap">{time(event.occurred_at, !compact)}</td>
              <td>
                <span
                  className={`recognition ${event.recognition === "unknown" ? "muted" : ""}`}
                >
                  {event.recognition === "known" ? (
                    <>
                      <ShieldCheck size={14} /> Dikenal
                    </>
                  ) : (
                    "Tidak dikenal"
                  )}
                </span>
              </td>
              <td>
                <Badge
                  tone={event.decision === "allowed" ? "green" : "red"}
                  dot
                >
                  {event.decision === "allowed" ? "Diizinkan" : "Ditolak"}
                </Badge>
              </td>
              {!compact && (
                <>
                  <td>{event.reason || "—"}</td>
                  <td>
                    <span className="code" title={event.event_id}>
                      {event.event_id}
                    </span>
                    <small>{event.device_id}</small>
                    <small>{time(event.received_at, true)}</small>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function EnvironmentChart({
  result,
  loading,
  hours,
  onHours,
  error,
}: {
  result: EnvironmentResult | null;
  loading: boolean;
  hours: number;
  onHours: (n: number) => void;
  error: string;
}) {
  const chart = useMemo(
    () =>
      result?.chart
        .slice()
        .sort((a, b) => a.measured_at.localeCompare(b.measured_at))
        .map((row) => ({
          ...row,
          timestamp: new Date(row.measured_at).getTime(),
        })) || [],
    [result],
  );
  return (
    <Panel
      title="Kondisi lingkungan"
      description="Pembacaan sensor sepanjang waktu"
      action={
        <select
          className="select-compact"
          aria-label="Rentang grafik lingkungan"
          value={hours}
          onChange={(e) => onHours(Number(e.target.value))}
        >
          <option value={1}>1 jam terakhir</option>
          <option value={6}>6 jam terakhir</option>
          <option value={24}>24 jam terakhir</option>
          <option value={72}>3 hari terakhir</option>
          <option value={168}>7 hari terakhir</option>
        </select>
      }
    >
      {error && <ErrorState message={`Grafik belum diperbarui: ${error}`} />}
      <div className="chart-legend">
        <span>
          <i className="legend-temperature" />
          Suhu <b>°C</b>
        </span>
        <span>
          <i className="legend-humidity" />
          Kelembapan <b>%</b>
        </span>
        <span className="legend-threshold">
          <i />
          Ambang kipas ON
        </span>
      </div>
      {loading ? (
        <Loading />
      ) : !chart.length ? (
        <Empty
          text="Menunggu pembacaan sensor"
          detail="Grafik akan terisi dari data yang diterima melalui API perangkat."
        />
      ) : (
        <div
          className="chart"
          aria-label="Grafik suhu dan kelembapan, data lengkap tersedia pada tabel monitoring lingkungan"
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chart}
              margin={{ top: 15, right: 0, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient
                  id="temperatureFill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="#199c88" stopOpacity={0.16} />
                  <stop offset="100%" stopColor="#199c88" stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 5"
                vertical={false}
                stroke="#e8eeed"
              />
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(n) =>
                  new Intl.DateTimeFormat("id-ID", {
                    timeZone: "Asia/Jakarta",
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(n))
                }
                axisLine={false}
                tickLine={false}
                minTickGap={45}
                tick={{ fill: "#8b969a", fontSize: 11 }}
              />
              <YAxis
                yAxisId="temp"
                domain={["auto", "auto"]}
                tick={{ fill: "#8b969a", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="humidity"
                orientation="right"
                domain={[0, 100]}
                tick={{ fill: "#8b969a", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={33}
              />
              <Tooltip
                labelFormatter={(n) =>
                  time(new Date(Number(n)).toISOString(), true)
                }
                formatter={(n, name) => [
                  n == null
                    ? "Sensor gagal"
                    : `${Number(n).toFixed(1)}${name === "Suhu" ? " °C" : " %"}`,
                  name,
                ]}
                contentStyle={{
                  border: "1px solid #e5ebeb",
                  borderRadius: 10,
                  fontSize: 12,
                }}
              />
              <ReferenceLine
                yAxisId="temp"
                y={result?.config.fan_on_c}
                stroke="#d8b573"
                strokeDasharray="5 5"
              />
              <Area
                yAxisId="temp"
                type="monotone"
                name="Suhu"
                dataKey="temperature_c"
                stroke="#199c88"
                strokeWidth={2.5}
                fill="url(#temperatureFill)"
                connectNulls={false}
                isAnimationActive={false}
                dot={chart.length < 3}
              />
              <Line
                yAxisId="humidity"
                type="monotone"
                name="Kelembapan"
                dataKey="humidity_percent"
                stroke="#7e9cd4"
                strokeWidth={2}
                dot={chart.length < 3}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="chart-footer">
        <span>
          <span className="tiny-dot" /> Pengukuran dalam WIB
        </span>
        <span>Maks. 180 sampel per grafik</span>
      </div>
    </Panel>
  );
}

function ConfigForm({
  config,
  synced,
  applied,
  onSave,
  busy,
}: {
  config: Configuration;
  synced: boolean;
  applied: number;
  onSave: (config: Configuration) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(config);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(config);
  }, [config, dirty]);
  const set = (changes: Partial<Configuration>) => {
    setDraft({ ...draft, ...changes });
    setDirty(true);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await onSave(draft);
      setDirty(false);
    } catch {
      /* The shared mutation banner reports the error. */
    }
  }
  return (
    <Panel
      title="Konfigurasi perangkat"
      description="Perubahan diterapkan setelah dikonfirmasi oleh perangkat."
      action={
        <Badge tone={synced ? "green" : "amber"} dot>
          {synced ? "Tersinkronisasi" : "Menunggu perangkat"}
        </Badge>
      }
    >
      <form className="config-form" onSubmit={submit}>
        <div className="form-section-heading">
          <Thermometer size={19} />
          <div>
            <h3>Otomatisasi kipas</h3>
            <p>Histeresis menjaga kipas tetap stabil di antara dua ambang.</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Suhu kipas menyala
            <div className="input-unit">
              <input
                required
                type="number"
                step="0.1"
                min="-39"
                max="80"
                value={draft.fan_on_c}
                onChange={(e) => set({ fan_on_c: Number(e.target.value) })}
              />
              <span>°C</span>
            </div>
            <small>Kipas ON saat suhu mencapai ambang ini.</small>
          </label>
          <label>
            Suhu kipas mati
            <div className="input-unit">
              <input
                required
                type="number"
                step="0.1"
                min="-40"
                max="79"
                value={draft.fan_off_c}
                onChange={(e) => set({ fan_off_c: Number(e.target.value) })}
              />
              <span>°C</span>
            </div>
            <small>Harus lebih rendah dari ambang ON.</small>
          </label>
        </div>
        <label className="field-label">
          Mode kipas
          <select
            value={draft.fan_mode}
            onChange={(e) =>
              set({ fan_mode: e.target.value as Configuration["fan_mode"] })
            }
          >
            <option value="automatic">Otomatis — mengikuti sensor</option>
            <option value="manual">Manual — mengikuti perintah ON/OFF</option>
          </select>
        </label>
        <div className="form-section-heading with-divider">
          <LockKeyhole size={19} />
          <div>
            <h3>Kontrol akses</h3>
            <p>Perangkat mengunci kembali setelah durasi berakhir.</p>
          </div>
        </div>
        <label className="field-label">
          Durasi buka kunci
          <div className="input-unit duration-input">
            <input
              required
              type="number"
              min="1"
              max="30"
              step="1"
              value={draft.unlock_duration_seconds}
              onChange={(e) =>
                set({ unlock_duration_seconds: Number(e.target.value) })
              }
            />
            <span>detik</span>
          </div>
        </label>
        {draft.fan_off_c >= draft.fan_on_c && (
          <ErrorState message="Ambang OFF harus lebih rendah dari ambang ON." />
        )}
        {dirty && draft.version !== config.version && (
          <ErrorState message="Konfigurasi di server sudah berubah. Muat ulang versi terbaru sebelum menyimpan." />
        )}
        <div className="form-bottom">
          <span>
            Server <b>v{config.version}</b> <ArrowRight size={14} /> Perangkat{" "}
            <b>v{applied}</b>
          </span>
          <div>
            {dirty && (
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(config);
                  setDirty(false);
                }}
              >
                Batalkan
              </button>
            )}
            <button
              type="submit"
              className="button button-primary"
              disabled={
                busy ||
                !dirty ||
                draft.fan_off_c >= draft.fan_on_c ||
                draft.version !== config.version
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              Simpan konfigurasi
            </button>
          </div>
        </div>
      </form>
    </Panel>
  );
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [hours, setHours] = useState(24);
  const [accessPage, setAccessPage] = useState(1);
  const [environmentPage, setEnvironmentPage] = useState(1);
  const [commandPage, setCommandPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [filters, setFilters] = useState({
    q: "",
    from: "",
    to: "",
    decision: "",
  });
  const [query, setQuery] = useState(filters);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const [poll, setPoll] = useState(5);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const csrfRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const summaryApi = useApi<Summary>("/dashboard/summary", poll, revision);
  const summary = summaryApi.data;
  const commandStorageKey = summary
    ? `${attemptKey}:${summary.mode}:${summary.device_id}`
    : null;
  const environmentApi = useApi<EnvironmentResult>(
    tab === "overview" || tab === "environment"
      ? `/dashboard/environment?hours=${hours}&page=${environmentPage}&page_size=10`
      : null,
    poll,
    revision,
  );
  const search = new URLSearchParams({
    ...query,
    page: String(accessPage),
    page_size: "10",
  });
  const accessApi = useApi<PageResult<AccessEvent>>(
    tab === "access" ? `/dashboard/access-events?${search}` : null,
    poll,
    revision,
  );
  const commandsApi = useApi<PageResult<Command>>(
    tab === "control"
      ? `/dashboard/commands?page=${commandPage}&page_size=8`
      : null,
    poll,
    revision,
  );
  const auditApi = useApi<PageResult<AuditEntry>>(
    tab === "control" ? `/dashboard/audit?page=${auditPage}&page_size=8` : null,
    poll,
    revision,
  );
  const configApi = useApi<ConfigResult>(
    tab === "settings" ? "/dashboard/config" : null,
    poll,
    revision,
  );
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const config =
    configApi.data?.config && tab === "settings"
      ? configApi.data.config
      : summary?.config;
  const online = !!summary?.online && !summaryApi.error;
  const stale =
    !!summary &&
    (summary.sensor_stale || summary.sensor_failed || !!summaryApi.error);
  const reading =
    summary?.latest_reading?.status === "ok"
      ? summary.latest_reading
      : summary?.latest_valid_reading;
  const controlsDisabled = busy || !online || !summary || !!attempt;

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (navigation.some((n) => n.id === hash)) setTab(hash as Tab);
    function hashChange() {
      const next = window.location.hash.slice(1);
      if (navigation.some((n) => n.id === next)) setTab(next as Tab);
    }
    window.addEventListener("hashchange", hashChange);
    void api<{ csrf_token: string }>("/dashboard/session")
      .then((s) => {
        csrfRef.current = s.csrf_token;
      })
      .catch(() => {});
    return () => window.removeEventListener("hashchange", hashChange);
  }, []);
  useEffect(() => {
    if (summary) setPoll(summary.intervals.dashboard_poll_seconds);
  }, [summary?.intervals.dashboard_poll_seconds]);
  useEffect(() => {
    if (!commandStorageKey) return;
    try {
      const saved = localStorage.getItem(commandStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.command_id && ["unlock", "set_fan"].includes(parsed.type))
          setAttempt(parsed);
      } else setAttempt(null);
    } catch {
      /* Local storage may be unavailable. In-memory command IDs remain stable. */
    }
  }, [commandStorageKey]);
  useEffect(() => {
    if (confirmUnlock) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [confirmUnlock]);
  function navigate(next: Tab) {
    setTab(next);
    setMenuOpen(false);
    window.history.replaceState(null, "", `#${next}`);
  }
  function keepAttempt(next: Attempt | null) {
    setAttempt(next);
    if (!commandStorageKey) return;
    try {
      if (next) localStorage.setItem(commandStorageKey, JSON.stringify(next));
      else localStorage.removeItem(commandStorageKey);
    } catch {
      /* Do not block requests when storage is restricted. */
    }
  }
  async function mutate<T>(
    path: string,
    method: "POST" | "PUT",
    payload: unknown,
  ) {
    if (!csrfRef.current)
      csrfRef.current = (
        await api<{ csrf_token: string }>("/dashboard/session")
      ).csrf_token;
    return api<T>(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfRef.current,
      },
      body: JSON.stringify(payload),
    });
  }
  async function sendCommand(payload: Attempt) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setBusy(true);
    setNotice(null);
    keepAttempt(payload);
    setConfirmUnlock(false);
    try {
      const command = await mutate<Command>(
        "/dashboard/commands",
        "POST",
        payload,
      );
      keepAttempt(null);
      setNotice({
        message: `Perintah ${command.command_id.slice(0, 8)} tersimpan. Status: ${commandLabels[command.status].label.toLowerCase()}. Hasil eksekusi mengikuti konfirmasi perangkat.`,
        error: false,
      });
      refresh();
    } catch (error) {
      setNotice({
        message: `Pengiriman belum terkonfirmasi: ${error instanceof Error ? error.message : "Koneksi terputus."} Periksa riwayat perintah; percobaan ulang akan memakai ID yang sama.`,
        error: true,
      });
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }
  async function saveConfig(next: Configuration) {
    setBusy(true);
    setNotice(null);
    try {
      await mutate<ConfigResult>("/dashboard/config", "PUT", {
        expected_version: next.version,
        fan_on_c: next.fan_on_c,
        fan_off_c: next.fan_off_c,
        fan_mode: next.fan_mode,
        unlock_duration_seconds: next.unlock_duration_seconds,
      });
      setNotice({
        message:
          "Konfigurasi tersimpan di server. Penerapan pada perangkat menunggu konfirmasi versi.",
        error: false,
      });
      refresh();
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : "Konfigurasi gagal disimpan.",
        error: true,
      });
      throw error;
    } finally {
      setBusy(false);
    }
  }
  function setRange(next: number) {
    setHours(next);
    setEnvironmentPage(1);
  }
  const device = summary?.device_status;

  return (
    <div className="app-shell">
      {menuOpen && (
        <button
          className="mobile-scrim"
          aria-label="Tutup navigasi"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <a
          href="#overview"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span className="brand-mark">
            <Server size={24} strokeWidth={1.8} />
          </span>
          <div>
            Smart Server Room<small>ACCESS & ENVIRONMENT</small>
          </div>
        </a>
        <div className="workspace-card">
          <span className="workspace-icon">
            <Server size={18} />
          </span>
          <div>
            <strong>Ruang Server</strong>
            <small>Kelompok KELAPA</small>
          </div>
          <span className="workspace-dot" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Navigasi utama">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
            >
              <item.icon size={19} strokeWidth={1.8} />
              <span>{item.title}</span>
              {tab === item.id && <span className="active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="tiny-dot" />
            <span>Dashboard internal</span>
            <LockKeyhole size={13} />
          </div>
          <div className="university">
            <span className="university-mark">
              BINUS<span>●</span>
            </span>
            <small>ONLINE UNIVERSITY</small>
            <div>
              Proyek Internet of Things<small>Kelompok KELAPA</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Buka navigasi"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{navigation.find((n) => n.id === tab)?.title}</strong>
          </div>
          <div className="topbar-right">
            {summary && (
              <Badge tone={summary.mode === "simulation" ? "amber" : "blue"}>
                <span className="status-dot" />
                {summary.mode === "simulation"
                  ? "MODE SIMULASI"
                  : "MODE PERANGKAT NYATA"}
              </Badge>
            )}
            <span className="top-divider" />
            <span className="team-avatar">K</span>
            <div className="team-label">
              <strong>KELAPA</strong>
              <span>Tim proyek</span>
            </div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">ACCESS & ENVIRONMENT MONITORING</div>
              <h1>{titles[tab].heading}</h1>
              <p>{titles[tab].subtitle}</p>
            </div>
            <button
              className="button button-white refresh-button"
              onClick={refresh}
              disabled={summaryApi.loading}
            >
              <RefreshCw
                size={15}
                className={summaryApi.loading ? "spin" : ""}
              />
              Perbarui
            </button>
          </div>
          <div className="connection-strip">
            <span>
              <span
                className={`live-dot ${summaryApi.error ? "is-offline" : ""}`}
              />
              {summaryApi.error
                ? "Koneksi dashboard terputus"
                : summaryApi.loading
                  ? "Menghubungkan ke server"
                  : `Pembaruan otomatis setiap ${poll} detik`}
            </span>
            <span>
              <Clock3 size={13} />
              Terakhir diperbarui: {time(summaryApi.updatedAt)}
            </span>
          </div>
          {summaryApi.error && (
            <ErrorState
              message={`Data mungkin sudah lama. ${summaryApi.error} Kontrol dinonaktifkan sampai koneksi pulih.`}
            />
          )}
          {notice && (
            <div
              className={`notice ${notice.error ? "notice-error" : ""}`}
              role={notice.error ? "alert" : "status"}
            >
              {notice.error ? (
                <CircleAlert size={19} />
              ) : (
                <CheckCheck size={19} />
              )}
              <span>{notice.message}</span>
              <button
                className="icon-button"
                aria-label="Tutup pesan"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {summaryApi.loading && !summary ? (
            <div className="initial-loading">
              <Loading />
              <p>Mengambil kondisi, riwayat, dan konfigurasi dari server.</p>
            </div>
          ) : !summary ? (
            <Empty
              text="Dashboard belum terhubung"
              detail="Pastikan server berjalan, lalu klik Perbarui untuk mencoba kembali."
            />
          ) : (
            <>
              {!summary.online && (
                <div className="status-banner">
                  <WifiOff size={19} />
                  <div>
                    <strong>Perangkat offline</strong>
                    <span>
                      {summary.last_contact_at
                        ? `Komunikasi terakhir ${time(summary.last_contact_at, true)}. Laporan perangkat di bawah adalah data terakhir.`
                        : "Belum ada komunikasi perangkat. Jalankan simulator atau hubungkan pengendali."}
                    </span>
                  </div>
                </div>
              )}
              {summary.sensor_failed && (
                <div className="status-banner status-banner-error">
                  <CircleAlert size={19} />
                  <div>
                    <strong>Sensor gagal membaca</strong>
                    <span>
                      {summary.latest_reading?.error_code ||
                        "Tidak ada nilai pengukuran yang valid."}{" "}
                      · Nilai terakhir adalah data lama.
                      {reading && ` Diukur ${time(reading.measured_at, true)}.`}
                    </span>
                  </div>
                </div>
              )}
              {summary.sensor_stale && !summary.sensor_failed && (
                <div className="status-banner">
                  <Clock3 size={19} />
                  <div>
                    <strong>Data sensor usang</strong>
                    <span>
                      {reading
                        ? `Pembacaan valid terakhir ` +
                          time(reading.measured_at, true) +
                          ". Nilai di bawah adalah data lama."
                        : "Belum ada pengukuran valid. Status ini terpisah dari konektivitas perangkat."}
                    </span>
                  </div>
                </div>
              )}
              {(tab === "overview" || tab === "environment") && (
                <div className="metrics-grid">
                  <Metric title="Suhu ruangan" icon={<Thermometer size={20} />}>
                    <div className="metric-number">
                      {value(reading?.temperature_c)}
                      <span>°C</span>
                    </div>
                    <div className="metric-note">
                      <Badge
                        tone={
                          stale
                            ? "amber"
                            : reading
                              ? reading.temperature_c! >=
                                summary.config.fan_on_c
                                ? "amber"
                                : "green"
                              : "gray"
                        }
                        dot
                      >
                        {stale && reading
                          ? "Data lama"
                          : !reading
                            ? "Belum ada data"
                            : reading.temperature_c! >= summary.config.fan_on_c
                              ? "Di atas ambang ON"
                              : "Di bawah ambang ON"}
                      </Badge>
                      <small>
                        {reading
                          ? time(reading.measured_at)
                          : "Menunggu sensor"}
                      </small>
                    </div>
                  </Metric>
                  <Metric title="Kelembapan" icon={<Waves size={20} />}>
                    <div className="metric-number">
                      {value(reading?.humidity_percent)}
                      <span>%</span>
                    </div>
                    <div className="metric-note">
                      <span className="subtle-label">
                        {stale && reading ? "Data lama" : "Kelembapan relatif"}
                      </span>
                      <small>
                        {reading
                          ? time(reading.measured_at)
                          : "Menunggu sensor"}
                      </small>
                    </div>
                  </Metric>
                  <Metric title="Status kunci" icon={<LockKeyhole size={19} />}>
                    <div className="metric-state">
                      {!device || device.lock_state === "unknown"
                        ? "Tidak diketahui"
                        : device.lock_state === "locked"
                          ? "Terkunci"
                          : "Terbuka"}
                      {device && device.lock_state === "locked" && (
                        <span className="check-circle">
                          <Check size={13} />
                        </span>
                      )}
                    </div>
                    <div className="metric-note">
                      <span className="subtle-label">
                        {!online
                          ? "Laporan terakhir · data lama"
                          : "Laporan pengendali"}
                      </span>
                      <small>
                        {device
                          ? time(device.reported_at)
                          : "Belum ada laporan"}
                      </small>
                    </div>
                  </Metric>
                  <Metric title="Status kipas" icon={<Fan size={20} />}>
                    <div className="metric-state">
                      {device
                        ? device.fan_on
                          ? "Menyala"
                          : "Mati"
                        : "Belum diketahui"}
                      {device && (
                        <Badge tone={device.fan_on ? "green" : "gray"}>
                          {device.fan_on ? "ON" : "OFF"}
                        </Badge>
                      )}
                    </div>
                    <div className="metric-note">
                      <span className="subtle-label">
                        {device
                          ? `Mode ${device.fan_mode === "automatic" ? "otomatis" : "manual"}${!online ? " · data lama" : ""}`
                          : "Menunggu perangkat"}
                      </span>
                      <small>{device ? time(device.reported_at) : "—"}</small>
                    </div>
                  </Metric>
                </div>
              )}
              {tab === "overview" && (
                <>
                  <div className="overview-grid">
                    <EnvironmentChart
                      result={environmentApi.data}
                      loading={environmentApi.loading}
                      hours={hours}
                      onHours={setRange}
                      error={environmentApi.error}
                    />
                    <Panel
                      title="Perangkat pengendali"
                      action={
                        <span className="device-small-icon">
                          <Server size={18} />
                        </span>
                      }
                    >
                      <div className="device-identity">
                        <div className="device-icon">
                          <Server size={28} strokeWidth={1.6} />
                        </div>
                        <div>
                          <strong>{summary.device_id}</strong>
                          <span>Pengendali ruang server</span>
                        </div>
                        <Badge tone={online ? "green" : "gray"} dot>
                          {online ? "Online" : "Offline"}
                        </Badge>
                      </div>
                      <div className="device-details">
                        <div>
                          <span>Komunikasi terakhir</span>
                          <strong>{time(summary.last_contact_at)}</strong>
                        </div>
                        <div>
                          <span>Sinkronisasi konfigurasi</span>
                          <Badge
                            tone={summary.config_synced ? "green" : "amber"}
                          >
                            {summary.config_synced
                              ? `Sinkron · v${summary.config.version}`
                              : `Menunggu · v${summary.config.version}`}
                          </Badge>
                        </div>
                        <div>
                          <span>Ambang kipas ON / OFF</span>
                          <strong>
                            {summary.config.fan_on_c}° /{" "}
                            {summary.config.fan_off_c}° C
                          </strong>
                        </div>
                        <div>
                          <span>Kondisi sensor</span>
                          <Badge
                            tone={
                              summary.sensor_failed
                                ? "red"
                                : stale
                                  ? "amber"
                                  : "green"
                            }
                          >
                            {summary.sensor_failed
                              ? "Gagal membaca"
                              : stale
                                ? "Data usang"
                                : "Pembacaan terkini"}
                          </Badge>
                        </div>
                      </div>
                      <div className="device-info">
                        <CircleHelp size={16} />
                        <p>
                          Status kunci berasal dari pengendali, bukan posisi
                          fisik daun pintu.
                        </p>
                      </div>
                      <button
                        className="panel-link full"
                        onClick={() => navigate("settings")}
                      >
                        Lihat pengaturan perangkat
                        <ArrowRight size={15} />
                      </button>
                    </Panel>
                  </div>
                  <div className="access-totals">
                    <div className="access-total-title">
                      <span className="access-total-icon">
                        <Fingerprint size={21} />
                      </span>
                      <div>
                        <strong>Akses hari ini</strong>
                        <small>Berdasarkan waktu kejadian · WIB</small>
                      </div>
                    </div>
                    <div className="access-count">
                      <span>Total percobaan</span>
                      <strong>
                        {summary.today.total}
                        <small>percobaan</small>
                      </strong>
                    </div>
                    <div className="access-count">
                      <span>
                        <span className="tiny-dot" />
                        Diizinkan
                      </span>
                      <strong>
                        {summary.today.allowed}
                        <span className="count-arrow green">
                          <ArrowUp size={16} />
                        </span>
                      </strong>
                    </div>
                    <div className="access-count">
                      <span>
                        <span className="tiny-dot red" />
                        Ditolak
                      </span>
                      <strong>
                        {summary.today.denied}
                        <span className="count-arrow red">
                          <ShieldCheck size={16} />
                        </span>
                      </strong>
                    </div>
                  </div>
                  <Panel
                    title="Aktivitas akses terbaru"
                    description="Hasil pengenalan dan keputusan izin dari perangkat"
                    action={
                      <button
                        className="panel-link"
                        onClick={() => navigate("access")}
                      >
                        Lihat semua
                        <ArrowRight size={15} />
                      </button>
                    }
                  >
                    <AccessTable
                      events={summary.recent_access.slice(0, 5)}
                      compact
                    />
                    <div className="table-footnote">
                      <CircleHelp size={13} />
                      Akses diizinkan bukan bukti seseorang telah masuk ke
                      ruangan.
                    </div>
                  </Panel>
                </>
              )}
              {tab === "access" && (
                <Panel
                  title="Catatan percobaan akses"
                  description="Waktu kejadian dan penerimaan server ditampilkan dalam WIB."
                >
                  <form
                    className="filters"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setQuery(filters);
                      setAccessPage(1);
                    }}
                  >
                    <label className="search-field">
                      <span className="sr-only">Cari nama atau ID</span>
                      <Search size={17} />
                      <input
                        placeholder="Cari nama atau ID…"
                        value={filters.q}
                        onChange={(e) =>
                          setFilters({ ...filters, q: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Dari tanggal
                      <input
                        type="date"
                        value={filters.from}
                        onChange={(e) =>
                          setFilters({ ...filters, from: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Sampai tanggal
                      <input
                        type="date"
                        min={filters.from || undefined}
                        value={filters.to}
                        onChange={(e) =>
                          setFilters({ ...filters, to: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Keputusan
                      <select
                        value={filters.decision}
                        onChange={(e) =>
                          setFilters({ ...filters, decision: e.target.value })
                        }
                      >
                        <option value="">Semua keputusan</option>
                        <option value="allowed">Diizinkan</option>
                        <option value="denied">Ditolak</option>
                      </select>
                    </label>
                    <button className="button button-primary" type="submit">
                      <Search size={15} />
                      Terapkan
                    </button>
                    <button
                      className="button button-ghost"
                      type="button"
                      onClick={() => {
                        const empty = { q: "", from: "", to: "", decision: "" };
                        setFilters(empty);
                        setQuery(empty);
                        setAccessPage(1);
                      }}
                    >
                      Reset
                    </button>
                  </form>
                  {accessApi.error && <ErrorState message={accessApi.error} />}
                  {accessApi.loading ? (
                    <Loading />
                  ) : accessApi.data ? (
                    <>
                      <AccessTable
                        events={accessApi.data.items}
                        filtered={Object.values(query).some(Boolean)}
                      />
                      <Pagination
                        page={accessPage}
                        total={accessApi.data.total}
                        size={10}
                        onChange={setAccessPage}
                      />
                    </>
                  ) : (
                    <Empty />
                  )}
                </Panel>
              )}
              {tab === "environment" && (
                <>
                  <EnvironmentChart
                    result={environmentApi.data}
                    loading={environmentApi.loading}
                    hours={hours}
                    onHours={setRange}
                    error={environmentApi.error}
                  />
                  <div className="environment-note">
                    <Thermometer size={18} />
                    <span>
                      Ambang aktif: ON{" "}
                      <strong>≥ {summary.config.fan_on_c}°C</strong> · OFF{" "}
                      <strong>≤ {summary.config.fan_off_c}°C</strong>. Di antara
                      keduanya, kipas mempertahankan kondisi sebelumnya.
                    </span>
                    <Badge tone="blue">
                      {summary.config.fan_mode === "automatic"
                        ? "Mode otomatis"
                        : "Mode manual"}
                    </Badge>
                  </div>
                  <Panel
                    title="Histori pembacaan sensor"
                    description="Pembacaan gagal tetap dicatat dan tidak diubah menjadi nilai nol."
                  >
                    {environmentApi.loading ? (
                      <Loading />
                    ) : !environmentApi.data?.readings.length ? (
                      <Empty />
                    ) : (
                      <>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Waktu pengukuran</th>
                                <th>Suhu</th>
                                <th>Kelembapan</th>
                                <th>Status</th>
                                <th>Diterima server</th>
                                <th>ID pembacaan</th>
                              </tr>
                            </thead>
                            <tbody>
                              {environmentApi.data.readings.map((row) => (
                                <tr key={row.reading_id}>
                                  <td>{time(row.measured_at, true)}</td>
                                  <td className="measurement">
                                    {value(row.temperature_c)}
                                    {row.temperature_c !== null && " °C"}
                                  </td>
                                  <td className="measurement">
                                    {value(row.humidity_percent)}
                                    {row.humidity_percent !== null && " %"}
                                  </td>
                                  <td>
                                    <Badge
                                      tone={
                                        row.status === "ok" ? "green" : "red"
                                      }
                                    >
                                      {row.status === "ok"
                                        ? "Valid"
                                        : "Sensor gagal"}
                                    </Badge>
                                    {row.error_code && (
                                      <small>{row.error_code}</small>
                                    )}
                                  </td>
                                  <td>{time(row.received_at, true)}</td>
                                  <td className="code">{row.reading_id}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <Pagination
                          page={environmentPage}
                          total={environmentApi.data.total}
                          size={10}
                          onChange={setEnvironmentPage}
                        />
                      </>
                    )}
                  </Panel>
                  <Panel
                    title="Perubahan status kipas"
                    description="Berdasarkan laporan pengendali pada rentang waktu terpilih."
                  >
                    {environmentApi.data?.fan_changes.length ? (
                      <div className="fan-history">
                        {environmentApi.data.fan_changes.map((change) => (
                          <div key={change.id}>
                            <span
                              className={`fan-history-icon ${change.fan_on ? "on" : ""}`}
                            >
                              <Fan size={17} />
                            </span>
                            <div>
                              <strong>
                                Kipas {change.fan_on ? "menyala" : "mati"}
                              </strong>
                              <small>
                                Mode{" "}
                                {change.fan_mode === "automatic"
                                  ? "otomatis"
                                  : "manual"}
                              </small>
                            </div>
                            <span>{time(change.reported_at, true)}</span>
                            <Badge tone={change.fan_on ? "green" : "gray"}>
                              {change.fan_on ? "ON" : "OFF"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty text="Belum ada perubahan kipas" />
                    )}
                  </Panel>
                </>
              )}
              {tab === "control" && (
                <>
                  {attempt && (
                    <div className="unresolved">
                      <CircleAlert size={22} />
                      <div>
                        <strong>Ada pengiriman yang belum terkonfirmasi</strong>
                        <p>
                          ID: <code>{attempt.command_id}</code>. Periksa riwayat
                          sebelum mengambil tindakan. Tidak ada pengulangan
                          otomatis.
                        </p>
                        <div className="button-row">
                          <button
                            className="button button-white"
                            disabled={busy || !online}
                            onClick={() => void sendCommand(attempt)}
                          >
                            Kirim ulang dengan ID yang sama
                          </button>
                          <button
                            className="button button-ghost"
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Hapus catatan pengiriman lokal setelah memeriksa hasil perintah? Perintah di server tetap berlaku sampai kedaluwarsa.",
                                )
                              )
                                keepAttempt(null);
                            }}
                          >
                            Tutup catatan lokal
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="control-grid">
                    <Panel
                      title="Buka kunci sementara"
                      description="Perintah sekali jalan dengan durasi yang terukur."
                      action={<LockKeyhole size={20} />}
                    >
                      <div className="control-visual">
                        <div className="control-icon">
                          <LockKeyhole size={32} strokeWidth={1.5} />
                        </div>
                        <strong>
                          {device?.lock_state === "locked"
                            ? "Kunci terkunci"
                            : device?.lock_state === "unlocked"
                              ? "Kunci terbuka"
                              : "Status kunci belum diketahui"}
                        </strong>
                        <p>
                          Durasi buka{" "}
                          <b>{summary.config.unlock_duration_seconds} detik</b>
                        </p>
                        <button
                          className="button button-primary"
                          disabled={controlsDisabled}
                          onClick={() => setConfirmUnlock(true)}
                        >
                          <UnlockKeyhole size={17} />
                          Buka selama {
                            summary.config.unlock_duration_seconds
                          }{" "}
                          detik
                        </button>
                        <small>
                          Perangkat bertanggung jawab mengunci kembali.
                        </small>
                      </div>
                    </Panel>
                    <Panel
                      title="Kontrol kipas"
                      description="Pilih otomatisasi sensor atau kendali manual."
                      action={<Fan size={21} />}
                    >
                      <div className="fan-control">
                        <div className="mode-switch" aria-label="Mode kipas">
                          <button
                            className={
                              summary.config.fan_mode === "automatic"
                                ? "selected"
                                : ""
                            }
                            disabled={
                              busy ||
                              !!summaryApi.error ||
                              summary.config.fan_mode === "automatic"
                            }
                            onClick={() =>
                              void saveConfig({
                                ...summary.config,
                                fan_mode: "automatic",
                              }).catch(() => {})
                            }
                          >
                            Otomatis
                          </button>
                          <button
                            className={
                              summary.config.fan_mode === "manual"
                                ? "selected"
                                : ""
                            }
                            disabled={
                              busy ||
                              !!summaryApi.error ||
                              summary.config.fan_mode === "manual"
                            }
                            onClick={() =>
                              void saveConfig({
                                ...summary.config,
                                fan_mode: "manual",
                              }).catch(() => {})
                            }
                          >
                            Manual
                          </button>
                        </div>
                        <div className="fan-display">
                          <Fan size={36} strokeWidth={1.4} />
                          <div>
                            <strong>
                              {device
                                ? device.fan_on
                                  ? "Kipas menyala"
                                  : "Kipas mati"
                                : "Menunggu laporan"}
                            </strong>
                            <p>
                              {summary.config.fan_mode === "automatic"
                                ? `ON ≥ ${summary.config.fan_on_c}°C · OFF ≤ ${summary.config.fan_off_c}°C`
                                : "Mengikuti perintah manual terakhir"}
                            </p>
                          </div>
                        </div>
                        <div className="button-row">
                          <button
                            className="button button-primary"
                            disabled={
                              controlsDisabled ||
                              summary.config.fan_mode !== "manual" ||
                              !summary.config_synced
                            }
                            onClick={() =>
                              void sendCommand({
                                command_id: newCommandId(),
                                type: "set_fan",
                                fan_on: true,
                              })
                            }
                          >
                            Nyalakan kipas
                          </button>
                          <button
                            className="button button-white"
                            disabled={
                              controlsDisabled ||
                              summary.config.fan_mode !== "manual" ||
                              !summary.config_synced
                            }
                            onClick={() =>
                              void sendCommand({
                                command_id: newCommandId(),
                                type: "set_fan",
                                fan_on: false,
                              })
                            }
                          >
                            Matikan kipas
                          </button>
                        </div>
                        <p className="control-hint">
                          {!summary.config_synced
                            ? "Menunggu perangkat mengonfirmasi konfigurasi terbaru."
                            : summary.config.fan_mode === "automatic"
                              ? "Pilih mode manual untuk mengaktifkan tombol ON/OFF."
                              : "Perintah dapat dikirim saat perangkat online."}
                        </p>
                      </div>
                    </Panel>
                  </div>
                  <Panel
                    title="Riwayat perintah"
                    description="Tersimpan di server belum berarti berhasil dijalankan perangkat."
                  >
                    {commandsApi.error && (
                      <ErrorState message={commandsApi.error} />
                    )}
                    {commandsApi.loading ? (
                      <Loading />
                    ) : !commandsApi.data?.items.length ? (
                      <Empty text="Belum ada perintah manual" />
                    ) : (
                      <>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Perintah</th>
                                <th>Dibuat</th>
                                <th>Berlaku sampai</th>
                                <th>Status eksekusi</th>
                                <th>ID perintah</th>
                              </tr>
                            </thead>
                            <tbody>
                              {commandsApi.data.items.map((command) => (
                                <tr key={command.command_id}>
                                  <td>
                                    <strong>
                                      {command.type === "unlock"
                                        ? `Buka kunci ${command.duration_seconds} detik`
                                        : `Kipas ${command.fan_on ? "ON" : "OFF"}`}
                                    </strong>
                                    <small>{command.source}</small>
                                  </td>
                                  <td>{time(command.created_at, true)}</td>
                                  <td>{time(command.expires_at, true)}</td>
                                  <td>
                                    <Badge
                                      tone={commandLabels[command.status].tone}
                                      dot
                                    >
                                      {commandLabels[command.status].label}
                                    </Badge>
                                    {command.message && (
                                      <small>{command.message}</small>
                                    )}
                                  </td>
                                  <td className="code">{command.command_id}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <Pagination
                          page={commandPage}
                          total={commandsApi.data.total}
                          size={8}
                          onChange={setCommandPage}
                        />
                      </>
                    )}
                  </Panel>
                  <Panel
                    title="Audit log"
                    description="Sumber aksi: dashboard internal. Tidak ada identitas operator yang diasumsikan."
                  >
                    {auditApi.error && <ErrorState message={auditApi.error} />}
                    {auditApi.loading ? (
                      <Loading />
                    ) : !auditApi.data?.items.length ? (
                      <Empty text="Belum ada aksi yang tercatat" />
                    ) : (
                      <>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Waktu</th>
                                <th>Aksi</th>
                                <th>Perangkat & sumber</th>
                                <th>Detail</th>
                              </tr>
                            </thead>
                            <tbody>
                              {auditApi.data.items.map((entry) => (
                                <tr key={entry.id}>
                                  <td>{time(entry.created_at, true)}</td>
                                  <td>
                                    <strong>{entry.action}</strong>
                                    {entry.command_id && (
                                      <small className="code">
                                        {entry.command_id}
                                      </small>
                                    )}
                                  </td>
                                  <td>
                                    {entry.device_id}
                                    <small>{entry.source}</small>
                                  </td>
                                  <td className="audit-detail">
                                    {entry.detail}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <Pagination
                          page={auditPage}
                          total={auditApi.data.total}
                          size={8}
                          onChange={setAuditPage}
                        />
                      </>
                    )}
                  </Panel>
                </>
              )}
              {tab === "settings" && (
                <div className="settings-grid">
                  <div>
                    {configApi.error && (
                      <ErrorState message={configApi.error} />
                    )}
                    {config && (
                      <ConfigForm
                        config={config}
                        synced={
                          configApi.data?.config_synced ?? summary.config_synced
                        }
                        applied={
                          configApi.data?.applied_config_version ??
                          summary.applied_config_version
                        }
                        onSave={saveConfig}
                        busy={busy}
                      />
                    )}
                  </div>
                  <div>
                    <Panel
                      title="Informasi perangkat"
                      action={<Server size={20} />}
                    >
                      <dl className="settings-info">
                        <div>
                          <dt>ID perangkat</dt>
                          <dd className="code">{summary.device_id}</dd>
                        </div>
                        <div>
                          <dt>Mode aplikasi</dt>
                          <dd>
                            {summary.mode === "simulation"
                              ? "Simulasi"
                              : "Perangkat nyata"}
                          </dd>
                        </div>
                        <div>
                          <dt>Versi server</dt>
                          <dd>v{config?.version}</dd>
                        </div>
                        <div>
                          <dt>Versi diterapkan</dt>
                          <dd>
                            v
                            {configApi.data?.applied_config_version ??
                              summary.applied_config_version}
                          </dd>
                        </div>
                        <div>
                          <dt>Pengukuran sensor</dt>
                          <dd>
                            Setiap {summary.intervals.sensor_seconds} detik
                          </dd>
                        </div>
                        <div>
                          <dt>Heartbeat</dt>
                          <dd>
                            Setiap {summary.intervals.heartbeat_seconds} detik
                          </dd>
                        </div>
                        <div>
                          <dt>Polling perintah</dt>
                          <dd>
                            Setiap {summary.intervals.command_poll_seconds}{" "}
                            detik
                          </dd>
                        </div>
                        <div>
                          <dt>Batas offline</dt>
                          <dd>
                            {summary.intervals.offline_after_seconds} detik
                          </dd>
                        </div>
                        <div>
                          <dt>Batas data usang</dt>
                          <dd>
                            {summary.intervals.sensor_stale_seconds} detik
                          </dd>
                        </div>
                        <div>
                          <dt>Zona waktu tampilan</dt>
                          <dd>Asia/Jakarta (WIB)</dd>
                        </div>
                      </dl>
                    </Panel>
                    <div className="internal-note">
                      <ShieldCheck size={23} />
                      <h3>Akses jaringan internal</h3>
                      <p>
                        Dashboard tidak menggunakan login. Setiap orang yang
                        dapat mengaksesnya memiliki kemampuan kontrol yang sama.
                      </p>
                      <p>
                        Batasi akses melalui firewall atau reverse proxy pada
                        jaringan internal.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              Smart Server Room <span className="footer-dot">·</span> Kelompok
              KELAPA
            </span>
            <span>
              BINUS Online University <span className="footer-dot">·</span>{" "}
              Proyek IoT
            </span>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        onCancel={() => setConfirmUnlock(false)}
        onClose={() => setConfirmUnlock(false)}
      >
        <div className="dialog-icon">
          <UnlockKeyhole size={27} />
        </div>
        <h2>Buka kunci ruang server?</h2>
        <p>
          Perintah akan meminta perangkat membuka kunci selama{" "}
          <strong>{summary?.config.unlock_duration_seconds} detik</strong>, lalu
          mengunci kembali. Hasilnya tetap menunggu konfirmasi perangkat.
        </p>
        <div className="dialog-info">
          <Clock3 size={16} />
          Perintah memiliki batas waktu berlaku dan tidak diulang otomatis.
        </div>
        <div>
          {summary?.recent_commands.some(
            (command) =>
              command.type === "unlock" && command.status === "unknown",
          ) && (
            <div className="inline-error">
              Hasil perintah buka kunci sebelumnya belum diketahui. Periksa
              kondisi perangkat sebelum membuat perintah baru; tindakan ini
              bukan pengulangan otomatis.
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button
            className="button button-white"
            autoFocus
            onClick={() => setConfirmUnlock(false)}
          >
            Batalkan
          </button>
          <button
            className="button button-primary"
            disabled={controlsDisabled}
            onClick={() =>
              void sendCommand({ command_id: newCommandId(), type: "unlock" })
            }
          >
            <UnlockKeyhole size={16} />
            Ya, buka kunci
          </button>
        </div>
      </dialog>
    </div>
  );
}

function Metric({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="metric-card">
      <div className="metric-title">
        <span>{title}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      {children}
    </section>
  );
}
