// In-memory ring buffer of recent ingest traffic — the debug console for
// Traccar setup. Deliberately not persisted: it's a diagnostic window, and
// resetting on deploy is fine.
const MAX = 500;
const buf = [];

export function pushIngestLog(entry) {
  buf.push(entry);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

export function readIngestLog() {
  return [...buf].reverse(); // newest first
}

export function clearIngestLog() {
  buf.length = 0;
}
