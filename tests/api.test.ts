import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Command, Configuration, Summary } from '../src/lib/contracts';

const dataDir = mkdtempSync(join(tmpdir(), 'kelapa-api-test-'));
const origin = 'http://127.0.0.1:3000';
const deviceId = 'kelapa-test-device';
const deviceKey = 'test-device-key-only-32-characters-long';
Object.assign(process.env, {
  NODE_ENV: 'test', APP_MODE: 'simulation', DATA_DIR: dataDir,
  DEVICE_ID: deviceId, DEVICE_API_KEY: deviceKey,
  CSRF_SECRET: 'test-csrf-secret-only-32-characters-long', ALLOWED_ORIGINS: origin,
  OFFLINE_AFTER_SECONDS: '30', SENSOR_STALE_SECONDS: '30',
  UNLOCK_TTL_SECONDS: '10', RESULT_GRACE_SECONDS: '30',
});

let handleApi: typeof import('../src/lib/service').handleApi;
let getDb: typeof import('../src/lib/db').getDb;
let setTestNow: typeof import('../src/lib/time').setTestNow;
let clock = Date.parse('2026-09-29T05:00:00.000Z');
let csrf = '';
let cookie = '';

function timestamp(offset = 0) { return new Date(clock + offset).toISOString(); }
function advance(ms: number) { clock += ms; setTestNow(timestamp()); }
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await handleApi(new Request(`${origin}/api/v1/${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'));
  const payload = await response.json();
  return { response, payload, data: payload.data };
}
function device(path: string, method = 'GET', body?: unknown) {
  return request(`device/${path}`, method, body, { 'X-Device-ID': deviceId, 'X-API-Key': deviceKey });
}
function dashboard(path: string, method = 'GET', body?: unknown) {
  return request(`dashboard/${path}`, method, body, {
    Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf,
  });
}
async function summary(): Promise<Summary> {
  const r = await dashboard('summary'); assert.equal(r.response.status, 200); return r.data;
}
function access(overrides: Record<string, unknown> = {}) {
  return { event_id: randomUUID(), occurred_at: timestamp(), person_id: 'student-001',
    person_name: 'Arya Test', recognition: 'known', decision: 'allowed', ...overrides };
}
function reading(overrides: Record<string, unknown> = {}) {
  return { reading_id: randomUUID(), measured_at: timestamp(), status: 'ok',
    temperature_c: 31.5, humidity_percent: 51.2, ...overrides };
}
function heartbeat(overrides: Record<string, unknown> = {}) {
  return { heartbeat_id: randomUUID(), reported_at: timestamp(), lock_state: 'locked',
    fan_on: false, fan_mode: 'automatic', applied_config_version: 0, ...overrides };
}
async function configure(overrides: Partial<Configuration> = {}) {
  const existing = (await dashboard('config')).data.config as Configuration;
  return dashboard('config', 'PUT', {
    expected_version: existing.version, fan_on_c: existing.fan_on_c,
    fan_off_c: existing.fan_off_c, fan_mode: existing.fan_mode,
    unlock_duration_seconds: existing.unlock_duration_seconds, ...overrides,
  });
}
async function createCommand(overrides: Record<string, unknown> = {}): Promise<Command> {
  const r = await dashboard('commands', 'POST', { command_id: randomUUID(), type: 'unlock', ...overrides });
  assert.equal(r.response.status, 201, JSON.stringify(r.payload)); return r.data;
}
async function commandById(id: string): Promise<Command> {
  const r = await dashboard('commands?page_size=100');
  const command = r.data.items.find((c: Command) => c.command_id === id);
  assert.ok(command, `Expected command ${id}`); return command;
}
function assertError(result: Awaited<ReturnType<typeof request>>, status: number) {
  assert.equal(result.response.status, status, JSON.stringify(result.payload));
  assert.equal(typeof result.payload.error.code, 'string');
  assert.equal(typeof result.payload.error.message, 'string');
  assert.equal(typeof result.payload.request_id, 'string');
}

before(async () => {
  ({ handleApi } = await import('../src/lib/service'));
  ({ getDb } = await import('../src/lib/db'));
  ({ setTestNow } = await import('../src/lib/time'));
  setTestNow(timestamp());
  const session = await request('dashboard/session');
  assert.equal(session.response.status, 200);
  csrf = session.data.csrf_token;
  cookie = session.response.headers.get('set-cookie')!.split(';')[0];
});
beforeEach(() => advance(60_000));
after(() => {
  setTestNow(null);
  try { getDb().close(); } catch { /* Persistence test may already have closed it. */ }
  rmSync(dataDir, { recursive: true, force: true });
});

test('fresh database reports no sensor values rather than invented zeros', async () => {
  const s = await summary();
  assert.equal(s.mode, 'simulation'); assert.equal(s.online, false);
  assert.equal(s.latest_reading, null); assert.equal(s.latest_valid_reading, null);
  assert.equal(s.sensor_stale, true); assert.equal(s.sensor_failed, false);
  assert.equal(s.today.total, 0);
});

test('device authentication, Origin and CSRF reject unauthorized mutations', async () => {
  assertError(await request('device/access-events', 'POST', access()), 401);
  assertError(await request('device/access-events', 'POST', access(), {
    'X-Device-ID': deviceId, 'X-API-Key': 'wrong-key',
  }), 401);
  const body = { command_id: randomUUID(), type: 'unlock' };
  assertError(await request('dashboard/commands', 'POST', body), 403);
  assertError(await request('dashboard/commands', 'POST', body, {
    Origin: 'https://untrusted.example', Cookie: cookie, 'X-CSRF-Token': csrf,
  }), 403);
  assertError(await request('dashboard/commands', 'POST', body, { Origin: origin, Cookie: cookie }), 403);
  assertError(await request('dashboard/commands', 'POST', body, {
    Origin: origin, Cookie: cookie, 'X-CSRF-Token': 'invalid',
  }), 403);
  assertError(await request('dashboard/commands', 'POST', body, { Origin: origin, 'X-CSRF-Token': csrf }), 403);
  const accepted = await dashboard('commands', 'POST', body);
  assert.equal(accepted.response.status, 201);
});

test('access retries deduplicate, conflicting retries fail, recognition remains distinct from permission', async () => {
  const payload = access({ decision: 'denied', reason: 'Tidak berizin' });
  const beforeTotal = (await dashboard('access-events')).data.total;
  const first = await device('access-events', 'POST', payload);
  assert.ok([200, 201].includes(first.response.status)); assert.equal(first.data.duplicate, false);
  const second = await device('access-events', 'POST', payload);
  assert.equal(second.response.status, 200); assert.equal(second.data.duplicate, true);
  assertError(await device('access-events', 'POST', { ...payload, decision: 'allowed' }), 409);
  assert.equal((await dashboard('access-events')).data.total, beforeTotal + 1);
  const found = (await dashboard('access-events?q=Arya&decision=denied&page=1&page_size=10')).data.items;
  assert.equal(found[0].event_id, payload.event_id);
  assert.equal(found[0].recognition, 'known'); assert.equal(found[0].decision, 'denied');
  const unknown = await device('access-events', 'POST', access({ person_id: null, person_name: null, recognition: 'unknown', decision: 'denied' }));
  assert.ok([200, 201].includes(unknown.response.status));
  assertError(await dashboard('access-events?page=0'), 422);
});

test('sensor, config, timestamps and body validation reject invalid input', async () => {
  assertError(await device('readings', 'POST', reading({ humidity_percent: 101 })), 422);
  assertError(await device('readings', 'POST', reading({ temperature_c: -41 })), 422);
  assertError(await device('readings', 'POST', reading({ status: 'ok', temperature_c: null })), 422);
  assertError(await device('readings', 'POST', reading({ status: 'error', temperature_c: 0, humidity_percent: 0 })), 422);
  assertError(await device('readings', 'POST', reading({ measured_at: timestamp(31_000) })), 422);
  assertError(await device('access-events', 'POST', access({ event_id: 'not-a-uuid' })), 422);
  assertError(await configure({ fan_off_c: 30, fan_on_c: 30 }), 422);
  assertError(await configure({ unlock_duration_seconds: 31 }), 422);
  const invalidJson = await handleApi(new Request(`${origin}/api/v1/device/readings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-ID': deviceId, 'X-API-Key': deviceKey }, body: '{invalid',
  }), ['device', 'readings']);
  assert.equal(invalidJson.status, 400);
});

