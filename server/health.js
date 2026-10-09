// Monitoring: how each upstream service is doing, and what the server is handling.
// Exposed at GET /api/health for uptime checks and dashboards.

const started = Date.now()
const services = new Map()
const requests = { total: 0, byStatus: {} }

/** Run `fn` (a call to `service`) and record whether it worked and how long it took. */
export async function record(service, fn) {
  const s = services.get(service) ?? { ok: 0, failed: 0, lastOk: null, lastError: null, totalMs: 0 }
  services.set(service, s)
  const t = Date.now()
  try {
    const result = await fn()
    s.ok += 1
    s.totalMs += Date.now() - t
    s.lastOk = new Date().toISOString()
    return result
  } catch (err) {
    s.failed += 1
    s.lastError = { at: new Date().toISOString(), message: err.message }
    throw err
  }
}

export function countRequest(status) {
  requests.total += 1
  const bucket = `${String(status)[0]}xx`
  requests.byStatus[bucket] = (requests.byStatus[bucket] || 0) + 1
}

/**
 * A summary for GET /api/health. `status` is "degraded" when an upstream service's most
 * recent call failed: the site still works (from cache) but fresh lookups may not.
 */
export function healthReport(extra = {}) {
  const upstream = Object.fromEntries(
    [...services].map(([name, s]) => [
      name,
      {
        ok: s.ok,
        failed: s.failed,
        averageMs: s.ok ? Math.round(s.totalMs / s.ok) : null,
        lastOk: s.lastOk,
        lastError: s.lastError,
      },
    ]),
  )
  const failing = Object.entries(upstream)
    .filter(([, s]) => s.lastError && (!s.lastOk || s.lastError.at > s.lastOk))
    .map(([name]) => name)
  return {
    status: failing.length ? 'degraded' : 'ok',
    failing,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    requests,
    upstream,
    ...extra,
  }
}
