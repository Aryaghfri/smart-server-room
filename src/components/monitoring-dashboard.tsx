"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  Fan,
  Flame,
  LayoutDashboard,
  Lightbulb,
  Mail,
  Menu,
  Moon,
  Radio,
  RefreshCw,
  Server,
  Settings2,
  Sparkles,
  Sun,
  Sunrise,
  Thermometer,
  UsersRound,
  Waves,
  Wifi,
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
  ForecastPeriod,
  MonitorSummary,
  TemperatureForecast,
  Recipient,
  SensorRecord,
  SmokeIncident,
} from "@/lib/monitoring-types";

type Tab = "overview" | "history" | "alerts" | "integration" | "settings";
type PageData<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};
const navigation = [
  { id: "overview", name: "Ringkasan", icon: LayoutDashboard },
  { id: "history", name: "Histori sensor", icon: Activity },
  { id: "alerts", name: "Peringatan asap", icon: Bell },
  { id: "integration", name: "Integrasi perangkat", icon: Radio },
  { id: "settings", name: "Pengaturan", icon: Settings2 },
] as const;
const names = { dht: "DHT · Suhu", pir: "PIR · Orang", mq: "MQ · Asap" };
const sourceNames = {
  api: "API perangkat",
  mysql: "MySQL langsung",
  sql_import: "Arsip SQL Togar",
  simulator: "Simulator",
};
const emailStatus: Record<string, string> = {
  pending: "Menunggu pengiriman",
  sending: "Sedang dikirim",
  sent: "Diterima server SMTP",
  failed: "Gagal dikirim",
  unknown: "Hasil belum diketahui",
  skipped: "Tidak dikirim",
};