test('late readings and heartbeat reports remain historical without replacing newer state', async () => {
  const latest = reading();
  await device('readings', 'POST', latest);
  const duplicate = await device('readings', 'POST', latest);
  assert.equal(duplicate.data.duplicate, true);
  assertError(await device('readings', 'POST', { ...latest, temperature_c: 29 }), 409);
  await device('readings', 'POST', reading({ measured_at: timestamp(-120_000), temperature_c: 18 }));
  const newestHeartbeat = heartbeat({ fan_on: true });
  await device('heartbeat', 'POST', newestHeartbeat);
  await device('heartbeat', 'POST', heartbeat({ reported_at: timestamp(-120_000), lock_state: 'unlocked', fan_on: false }));
  const s = await summary();
  assert.equal(s.latest_valid_reading?.reading_id, latest.reading_id);
  assert.equal(s.latest_valid_reading?.temperature_c, 31.5);
  assert.equal(s.device_status?.heartbeat_id, newestHeartbeat.heartbeat_id);
  assert.equal(s.device_status?.lock_state, 'locked'); assert.equal(s.device_status?.fan_on, true);
  const environment = (await dashboard('environment?hours=24&page_size=100')).data;
  assert.equal(environment.readings.filter((r: { reading_id: string }) => r.reading_id === latest.reading_id).length, 1);
  assert.ok(environment.readings.some((r: { temperature_c: number }) => r.temperature_c === 18));
});

