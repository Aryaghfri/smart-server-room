# Kontrak implementasi bersama

Semua sukses dibungkus `{data: ...}`. Error `{error:{code,message,details?},request_id}`. Waktu ISO UTC Z. API `/api/v1`.

Device header `X-Device-ID`, `X-API-Key`. Endpoint:
- POST `/device/access-events`: event_id UUID, occurred_at, person_id/name nullable optional, recognition known|unknown, decision allowed|denied, reason nullable optional. Returns {event_id,duplicate}.
- POST `/device/readings`: reading_id UUID, measured_at, status ok|error, temperature_c, humidity_percent (required numeric for ok, null for error), error_code nullable. Returns {reading_id,duplicate}.
- POST `/device/heartbeat`: heartbeat_id UUID, reported_at, lock_state locked|unlocked|unknown, fan_on boolean, fan_mode automatic|manual, applied_config_version integer. Returns {heartbeat_id,duplicate}.
- GET `/device/config`: Configuration.
- POST `/device/config/ack`: {version:integer}. Returns {applied_config_version}.
- GET `/device/commands`: Command[] with pending/received nonexpired only (received provided for result retry, never reexecute).
- POST `/device/commands/{UUID}/receipt`: {}. Returns {command:Command,execute_allowed:boolean}. Only FIRST successful receipt before expires_at may execute; retry receipt never reexecutes. Device must persist command ID before actuator. If receipt response lost DO NOT execute on retry.
- POST `/device/commands/{UUID}/result`: {status:succeeded|failed,executed_at:ISO,message?:string}. execution start must be <= expires_at and >= created_at. Returns Command. Received required. Late result can resolve unknown. Never retry actuator.

Dashboard:
- GET `/dashboard/session`: {csrf_token}; sets signed HttpOnly SameSite=Strict cookie. Mutations must include `X-CSRF-Token`, same-origin cookie, Origin automatically browser-supplied. Allowed origins configured explicitly.
- GET `/dashboard/summary`: Summary (src/lib/contracts.ts).
- GET `/dashboard/access-events?q=&from=YYYY-MM-DD&to=YYYY-MM-DD&decision=allowed|denied&page=1&page_size=10`: PageResult<AccessEvent>. Dates inclusive WIB days.
- GET `/dashboard/environment?hours=24&page=1&page_size=20`: EnvironmentResult. hours 1..168. Chart bounded to 180 samples, table paginated; errors retained with null values.
- GET `/dashboard/commands?page=1&page_size=10`: PageResult<Command>.
- POST `/dashboard/commands`: {command_id:UUID,type:unlock|set_fan,fan_on?:boolean}; server takes duration from config. Returns Command, 201 create / 200 duplicate. set_fan only manual; UI confirm unlock, persist same command_id retry; no automatic retry.
- GET `/dashboard/config`: {config:Configuration,applied_config_version:number,config_synced:boolean,device_id:string}.
- PUT `/dashboard/config`: {expected_version:number,fan_on_c:number,fan_off_c:number,fan_mode:automatic|manual,unlock_duration_seconds:number}. Returns config sync object. Version optimistic locking, 409 stale.
- GET `/dashboard/audit?page=1&page_size=20`: PageResult<AuditEntry>.
- GET `/health`: {status:'ok',mode} (no secret).

Data timing: future >30s rejected; latest uses occurrence/measurement/reported_at, received_at server UTC. online uses last successful device POST (including dedup), polling GET is read-only. sensor_stale uses last successful measurement time. Heartbeat reports do not acknowledge config; explicit config/ack required. device_status from latest heartbeat; applied_config_version from explicit ack. Empty no-data sensor is stale=true. Commands status derived without writes on GET: pending past expiry => expired; received past result_deadline => unknown. received kept as received during grace even past expiry. set_fan pending superseded by config change => expired. Config defaults on30 off28 automatic unlock5. Result deadline expiry + duration + RESULT_GRACE_SECONDS (default30).

APP_MODE simulation|real chooses data/simulation.sqlite or data/real.sqlite; mode marker enforced. env .env.local via dotenv for scripts, Next loads automatically. Simulator rejects real mode. Runtime interval defaults in .env.example. Scripts setup and migrate supplied by root.