/** Format semua waktu pengukuran dalam WIB, termasuk data DATETIME hasil impor MySQL. */
function time(value: string | null | undefined, full = false) {
  return value
    ? new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        day: full ? "2-digit" : undefined,
        month: full ? "short" : undefined,
        year: full ? "numeric" : undefined,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "Belum ada data";
}
function number(value: number | null | undefined) {
  return value === null || value === undefined
    ? "—"
    : value.toLocaleString("id-ID", { maximumFractionDigits: 1 });
}
function Chip({
  children,
  tone = "gray",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`v2-chip ${tone}`}>
      <i />
      {children}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="v2-empty">
      <Database size={26} />
      <p>{children}</p>
    </div>
  );
}
function Freshness({
  record,
  stale,
}: {
  record: SensorRecord | null | undefined;
  stale: boolean;
}) {
  return (
    <span className={`v2-fresh ${stale ? "old" : ""}`}>
      {record
        ? `${stale ? "Data lama · " : ""}${time(record.measured_at, true)} WIB`
        : "Menunggu data perangkat"}
    </span>
  );
}
const forecastPeriods: {
  id: ForecastPeriod;
  name: string;
  icon: typeof Sun;
  tone: string;
}[] = [
  { id: "pagi", name: "Pagi", icon: Sunrise, tone: "pale-orange" },
  { id: "siang", name: "Siang", icon: Sun, tone: "pale-red" },
  { id: "malam", name: "Malam", icon: Moon, tone: "pale-blue" },
];
/** Prediksi suhu besok dari model ML Mas Togar (tabel MySQL prediksi_suhu). */
function ForecastPanel({
  forecast,
}: {
  forecast: TemperatureForecast | null;
}) {
  const day = forecast
    ? new Intl.DateTimeFormat("id-ID", {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(`${forecast.tanggal}T00:00:00Z`))
    : null;
  return (
    <section className="v2-panel v2-forecast" aria-label="Prediksi suhu besok">
      <div className="v2-panel-heading">
        <div>
          <h2>Prediksi suhu besok</h2>
          <p>{day ?? "Hasil model machine learning"}</p>
        </div>
        <Chip tone={forecast ? "teal" : "gray"}>
          {forecast ? "Model ML" : "Menunggu prediksi"}
        </Chip>
      </div>
      <div className="v2-forecast-grid">
        {forecastPeriods.map(({ id, name, icon: Icon, tone }) => (
          <div className="v2-forecast-item" key={id}>
            <span className={`v2-icon ${tone}`}>
              <Icon size={19} />
            </span>
            <div>
              <span className="v2-forecast-label">{name}</span>
              <div className="v2-forecast-value">
                {number(forecast?.suhu[id])}
                <small>°C</small>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="v2-forecast-note">
        <Sparkles size={13} />
        {forecast
          ? `Diperbarui ${time(forecast.updated_at, true)} WIB`
          : "Belum ada hasil prediksi untuk besok. Model ML akan mengisi tabel prediksi_suhu di MySQL."}
      </p>
    </section>
  );
}
function SensorValue({ record }: { record: SensorRecord }) {
  if (record.kind === "dht")
    return (
      <>
        {record.error_code
          ? "Sensor gagal"
          : `${number(record.suhu)} °C / ${number(record.kelembapan)} %`}
      </>
    );
  if (record.status === null) return <>Sensor belum tersedia</>;
  return (
    <>
      {record.kind === "pir"
        ? record.status
          ? "Orang terdeteksi"
          : "Tidak ada deteksi"
        : record.status
          ? "Asap terdeteksi"
          : "Tidak ada deteksi asap"}
    </>
  );
}

export default function MonitoringDashboard() {
  const [tab, setTab] = useState<Tab>("overview"),
    [menu, setMenu] = useState(false);
  const [data, setData] = useState<MonitorSummary | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [history, setHistory] = useState<PageData<SensorRecord> | null>(null),
    [alerts, setAlerts] = useState<PageData<SmokeIncident> | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]),
    [page, setPage] = useState(1),
    [kind, setKind] = useState("all"),
    [source, setSource] = useState("all"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [busy, setBusy] = useState(false),
    [email, setEmail] = useState(""),
    [recipientName, setRecipientName] = useState("");
  const [on, setOn] = useState("31"),
    [off, setOff] = useState("30"),
    [formVersion, setFormVersion] = useState(1),
    [dirty, setDirty] = useState(false);
  const csrf = useRef("");

  /** Browser hanya memanggil API dashboard. API key dan password SMTP tidak pernah masuk browser. */
  const get = useCallback(
    async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
      const response = await fetch("/api/v2/" + path, {
        cache: "no-store",
        signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message || "Tidak dapat memuat data.");
      return body.data;
    },
    [],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await get<MonitorSummary>("dashboard/summary", signal);
        setData(next);
        if (tab === "history")
          setHistory(
            await get(
              `dashboard/history?${new URLSearchParams({ page: String(page), kind, source, ...(from ? { from } : {}), ...(to ? { to } : {}) })}`,
              signal,
            ),
          );
        if (tab === "alerts")
          setAlerts(await get(`dashboard/alerts?page=${page}`, signal));
        if (tab === "settings")
          setRecipients(await get("dashboard/recipients", signal));
        setError("");
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError"))
          setError((e as Error).message);
      }
    },
    [get, tab, page, kind, source, from, to],
  );
  const pollSeconds = data?.dashboard_poll_seconds ?? 300;
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(
      () => void refresh(controller.signal),
      pollSeconds * 1000,
    );
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh, pollSeconds]);
  useEffect(() => {
    if (data && !dirty) {
      setOn(String(data.config.fan_on_c));
      setOff(String(data.config.fan_off_c));
      setFormVersion(data.config.version);
    }
  }, [data, dirty]);
  useEffect(() => {
    const update = () => {
      const hash = location.hash.slice(1);
      setTab(
        navigation.some((n) => n.id === hash) ? (hash as Tab) : "overview",
      );
      setPage(1);
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  /** Setiap perubahan form memakai cookie sesi dan token CSRF; server tetap memvalidasi Origin. */
  async function mutate(path: string, method: string, body?: unknown) {
    if (!csrf.current)
      csrf.current = (
        await get<{ csrf_token: string }>("dashboard/session")
      ).csrf_token;
    const response = await fetch("/api/v2/dashboard/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.current,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 403) csrf.current = "";
      throw new Error(result.error?.message || "Perubahan gagal.");
    }
    return result.data;
  }
  function navigate(next: Tab) {
    setTab(next);
    setPage(1);
    setMenu(false);
    setNotice("");
    location.hash = next;
  }
  async function saveRecipient(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      await mutate("recipients", "POST", { email, name: recipientName });
      setEmail("");
      setRecipientName("");
      setNotice(
        "Penerima berhasil didaftarkan. Notifikasi berlaku untuk insiden baru.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disableRecipient(id: number) {
    setBusy(true);
    try {
      await mutate(`recipients/${id}`, "DELETE");
      setNotice("Penerima dinonaktifkan.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveConfig(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await mutate("settings", "PUT", {
        expected_version: formVersion,
        fan_on_c: Number(on),
        fan_off_c: Number(off),
      });
      setDirty(false);
      setNotice(
        "Konfigurasi tersimpan. Tunggu perangkat menerapkan dan mengirim ACK.",
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pir = data?.latest.pir,
    mq = data?.latest.mq,
    dht = data?.latest.dht;
  const archiveOnly =
    !!data &&
    data.source_counts.length > 0 &&
    data.source_counts.every((x) => x.source === "sql_import");
  const title =
    tab === "overview"
      ? "Ringkasan ruang server"
      : navigation.find((n) => n.id === tab)!.name;
  const subtitles = {
    overview: "Pantau suhu, deteksi orang, dan asap dari satu dashboard.",
    history: "Pembacaan DHT, PIR, dan MQ tersimpan sesuai waktu pengukuran.",
    alerts: "Insiden asap dan hasil pengiriman ke email yang terdaftar.",
    integration:
      "Dashboard membaca MySQL yang diisi melalui API milik Mas Togar.",
    settings: "Atur penerima email dan konfigurasi perangkat.",
  };
  const configInvalid =
    !on ||
    !off ||
    !Number.isFinite(Number(on)) ||
    !Number.isFinite(Number(off)) ||
    Number(off) >= Number(on) ||
    Number(on) > 80 ||
    Number(off) < -40;

  return (
    <div className="v2-shell">
      {menu && (
        <button
          className="v2-overlay"
          aria-label="Tutup navigasi"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`v2-sidebar ${menu ? "open" : ""}`}>
        <a
          className="v2-brand"
          href="#overview"
          onClick={() => navigate("overview")}
        >
          <span className="v2-brand-icon">
            <Server size={23} />
          </span>
          <span>
            smart<span className="v2-brand-room">server room</span>
          </span>
        </a>
        <div className="v2-project-label">WORKSPACE KELOMPOK KELAPA</div>
        <div className="v2-room">
          <span className="v2-room-avatar">SR</span>
          <div>
            <strong>Ruang Server</strong>
            <small>BINUS Online University</small>
          </div>
          <ChevronRight size={15} />
        </div>
        <div className="v2-nav-label">MONITORING</div>
        <nav aria-label="Navigasi utama">
          {navigation.map((n) => (
            <a
              key={n.id}
              className={tab === n.id ? "active" : ""}
              href={`#${n.id}`}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={19} />
              <span>{n.name}</span>
              {n.id === "alerts" &&
                data?.incidents.some((i) => !i.resolved_at) && (
                  <span className="v2-nav-dot" />
                )}
            </a>
          ))}
        </nav>
        <div className="v2-sidebar-bottom">
          <div className="v2-sidebar-note">
            <CircleHelp size={19} />
            <strong>Panduan tim IoT</strong>
            <p>Kontrak data dan contoh integrasi untuk Mas Togar.</p>
            <a href="#integration" onClick={() => navigate("integration")}>
              Buka integrasi <ArrowUpRight size={14} />
            </a>
          </div>
          <div className="v2-team">
            <span>K</span>
            <div>
              <strong>Kelompok KELAPA</strong>
              <small>Proyek Internet of Things</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="v2-main">
        <header className="v2-topbar">
          <div className="v2-breadcrumb">
            <button
              className="v2-mobile-menu"
              aria-label="Buka navigasi"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>Smart Server Room</strong>
          </div>
          <div className="v2-topbar-right">
            <span className="v2-internal">
              <i />
              Jaringan internal
            </span>
            <span className="v2-avatar">K</span>
          </div>
        </header>
        <main className="v2-content">
          <div className="v2-page-heading">
            <div>
              <div className="v2-eyebrow">
                SMART SERVER ROOM <span>/</span>{" "}
                {tab === "overview"
                  ? "OVERVIEW"
                  : navigation.find((n) => n.id === tab)!.name.toUpperCase()}
              </div>
              <h1>{title}</h1>
              <p>{subtitles[tab]}</p>
            </div>
            <button
              className="v2-button secondary"
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
              Perbarui
            </button>
          </div>
          {error && (
            <div className="v2-message error" role="alert">
              <Flame size={18} />
              <span>{error}</span>
              <button aria-label="Tutup pesan" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="v2-message success" role="status">
              <Check size={18} />
              {notice}
            </div>
          )}
          {!data ? (
            <Empty>Memuat pembacaan dan status perangkat…</Empty>
          ) : (
            <>
              <div className="v2-status-line">
                <div>
                  <Chip tone={data.mode === "real" ? "teal" : "blue"}>
                    {data.mode === "real" ? "Mode perangkat" : "Mode simulasi"}
                  </Chip>
                  <span className="v2-dot-separator">·</span>
                  <span>
                    {archiveOnly
                      ? "Arsip SQL Mas Togar"
                      : data.data_source === "mysql"
                        ? "Sumber MySQL iot_binus"
                        : "Sumber API perangkat"}
                  </span>
                </div>
                <span className={data.online ? "v2-online" : "v2-offline"}>
                  {data.online ? <Wifi size={14} /> : <WifiOff size={14} />}{" "}
                  {data.online ? "Perangkat online" : "Belum ada kontak aktif"}
                </span>
              </div>
              {archiveOnly && (
                <div className="v2-archive">
                  <Database size={18} />
                  <span>
                    <strong>Histori asli berhasil dimuat.</strong>{" "}
                    {data.counts.dht} DHT, {data.counts.pir} PIR, dan{" "}
                    {data.counts.mq} MQ dari SQL. Hubungkan MySQL untuk
                    pembaruan data perangkat.
                  </span>
                </div>
              )}
              {tab === "overview" && (
                <>
                  <section className="v2-metrics" aria-label="Ringkasan sensor">
                    <article className="v2-metric">
                      <div className="v2-metric-label">
                        Suhu ruangan{" "}
                        <span className="v2-icon pale-orange">
                          <Thermometer size={19} />
                        </span>
                      </div>
                      <div className="v2-metric-value">
                        {number(dht?.suhu)}
                        <small>°C</small>
                      </div>
                      <p>
                        {dht?.error_code
                          ? "Sensor DHT gagal membaca"
                          : data.stale.dht
                            ? "Pembacaan terakhir tersimpan"
                            : "Pembacaan sensor DHT"}
                      </p>
                      <Freshness record={dht} stale={data.stale.dht} />
                    </article>
                    <article className="v2-metric">
                      <div className="v2-metric-label">
                        Kelembapan{" "}
                        <span className="v2-icon pale-blue">
                          <Waves size={19} />
                        </span>
                      </div>
                      <div className="v2-metric-value">
                        {number(dht?.kelembapan)}
                        <small>%</small>
                      </div>
                      <p>Relative humidity · DHT</p>
                      <Freshness record={dht} stale={data.stale.dht} />
                    </article>
                    <article className="v2-metric">
                      <div className="v2-metric-label">
                        Deteksi orang{" "}
                        <span className="v2-icon pale-teal">
                          <UsersRound size={19} />
                        </span>
                      </div>
                      <div className="v2-metric-state">
                        {!pir || pir.status === null
                          ? "Belum tersedia"
                          : pir.status
                            ? "Terdeteksi"
                            : "Tidak terdeteksi"}
                      </div>
                      <p>Sensor PIR · indikator keberadaan</p>
                      <Freshness record={pir} stale={data.stale.pir} />
                    </article>
                    <article
                      className={`v2-metric ${mq?.status === 1 && !data.stale.mq ? "alarm" : ""}`}
                    >
                      <div className="v2-metric-label">
                        Deteksi asap{" "}
                        <span className="v2-icon pale-red">
                          <Flame size={19} />
                        </span>
                      </div>
                      <div className="v2-metric-state">
                        {!mq || mq.status === null
                          ? "Belum tersedia"
                          : mq.status
                            ? "Asap terdeteksi"
                            : "Tidak terdeteksi"}
                      </div>
                      <p>
                        {data.stale.mq
                          ? "Kondisi saat ini belum terkonfirmasi"
                          : mq?.status
                            ? "Periksa kondisi ruangan"
                            : "Sensor MQ · pemantauan asap"}
                      </p>
                      <Freshness record={mq} stale={data.stale.mq} />
                    </article>
                  </section>
                  <ForecastPanel forecast={data.forecast ?? null} />
                  <div className="v2-overview-grid">
                    <section className="v2-panel v2-chart-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>Suhu & kelembapan</h2>
                          <p>120 pembacaan terakhir · waktu pengukuran WIB</p>
                        </div>
                        <div className="v2-chart-legend">
                          <span>
                            <i />
                            Suhu
                          </span>
                          <span>
                            <i />
                            Kelembapan
                          </span>
                        </div>
                      </div>
                      {data.chart.length ? (
                        <div className="v2-chart">
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                              data={data.chart}
                              margin={{
                                top: 14,
                                right: 12,
                                left: -15,
                                bottom: 0,
                              }}
                            >
                              <defs>
                                <linearGradient
                                  id="temp-fill"
                                  x1="0"
                                  y1="0"
                                  x2="0"
                                  y2="1"
                                >
                                  <stop
                                    offset="0%"
                                    stopColor="#319d85"
                                    stopOpacity={0.2}
                                  />
                                  <stop
                                    offset="100%"
                                    stopColor="#319d85"
                                    stopOpacity={0}
                                  />
                                </linearGradient>
                              </defs>
                              <CartesianGrid
                                strokeDasharray="3 5"
                                vertical={false}
                                stroke="#e9edef"
                              />
                              <XAxis
                                dataKey="measured_at"
                                tickFormatter={(v) => time(v).slice(0, 5)}
                                minTickGap={45}
                                tick={{ fontSize: 10, fill: "#8b969e" }}
                                axisLine={false}
                                tickLine={false}
                              />
                              <YAxis
                                yAxisId="temperature"
                                domain={["auto", "auto"]}
                                tick={{ fontSize: 10, fill: "#8b969e" }}
                                axisLine={false}
                                tickLine={false}
                                unit="°"
                              />
                              <YAxis
                                yAxisId="humidity"
                                orientation="right"
                                domain={[0, 100]}
                                tick={{ fontSize: 10, fill: "#8b969e" }}
                                axisLine={false}
                                tickLine={false}
                                unit="%"
                              />
                              <Tooltip
                                labelFormatter={(v) =>
                                  time(String(v), true) + " WIB"
                                }
                                formatter={(value, name) => [
                                  number(Number(value)) +
                                    (name === "Suhu" ? " °C" : " %"),
                                  name,
                                ]}
                                contentStyle={{
                                  border: "1px solid #e6ebee",
                                  borderRadius: 10,
                                  fontSize: 12,
                                }}
                              />
                              <Area
                                yAxisId="temperature"
                                type="monotone"
                                dataKey="suhu"
                                name="Suhu"
                                stroke="#24917a"
                                strokeWidth={2.5}
                                fill="url(#temp-fill)"
                                connectNulls={false}
                                isAnimationActive={false}
                              />
                              <Line
                                yAxisId="humidity"
                                type="monotone"
                                dataKey="kelembapan"
                                name="Kelembapan"
                                stroke="#7996d0"
                                strokeWidth={2}
                                dot={false}
                                connectNulls={false}
                                isAnimationActive={false}
                              />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <Empty>
                          Grafik muncul setelah pembacaan DHT pertama.
                        </Empty>
                      )}
                      <div className="v2-chart-footer">
                        <span>
                          <span className="v2-small-dot" />
                          Histori berdasarkan sensor
                        </span>
                        <button onClick={() => navigate("history")}>
                          Lihat seluruh histori <ArrowUpRight size={14} />
                        </button>
                      </div>
                    </section>
                    <section className="v2-panel v2-actuator-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>Perangkat & aktuator</h2>
                          <p>Kondisi berdasarkan laporan sensor</p>
                        </div>
                        <Radio size={18} />
                      </div>
                      <div className="v2-actuator">
                        <span className="v2-actuator-icon">
                          <Fan size={24} />
                        </span>
                        <div>
                          <h3>Kipas ruangan</h3>
                          <p>
                            {dht?.status === null || !dht
                              ? "Belum ada status kipas"
                              : dht.status
                                ? "Kipas menyala"
                                : "Kipas tidak menyala"}
                          </p>
                        </div>
                        <Chip tone={dht?.status === 1 ? "teal" : "gray"}>
                          {dht?.status === null || !dht
                            ? "—"
                            : dht.status
                              ? "ON"
                              : "OFF"}
                        </Chip>
                      </div>
                      <div className="v2-actuator">
                        <span className="v2-actuator-icon">
                          <Lightbulb size={24} />
                        </span>
                        <div>
                          <h3>Lampu / LED</h3>
                          <p>
                            {pir?.lamp_on === null || !pir
                              ? "Status fisik belum dilaporkan"
                              : pir.lamp_on
                                ? "LED dilaporkan menyala"
                                : "LED dilaporkan mati"}
                          </p>
                        </div>
                        <Chip tone={pir?.lamp_on === 1 ? "amber" : "gray"}>
                          {pir?.lamp_on === null || !pir
                            ? "—"
                            : pir.lamp_on
                              ? "ON"
                              : "OFF"}
                        </Chip>
                      </div>
                      <div className="v2-target">
                        <span>Target LED dari PIR</span>
                        <strong>
                          {pir?.status === null || !pir
                            ? "Belum tersedia"
                            : pir.status
                              ? "Menyala"
                              : "Mati"}
                        </strong>
                      </div>
                      <p className="v2-footnote">
                        PIR melaporkan deteksi orang. Tabel SQL belum menyimpan
                        status fisik LED.
                      </p>
                      <button
                        className="v2-text-link"
                        onClick={() => navigate("integration")}
                      >
                        Detail integrasi <ArrowUpRight size={14} />
                      </button>
                    </section>
                    <section className="v2-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>Aktivitas sensor terbaru</h2>
                          <p>Pembacaan yang terakhir tersimpan</p>
                        </div>
                        <button
                          className="v2-text-link"
                          onClick={() => navigate("history")}
                        >
                          Lihat semua <ArrowUpRight size={14} />
                        </button>
                      </div>
                      <div className="v2-activity-list">
                        {data.recent.length ? (
                          data.recent.slice(0, 5).map((r) => (
                            <div className="v2-activity-row" key={r.record_key}>
                              <span className={`v2-activity-icon ${r.kind}`}>
                                {r.kind === "dht" ? (
                                  <Thermometer size={16} />
                                ) : r.kind === "pir" ? (
                                  <UsersRound size={16} />
                                ) : (
                                  <Flame size={16} />
                                )}
                              </span>
                              <div>
                                <strong>{names[r.kind]}</strong>
                                <p>
                                  <SensorValue record={r} />
                                </p>
                              </div>
                              <span>{time(r.measured_at)}</span>
                            </div>
                          ))
                        ) : (
                          <Empty>Belum ada aktivitas sensor.</Empty>
                        )}
                      </div>
                    </section>
                    <section className="v2-panel v2-notification-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>Notifikasi email</h2>
                          <p>Peringatan saat sensor MQ mendeteksi asap</p>
                        </div>
                        <Mail size={19} />
                      </div>
                      <div className="v2-mail-count">
                        {data.email.recipients}
                        <span>penerima aktif</span>
                      </div>
                      <div className="v2-mail-row">
                        <span>Koneksi SMTP</span>
                        <Chip tone={data.email.configured ? "teal" : "amber"}>
                          {data.email.configured
                            ? "Dikonfigurasi"
                            : "Belum diatur"}
                        </Chip>
                      </div>
                      <div className="v2-mail-row">
                        <span>Worker notifikasi</span>
                        <span>
                          {data.email.worker_last_seen &&
                          Date.now() - Date.parse(data.email.worker_last_seen) <
                            30000
                            ? "Aktif"
                            : "Belum aktif"}
                        </span>
                      </div>
                      <p className="v2-footnote">
                        Satu periode asap membuat satu insiden. Pengiriman
                        menunggu SMTP dan worker aktif.
                      </p>
                      <button
                        className="v2-button secondary"
                        onClick={() => navigate("settings")}
                      >
                        Kelola penerima <ArrowUpRight size={14} />
                      </button>
                    </section>
                  </div>
                </>
              )}
              {tab === "history" && (
                <section className="v2-panel">
                  <div className="v2-panel-heading">
                    <div>
                      <h2>Histori pembacaan</h2>
                      <p>
                        Total {history?.total.toLocaleString("id-ID") ?? "—"}{" "}
                        record sesuai filter
                      </p>
                    </div>
                    <Chip>Waktu WIB</Chip>
                  </div>
                  <div className="v2-filters">
                    <label>
                      Sensor
                      <select
                        value={kind}
                        onChange={(e) => {
                          setKind(e.target.value);
                          setPage(1);
                        }}
                      >
                        <option value="all">Semua sensor</option>
                        <option value="dht">DHT · Suhu</option>
                        <option value="pir">PIR · Orang</option>
                        <option value="mq">MQ · Asap</option>
                      </select>
                    </label>
                    <label>
                      Sumber
                      <select
                        value={source}
                        onChange={(e) => {
                          setSource(e.target.value);
                          setPage(1);
                        }}
                      >
                        <option value="all">Semua sumber</option>
                        {Object.entries(sourceNames).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Dari tanggal
                      <input
                        aria-label="Dari tanggal"
                        type="date"
                        value={from}
                        onChange={(e) => {
                          setFrom(e.target.value);
                          setPage(1);
                        }}
                      />
                    </label>
                    <label>
                      Sampai tanggal
                      <input
                        aria-label="Sampai tanggal"
                        type="date"
                        value={to}
                        onChange={(e) => {
                          setTo(e.target.value);
                          setPage(1);
                        }}
                      />
                    </label>
                    <button
                      className="v2-button secondary"
                      onClick={() => {
                        setKind("all");
                        setSource("all");
                        setFrom("");
                        setTo("");
                        setPage(1);
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  <div className="v2-table-wrap">
                    <table className="v2-table">
                      <thead>
                        <tr>
                          <th>Waktu pengukuran</th>
                          <th>Sensor</th>
                          <th>Pembacaan</th>
                          <th>Status aktuator</th>
                          <th>Sumber / ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history?.items.map((r) => (
                          <tr key={r.record_key}>
                            <td>
                              {time(r.measured_at, true)}
                              <small>WIB</small>
                            </td>
                            <td>
                              <Chip>{names[r.kind]}</Chip>
                            </td>
                            <td>
                              <SensorValue record={r} />
                            </td>
                            <td>
                              {r.kind === "dht"
                                ? r.status === null
                                  ? "Kipas belum diketahui"
                                  : r.status
                                    ? "Kipas ON"
                                    : "Kipas OFF"
                                : r.kind === "pir"
                                  ? r.lamp_on === null
                                    ? "LED belum dilaporkan"
                                    : r.lamp_on
                                      ? "LED ON"
                                      : "LED OFF"
                                  : "—"}
                            </td>
                            <td>
                              {sourceNames[r.source]}
                              <small>#{r.source_id}</small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {history && !history.items.length && (
                    <Empty>Tidak ada record yang cocok dengan filter.</Empty>
                  )}
                  <Pagination
                    page={page}
                    total={history?.total ?? 0}
                    size={15}
                    onChange={setPage}
                  />
                </section>
              )}
              {tab === "alerts" && (
                <>
                  <div className="v2-callout">
                    <Flame size={22} />
                    <div>
                      <h2>Deteksi asap dan pengiriman email</h2>
                      <p>
                        Insiden berasal dari pembacaan MQ yang masih baru.
                        Import histori SQL tidak mengirim email.
                      </p>
                    </div>
                  </div>
                  {!data.email.configured && (
                    <div className="v2-message info">
                      <Mail size={18} />
                      SMTP belum dikonfigurasi. Status pengiriman tetap terlihat
                      tanpa menyatakan email sudah terkirim.
                    </div>
                  )}
                  <section className="v2-panel">
                    <div className="v2-panel-heading">
                      <div>
                        <h2>Histori insiden</h2>
                        <p>{alerts?.total ?? 0} insiden terdata</p>
                      </div>
                    </div>
                    {alerts?.items.length ? (
                      alerts.items.map((i) => (
                        <article className="v2-incident" key={i.id}>
                          <div className="v2-incident-heading">
                            <Flame size={22} />
                            <div>
                              <h3>Sensor mendeteksi asap</h3>
                              <p>
                                {time(i.detected_at, true)} WIB ·{" "}
                                {sourceNames[i.source]}
                              </p>
                            </div>
                            <Chip tone={i.resolved_at ? "teal" : "red"}>
                              {i.resolved_at
                                ? "Deteksi berakhir"
                                : "Insiden terbuka"}
                            </Chip>
                          </div>
                          <p className="v2-footnote">
                            ID: {i.id}
                            {i.resolved_at
                              ? ` · Berakhir ${time(i.resolved_at, true)} WIB`
                              : ""}
                          </p>
                          {i.emails.length ? (
                            <div className="v2-email-results">
                              {i.emails.map((m, n) => (
                                <div key={n}>
                                  <div>
                                    <Mail size={14} />
                                    <strong>{m.recipient_email}</strong>
                                    <Chip
                                      tone={
                                        m.status === "sent"
                                          ? "teal"
                                          : m.status === "failed" ||
                                              m.status === "unknown"
                                            ? "red"
                                            : "amber"
                                      }
                                    >
                                      {emailStatus[m.status]}
                                    </Chip>
                                  </div>
                                  {m.detail && <p>{m.detail}</p>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="v2-footnote">
                              Tidak ada penerima aktif saat insiden terbentuk.
                              Daftarkan email untuk insiden berikutnya.
                            </p>
                          )}
                        </article>
                      ))
                    ) : (
                      <Empty>
                        Belum ada insiden asap baru. Data MQ normal tetap
                        tersedia pada Histori sensor.
                      </Empty>
                    )}
                    <Pagination
                      page={page}
                      total={alerts?.total ?? 0}
                      size={15}
                      onChange={setPage}
                    />
                  </section>
                </>
              )}
              {tab === "integration" && (
                <>
                  <div className="v2-integration-grid">
                    <section className="v2-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>MySQL iot_binus</h2>
                          <p>
                            Untuk perangkat yang sudah menulis ke database Mas
                            Togar
                          </p>
                        </div>
                        <Database size={22} />
                      </div>
                      <table className="v2-table compact">
                        <thead>
                          <tr>
                            <th>Tabel</th>
                            <th>Arti kolom status</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>dht</td>
                            <td>0 = kipas mati, 1 = menyala</td>
                          </tr>
                          <tr>
                            <td>pir</td>
                            <td>0 = tidak ada deteksi, 1 = orang terdeteksi</td>
                          </tr>
                          <tr>
                            <td>mq</td>
                            <td>0 = tidak ada deteksi, 1 = asap terdeteksi</td>
                          </tr>
                        </tbody>
                      </table>
                      <p className="v2-footnote">
                        Worker hanya membaca MySQL lalu menyimpan histori lokal.
                        Kolom <code>update _date</code> pada DHT tetap
                        dibiarkan. Sinkronisasi mengandalkan id yang terus
                        bertambah.
                      </p>
                      <div className="v2-code-label">Environment server</div>
                      <pre>{`DATA_SOURCE=mysql\nMYSQL_HOST=127.0.0.1\nMYSQL_DATABASE=iot_binus\nMYSQL_USER=akun_baca\nMYSQL_TIME_ZONE=+07:00\n# Password hanya di .env.local`}</pre>
                      <div className="v2-key-value">
                        <span>Sinkronisasi terakhir</span>
                        <strong>
                          {time(data.integration.last_sync_at, true)}
                        </strong>
                      </div>
                      <div className="v2-key-value">
                        <span>Baris sumber dikarantina</span>
                        <strong>{data.integration.rejected_rows}</strong>
                      </div>
                      {data.integration.last_error && (
                        <p className="v2-inline-error">
                          {data.integration.last_error}
                        </p>
                      )}
                    </section>
                    <section className="v2-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>API alternatif untuk pengujian</h2>
                          <p>
                            Opsional. Jalur utama tetap API Mas Togar dan MySQL.
                          </p>
                        </div>
                        <Radio size={22} />
                      </div>
                      <div className="v2-code-label">
                        POST /api/v2/device/telemetry
                      </div>
                      <pre>{`{\n  "sample_id": "UUID-baru",\n  "measured_at": "waktu-UTC-ISO",\n  "dht": {\n    "suhu": 31.2, "kelembapan": 67,\n    "status": 1, "error_code": null\n  },\n  "pir": { "status": 1, "lamp_on": true },\n  "mq": { "status": 0 }\n}`}</pre>
                      <p className="v2-footnote">
                        Header: <code>X-Device-ID</code> dan{" "}
                        <code>X-API-Key</code>. Retry memakai ID, waktu, dan isi
                        yang sama. Field <code>lamp_on</code> opsional; isi
                        hanya jika perangkat mengetahui status LED.
                      </p>
                      <div className="v2-key-value">
                        <span>Jalur aktif</span>
                        <Chip tone="teal">
                          {data.data_source === "api"
                            ? "API perangkat"
                            : "MySQL langsung"}
                        </Chip>
                      </div>
                    </section>
                  </div>
                  <section className="v2-panel v2-handoff">
                    <h2>Urutan integrasi tim IoT</h2>
                    <ol>
                      <li>
                        Gunakan MySQL yang menerima data dari API Mas Togar. API
                        alternatif tersedia untuk pengujian terpisah.
                      </li>
                      <li>
                        Perangkat menyalakan LED berdasarkan PIR dan menjalankan
                        kipas berdasarkan suhu secara lokal.
                      </li>
                      <li>
                        Worker memantau pembacaan MQ, membentuk insiden, lalu
                        mengirim email ke penerima aktif.
                      </li>
                      <li>
                        Periksa histori, waktu WIB, status data lama, serta
                        hasil pengiriman sebelum demo.
                      </li>
                    </ol>
                    <p className="v2-footnote">
                      PIR tidak menghitung jumlah orang. Sensor MQ pada struktur
                      SQL menyediakan status biner, tanpa nilai konsentrasi PPM.
                    </p>
                  </section>
                </>
              )}
              {tab === "settings" && (
                <div className="v2-settings-grid">
                  <section className="v2-panel">
                    <div className="v2-panel-heading">
                      <div>
                        <h2>Penerima peringatan asap</h2>
                        <p>
                          Email aktif menerima notifikasi untuk insiden baru
                        </p>
                      </div>
                      <Mail size={21} />
                    </div>
                    <form className="v2-form" onSubmit={saveRecipient}>
                      <label>
                        Nama penerima
                        <input
                          value={recipientName}
                          onChange={(e) => setRecipientName(e.target.value)}
                          placeholder="Contoh: Tim operasional"
                          maxLength={100}
                        />
                      </label>
                      <label>
                        Alamat email
                        <input
                          type="email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="nama@contoh.com"
                          maxLength={254}
                        />
                      </label>
                      <button className="v2-button primary" disabled={busy}>
                        {busy ? "Menyimpan…" : "Daftarkan email"}
                      </button>
                    </form>
                    <div className="v2-recipient-list">
                      {recipients.filter((r) => r.enabled).length ? (
                        recipients
                          .filter((r) => r.enabled)
                          .map((r) => (
                            <div key={r.id}>
                              <span className="v2-recipient-avatar">
                                <Mail size={17} />
                              </span>
                              <div>
                                <strong>{r.name || "Penerima email"}</strong>
                                <p>{r.email}</p>
                              </div>
                              <button
                                disabled={busy}
                                onClick={() => void disableRecipient(r.id)}
                              >
                                Nonaktifkan
                              </button>
                            </div>
                          ))
                      ) : (
                        <p className="v2-footnote">
                          Belum ada penerima email aktif.
                        </p>
                      )}
                    </div>
                    <p className="v2-footnote">
                      Alamat tersimpan di server. SMTP diatur melalui
                      environment; password tidak ditampilkan pada dashboard.
                    </p>
                  </section>
                  <div>
                    <section className="v2-panel">
                      <div className="v2-panel-heading">
                        <div>
                          <h2>Ambang kipas otomatis</h2>
                          <p>
                            {data.data_source === "mysql"
                              ? "Pengaturan firmware Mas Togar"
                              : "Konfigurasi berversi untuk jalur API"}
                          </p>
                        </div>
                        <Fan size={21} />
                      </div>
                      {data.data_source === "mysql" ? (
                        <div className="v2-form">
                          <p>
                            Pada jalur MySQL, dashboard membaca status kipas
                            dari <code>dht.status</code>. Sesuaikan ambang pada
                            firmware; perubahan dashboard tidak dikirim kembali
                            ke MySQL.
                          </p>
                        </div>
                      ) : (
                        <form className="v2-form" onSubmit={saveConfig}>
                          <div className="v2-form-row">
                            <label>
                              Menyala pada suhu (°C)
                              <input
                                type="number"
                                step="0.1"
                                min="-39"
                                max="80"
                                required
                                value={on}
                                onChange={(e) => {
                                  setOn(e.target.value);
                                  setDirty(true);
                                }}
                              />
                            </label>
                            <label>
                              Mati pada suhu (°C)
                              <input
                                type="number"
                                step="0.1"
                                min="-40"
                                max="79"
                                required
                                value={off}
                                onChange={(e) => {
                                  setOff(e.target.value);
                                  setDirty(true);
                                }}
                              />
                            </label>
                          </div>
                          {configInvalid && (
                            <p className="v2-inline-error">
                              Ambang OFF harus lebih kecil dari ON dan berada
                              dalam rentang sensor.
                            </p>
                          )}
                          <div className="v2-config-sync">
                            <span>Versi {data.config.version}</span>
                            <Chip
                              tone={
                                data.applied_config_version ===
                                data.config.version
                                  ? "teal"
                                  : "amber"
                              }
                            >
                              {data.applied_config_version ===
                              data.config.version
                                ? "Terakhir di-ACK perangkat"
                                : "Menunggu ACK"}
                            </Chip>
                          </div>
                          <button
                            className="v2-button primary"
                            disabled={busy || configInvalid || !dirty}
                          >
                            Simpan konfigurasi
                          </button>
                          <p className="v2-footnote">
                            Perangkat mengambil, menerapkan, lalu mengirim ACK.
                            Daerah di antara ambang mempertahankan status kipas
                            sebelumnya. Saat boot perangkat tetap mengambil
                            konfigurasi terkini.
                          </p>
                        </form>
                      )}
                    </section>
                    <section className="v2-panel v2-smtp-status">
                      <h2>Status layanan email</h2>
                      <div className="v2-key-value">
                        <span>SMTP</span>
                        <strong>
                          {data.email.configured
                            ? "Dikonfigurasi"
                            : "Belum dikonfigurasi"}
                        </strong>
                      </div>
                      <div className="v2-key-value">
                        <span>Worker terakhir aktif</span>
                        <strong>
                          {time(data.email.worker_last_seen, true)}
                        </strong>
                      </div>
                      <p className="v2-footnote">
                        Jalankan <code>npm run worker</code> agar notifikasi
                        tetap diproses saat browser ditutup.
                      </p>
                    </section>
                  </div>
                </div>
              )}
              <footer className="v2-footer">
                <span>
                  Kelompok KELAPA <i /> BINUS Online University
                </span>
                <span>
                  Pembaruan otomatis setiap{" "}
                  {pollSeconds >= 60
                    ? `${pollSeconds / 60} menit`
                    : `${pollSeconds} detik`}{" "}
                  · {time(data.server_time)} WIB
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
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
  onChange: (n: number) => void;
}) {
  const max = Math.max(1, Math.ceil(total / size));
  return (
    <div className="v2-pagination">
      <span>
        {total
          ? `${(page - 1) * size + 1}–${Math.min(page * size, total)} dari ${total} record`
          : "0 record"}
      </span>
      <div>
        <button
          className="v2-page-button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="Halaman sebelumnya"
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          {page} / {max}
        </span>
        <button
          className="v2-page-button"
          disabled={page >= max}
          onClick={() => onChange(page + 1)}
          aria-label="Halaman berikutnya"
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