test('offline, sensor error and stale measurement are independently observable', async () => {
  await device('readings', 'POST', reading());
  let s = await summary();
  assert.equal(s.online, true); assert.equal(s.sensor_failed, false); assert.equal(s.sensor_stale, false);
  advance(1_000);
  const failure = reading({ status: 'error', temperature_c: null, humidity_percent: null, error_code: 'DHT_TIMEOUT' });
  await device('readings', 'POST', failure);
  s = await summary();
  assert.equal(s.online, true); assert.equal(s.sensor_failed, true); assert.equal(s.sensor_stale, false);
  assert.equal(s.latest_reading?.temperature_c, null); assert.equal(s.latest_valid_reading?.temperature_c, 31.5);
  advance(31_000);
  // Polling is read-only and must not make the device appear online.
  await device('config'); await device('commands');
  s = await summary();
  assert.equal(s.online, false); assert.equal(s.sensor_failed, true); assert.equal(s.sensor_stale, true);
  await device('heartbeat', 'POST', heartbeat());
  s = await summary();
  assert.equal(s.online, true); assert.equal(s.sensor_stale, true); assert.equal(s.sensor_failed, true);
});

test('configuration version locking and explicit device acknowledgement govern sync', async () => {
  const original = (await dashboard('config')).data.config as Configuration;
  const updated = await configure({ fan_on_c: 32, fan_off_c: 29, unlock_duration_seconds: 4 });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.config.version, original.version + 1); assert.equal(updated.data.config_synced, false);
  assertError(await dashboard('config', 'PUT', {
    expected_version: original.version, fan_on_c: 30, fan_off_c: 28, fan_mode: 'automatic', unlock_duration_seconds: 5,
  }), 409);
  const current = (await device('config')).data;
  assert.equal(current.version, updated.data.config.version);
  await device('heartbeat', 'POST', heartbeat({ applied_config_version: current.version }));
  assert.equal((await dashboard('config')).data.config_synced, false);
  assertError(await device('config/ack', 'POST', { version: current.version + 10 }), 422);
  const ack = await device('config/ack', 'POST', { version: current.version });
  assert.equal(ack.response.status, 200);
  assert.equal((await dashboard('config')).data.config_synced, true);
  await configure({ fan_mode: 'automatic', fan_on_c: 30, fan_off_c: 28, unlock_duration_seconds: 5 });
});

