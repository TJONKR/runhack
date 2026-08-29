// The origin baked into Traccar configs. A phone keeps whatever ingest URL
// it was set up with for the whole race, so it must be a host that is
// guaranteed to keep resolving to this service — NOT whatever domain the
// runner happened to browse on (a marketing domain can move mid-event and
// silently orphan every phone configured through it).
//
// Set INGEST_ORIGIN to the service's own stable URL (e.g. the Railway
// domain). Without it, falls back to the request's origin — the previous
// behaviour.
export function ingestOrigin(req) {
  const env = (process.env.INGEST_ORIGIN || '').trim().replace(/\/+$/, '');
  if (env) return /^https?:\/\//.test(env) ? env : `https://${env}`;
  return `${req.protocol}://${req.get('host')}`;
}
