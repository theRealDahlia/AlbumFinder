// State that must be shared when several copies of the server run: cached results,
// per-visitor request counts, and the pacing that keeps us within MusicBrainz's and
// Nominatim's one-request-per-second limits. In memory by default; set REDIS_URL to
// share it through Redis.

import { createClient } from 'redis'
import { sleep } from './util.js'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MEMORY_MAX_KEYS = 5000

// ---------- backends ----------

export function memoryBackend() {
  const data = new Map() // key -> { value, expires }
  const live = (key) => {
    const e = data.get(key)
    if (e && e.expires <= Date.now()) data.delete(key)
    return data.get(key)
  }
  const put = (key, value, ttlMs) => {
    data.delete(key) // re-insert so iteration order is oldest first
    data.set(key, { value, expires: Date.now() + ttlMs })
    if (data.size > MEMORY_MAX_KEYS) data.delete(data.keys().next().value)
  }
  return {
    kind: 'memory',
    async get(key) {
      return live(key)?.value
    },
    async set(key, value, ttlMs) {
      put(key, value, ttlMs)
    },
    async acquire(key, ttlMs) {
      if (live(key)) return false
      put(key, 1, ttlMs)
      return true
    },
    async size() {
      return data.size
    },
  }
}

/** `client` is a connected node-redis client (or anything with the same methods, in tests). */
export function redisBackend(client) {
  return {
    kind: 'redis',
    async get(key) {
      const raw = await client.get(key)
      return raw == null ? undefined : JSON.parse(raw)
    },
    async set(key, value, ttlMs) {
      await client.set(key, JSON.stringify(value), { PX: ttlMs })
    },
    async acquire(key, ttlMs) {
      return (await client.set(key, '1', { PX: ttlMs, NX: true })) === 'OK'
    },
    async size() {
      return client.dbSize()
    },
  }
}

let backendPromise = null

/** The shared backend: Redis if REDIS_URL is set and reachable, otherwise memory. */
export function backend() {
  backendPromise ??= (async () => {
    if (!process.env.REDIS_URL) return memoryBackend()
    try {
      const client = createClient({ url: process.env.REDIS_URL })
      client.on('error', (err) => console.warn('[redis]', err.message))
      await client.connect()
      return redisBackend(client)
    } catch (err) {
      console.warn(`[redis] could not connect (${err.message}); using memory instead`)
      return memoryBackend()
    }
  })()
  return backendPromise
}

/** For tests: use a specific backend, or `null` to go back to the default. */
export function setBackend(b) {
  backendPromise = b ? Promise.resolve(b) : null
  inflight.clear()
}

// ---------- caching ----------

const inflight = new Map()

/**
 * The cached result of `fn`, or `fn()` run once and cached. Concurrent identical calls
 * share one run; failures aren't cached, so they can be retried.
 */
export async function cached(key, fn, ttlMs = CACHE_TTL_MS) {
  const store = await backend()
  const hit = await store.get(`cache:${key}`)
  if (hit !== undefined) return hit
  if (inflight.has(key)) return inflight.get(key)
  const run = (async () => {
    const value = await fn()
    await store.set(`cache:${key}`, value, ttlMs)
    return value
  })()
  inflight.set(key, run)
  const clear = () => inflight.delete(key)
  run.then(clear, clear)
  return run
}

// ---------- rate limits ----------

/**
 * Count a request against `key`: at most `max` in any `windowMs`. Returns 0 if allowed,
 * or the seconds until there's room (when the oldest counted request turns `windowMs` old).
 *
 * Keeps the times of the visitor's recent allowed requests, so the limit holds over any
 * stretch of time. (Per-minute counters let 30 requests through just before a minute ends
 * and 30 more just after; a weighted estimate of those still let 55 through.) Only allowed
 * requests are kept, so being refused doesn't push the wait further out. With Redis, two
 * server copies answering the same visitor at the same instant could each let one extra in.
 */
export async function overLimit(key, max, windowMs, now = Date.now()) {
  const store = await backend()
  const recent = ((await store.get(`limit:${key}`)) || []).filter((t) => t > now - windowMs)
  if (recent.length >= max) return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000))
  recent.push(now)
  await store.set(`limit:${key}`, recent, windowMs)
  return 0
}

/**
 * Wait for a turn to call an upstream service that allows one request per `intervalMs`.
 * With `maxWaitMs`, give up (return false) rather than wait longer: used for
 * nice-to-haves like search suggestions, so they never delay real searches.
 */
export async function pace(name, intervalMs, { maxWaitMs = Infinity } = {}) {
  const store = await backend()
  const giveUpAt = Date.now() + maxWaitMs
  for (;;) {
    if (await store.acquire(`pace:${name}`, intervalMs)) return true
    if (Date.now() + 100 > giveUpAt) return false
    await sleep(Math.min(100, intervalMs))
  }
}

// ---------- client addresses ----------

/**
 * The address used to identify a visitor. IPv6 visitors usually control a whole /64,
 * so they're grouped by that prefix. X-Forwarded-For is only trusted behind a proxy
 * that sets it (TRUST_PROXY=1); otherwise anyone could forge it.
 */
export function clientAddress(req, trustProxy = process.env.TRUST_PROXY === '1') {
  const forwarded = trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  const ip = forwarded || req.socket?.remoteAddress || 'unknown'
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7)
  if (!ip.includes(':')) return ip
  const [head, tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`
}