test('fan commands require manual mode and configuration changes expire pending old commands', async () => {
  await configure({ fan_mode: 'automatic' });
  assertError(await dashboard('commands', 'POST', { command_id: randomUUID(), type: 'set_fan', fan_on: true }), 409);
  await configure({ fan_mode: 'manual' });
  const command = await createCommand({ type: 'set_fan', fan_on: true });
  assert.equal(command.fan_on, true); assert.equal(command.status, 'pending');
  const beforeConfigAck = await device(`commands/${command.command_id}/receipt`, 'POST', {});
  assertError(beforeConfigAck, 409);
  assert.equal(beforeConfigAck.payload.error.code, 'CONFIG_NOT_APPLIED');
  await configure({ fan_mode: 'automatic' });
  assert.equal((await commandById(command.command_id)).status, 'expired');
  const receipt = await device(`commands/${command.command_id}/receipt`, 'POST', {});
  assert.equal(receipt.response.status, 410);
});

test('command creation, receipt and result retries preserve a single actuator authorization', async () => {
  const id = randomUUID();
  const command = await createCommand({ command_id: id });
  assert.equal(command.status, 'pending'); assert.equal(command.duration_seconds, 5);
  const duplicate = await dashboard('commands', 'POST', { command_id: id, type: 'unlock' });
  assert.equal(duplicate.response.status, 200); assert.equal(duplicate.data.command_id, id);
  assertError(await dashboard('commands', 'POST', { command_id: id, type: 'set_fan', fan_on: true }), 409);
  const listed = (await device('commands')).data as Command[];
  assert.ok(listed.some(c => c.command_id === id));
  const first = await device(`commands/${id}/receipt`, 'POST', {});
  assert.equal(first.data.execute_allowed, true); assert.equal(first.data.command.status, 'received');
  const retry = await device(`commands/${id}/receipt`, 'POST', {});
  assert.equal(retry.data.execute_allowed, false); assert.equal(retry.data.command.status, 'received');
  assert.equal((await commandById(id)).status, 'received');
  const result = { status: 'succeeded', executed_at: timestamp(), message: 'Relay simulated' };
  assert.equal((await device(`commands/${id}/result`, 'POST', result)).data.status, 'succeeded');
  assert.equal((await device(`commands/${id}/result`, 'POST', result)).data.status, 'succeeded');
  assertError(await device(`commands/${id}/result`, 'POST', { ...result, status: 'failed' }), 409);
  const audit = (await dashboard('audit?page_size=100')).data.items;
  assert.ok(audit.some((entry: { command_id: string; source: string }) => entry.command_id === id && entry.source === 'dashboard internal'));
});

test('expired commands cannot be polled or executed and results require a prior receipt', async () => {
  const command = await createCommand();
  assertError(await device(`commands/${command.command_id}/result`, 'POST', {
    status: 'succeeded', executed_at: timestamp(),
  }), 409);
  advance(11_000);
  assert.equal((await commandById(command.command_id)).status, 'expired');
  const listed = (await device('commands')).data as Command[];
  assert.ok(!listed.some(c => c.command_id === command.command_id));
  const receipt = await device(`commands/${command.command_id}/receipt`, 'POST', {});
  assert.equal(receipt.response.status, 410);
});

