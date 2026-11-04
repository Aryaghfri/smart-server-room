let testTime: string | null = null;
export function setTestNow(value: string | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test clock disabled");
  testTime = value;
}
export function now() {
  return testTime ? new Date(testTime) : new Date();
}
export function isoNow() {
  return now().toISOString();
}
export function todayWibBounds() {
  const day = new Date(now().getTime() + 7 * 3600000)
    .toISOString()
    .slice(0, 10);
  const start = new Date(`${day}T00:00:00+07:00`);
  return [
    start.toISOString(),
    new Date(start.getTime() + 86400000).toISOString(),
  ];
}