test('missing execution confirmation remains unknown; late valid result resolves without reexecution', async () => {
  const command = await createCommand();
  const receipt = await device(`commands/${command.command_id}/receipt`, 'POST', {});
  assert.equal(receipt.data.execute_allowed, true);
  const executionStarted = timestamp();
  advance(46_000);
  assert.equal((await commandById(command.command_id)).status, 'unknown');
  const retriedReceipt = await device(`commands/${command.command_id}/receipt`, 'POST', {});
  assert.ok(retriedReceipt.response.status === 409 || retriedReceipt.data?.execute_allowed === false);
  assertError(await device(`commands/${command.command_id}/result`, 'POST', {
    status: 'succeeded', executed_at: timestamp(),
  }), 422);
  const result = await device(`commands/${command.command_id}/result`, 'POST', {
    status: 'succeeded', executed_at: executionStarted, message: 'Result arrived late',
  });
  assert.equal(result.response.status, 200); assert.equal(result.data.status, 'succeeded');
});

test('invalid receipts do not claim a command and concurrent receipts authorize execution only once', async () => {
  const command = await createCommand();
  assertError(await device(`commands/${command.command_id}/receipt`, 'POST', { execute: true }), 422);
  assertError(await device(`commands/${randomUUID()}/receipt`, 'POST', {}), 404);
  assert.equal((await commandById(command.command_id)).status, 'pending');
  const receipts = await Promise.all([
    device(`commands/${command.command_id}/receipt`, 'POST', {}),
    device(`commands/${command.command_id}/receipt`, 'POST', {}),
  ]);
  assert.deepEqual(receipts.map(r => r.data.execute_allowed).sort(), [false, true]);
  assertError(await device(`commands/${command.command_id}/result`, 'POST', {
    status: 'failed', executed_at: timestamp(-1000), message: 'Before command creation',
  }), 422);
  const failure = { status: 'failed', executed_at: timestamp(), message: 'Relay simulator rejected action' };
  assert.equal((await device(`commands/${command.command_id}/result`, 'POST', failure)).data.status, 'failed');
  assert.equal((await device(`commands/${command.command_id}/result`, 'POST', failure)).data.status, 'failed');
  const receiptAfterFailure = await device(`commands/${command.command_id}/receipt`, 'POST', {});
  assert.equal(receiptAfterFailure.data.execute_allowed, false);
  assert.equal(receiptAfterFailure.data.command.status, 'failed');
  const entries = getDb().prepare('SELECT action FROM audit_log WHERE command_id=?').all(command.command_id);
  assert.equal(entries.filter(entry => entry.action === 'command.received').length, 1);
  assert.equal(entries.filter(entry => entry.action === 'command.failed').length, 1);
});

test('all polling endpoints expose no internal hashes or secrets and perform no database writes', async () => {
  const command = await createCommand(); advance(11_000);
  const changesBefore = getDb().prepare('SELECT total_changes() AS value').get()!.value;
  const contactBefore = getDb().prepare('SELECT last_contact_at FROM device').get()!.last_contact_at;
  for (const endpoint of ['summary', 'access-events', 'environment', 'commands', 'config', 'audit', 'session']) {
    const result = await dashboard(endpoint);
    assert.equal(result.response.status, 200);
    const serialized = JSON.stringify(result.payload);
    assert.doesNotMatch(serialized, /"(?:payload_hash|result_hash|api_key|csrf_secret)"/);
    assert.equal(serialized.includes(deviceKey), false);
    assert.equal(serialized.includes(process.env.CSRF_SECRET!), false);
  }
  for (const endpoint of ['config', 'commands']) {
    const result = await device(endpoint);
    assert.equal(result.response.status, 200);
    assert.doesNotMatch(JSON.stringify(result.payload), /"(?:payload_hash|result_hash|api_key|csrf_secret)"/);
  }
  assert.equal((await request('health')).response.status, 200);
  assert.equal(getDb().prepare('SELECT total_changes() AS value').get()!.value, changesBefore);
  assert.equal(getDb().prepare('SELECT last_contact_at FROM device').get()!.last_contact_at, contactBefore);
  assert.equal((await commandById(command.command_id)).status, 'expired');
  assert.equal(getDb().prepare('SELECT status FROM commands WHERE command_id=?').get(command.command_id)!.status, 'pending');
});

test('large environmental history produces at most 180 ordered chart samples including latest', async () => {
  // Seed history directly to exercise chart sampling without exceeding the device API rate limit.
  const baseline = (await dashboard('environment?hours=24')).data.total;
  const latestId = randomUUID();
  const insert = getDb().prepare('INSERT INTO readings VALUES (?,?,?,?,?,?,?,?,?)');
  getDb().exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < 360; index++) {
      insert.run(index === 359 ? latestId : randomUUID(), deviceId, timestamp((index - 359) * 1000),
        timestamp(), 'ok', 29 + (index % 20) / 10, 50, null, 'chart-regression-fixture');
    }
    getDb().exec('COMMIT');
  } catch (error) { getDb().exec('ROLLBACK'); throw error; }
  const result = await dashboard('environment?hours=24&page=2&page_size=20');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.total, baseline + 360);
  assert.equal(result.data.readings.length, 20);
  assert.equal(result.data.chart.length <= 180, true);
  assert.equal(result.data.chart.at(-1).reading_id, latestId);
  const times = result.data.chart.map((sample: { measured_at: string }) => sample.measured_at);
  assert.deepEqual(times, [...times].sort());
});

test('today counters and date filters use inclusive Asia/Jakarta day boundaries', async () => {
  clock = Date.parse('2026-10-03T12:00:00.000Z'); setTestNow(timestamp());
  const yesterday = access({ occurred_at: '2026-10-02T16:59:59.000Z', decision: 'denied' });
  const midnight = access({ occurred_at: '2026-10-02T17:00:00.000Z', decision: 'allowed' });
  const today = access({ occurred_at: '2026-10-03T11:59:59.000Z', decision: 'denied' });
  for (const event of [yesterday, midnight, today]) {
    assert.ok([200, 201].includes((await device('access-events', 'POST', event)).response.status));
  }
  const s = await summary();
  assert.deepEqual(s.today, { total: 2, allowed: 1, denied: 1 });
  const events = (await dashboard('access-events?from=2026-10-03&to=2026-10-03')).data.items;
  assert.equal(events.length, 2);
  assert.ok(events.some((event: { event_id: string }) => event.event_id === midnight.event_id));
  assert.ok(!events.some((event: { event_id: string }) => event.event_id === yesterday.event_id));
  assertError(await dashboard('access-events?from=2026-10-04&to=2026-10-03'), 422);
});

test('data survives closing the database and a fresh process; real and simulation modes stay isolated', async () => {
  const id = randomUUID();
  await device('access-events', 'POST', access({ event_id: id, person_name: 'Persistence Marker' }));
  getDb().close();
  const childScript = `
    const { handleApi } = await import('./src/lib/service.ts');
    const { getDb } = await import('./src/lib/db.ts');
    const r = await handleApi(new Request('${origin}/api/v1/dashboard/access-events?q=Persistence%20Marker'), ['dashboard','access-events']);
    const payload = await r.json();
    console.log(JSON.stringify(payload));
    getDb().close();
  `;
  const run = (mode: 'simulation' | 'real') => JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childScript], {
      cwd: process.cwd(), env: { ...process.env, APP_MODE: mode }, encoding: 'utf8',
    }).trim());
  const reopened = run('simulation');
  assert.equal(reopened.data.total, 1); assert.equal(reopened.data.items[0].event_id, id);
  assert.equal(run('real').data.total, 0);
  assert.equal(run('simulation').data.total, 1);
  assert.ok(existsSync(join(dataDir, 'simulation.sqlite')));
  assert.ok(existsSync(join(dataDir, 'real.sqlite')));
});
