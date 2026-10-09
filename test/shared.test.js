import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { loadApi, json, mockFetch } from './helpers.js'
import { cached, clientAddress, memoryBackend, overLimit, pace, redisBackend, setBackend, backend } from '../server/shared.js'

/** Just enough of node-redis for the backend: string values with expiry and NX. */
function fakeRedis() {
  const data = new Map()
  const live = (k) => {
    const e = data.get(k)
    if (e && e.expires && e.expires <= Date.now()) data.delete(k)
    return data.get(k)
  }
  return {
    async get(k) {
      return live(k)?.value ?? null
    },
    async set(k, value, { PX, NX } = {}) {
      if (NX && live(k)) return null
      data.set(k, { value, expires: PX ? Date.now() + PX : 0 })
      return 'OK'
    },
    async dbSize() {
      return data.size
    },
  }
}

for (const [name, make] of [
  ['memory', () => memoryBackend()],
  ['redis', () => redisBackend(fakeRedis())],
]) {
  test(`${name}: cached() runs once, shares concurrent calls, and doesn't cache failures`, async () => {
    setBackend(make())
    let runs = 0
    const work = async () => {
      runs++
      return { n: runs }
    }
    const [x, y] = await Promise.all([cached(`${name}-a`, work), cached(`${name}-a`, work)])
    assert.deepEqual([x, y, runs], [{ n: 1 }, { n: 1 }, 1])
    assert.deepEqual(await cached(`${name}-a`, work), { n: 1 }, 'served from the cache')

    await assert.rejects(cached(`${name}-b`, async () => Promise.reject(new Error('down'))))
    assert.equal(await cached(`${name}-b`, async () => 'up'), 'up', 'a failure is retried next time')
  })

  test(`${name}: overLimit() allows max requests per window, then says how long to wait`, async () => {
    setBackend(make())
    // A fixed clock, so the answer doesn't depend on when in the minute the test runs.
    const now = 1_000 * 60_000 + 20_000
    for (let i = 0; i < 3; i++) assert.equal(await overLimit(`${name}-visitor`, 3, 60_000, now), 0)
    const wait = await overLimit(`${name}-visitor`, 3, 60_000, now)
    assert.ok(wait > 0 && wait <= 60, `wait ${wait}`)
    assert.equal(await overLimit(`${name}-visitor`, 3, 60_000, now + 1000), wait - 1, 'refusals don’t extend the wait')
    assert.equal(await overLimit(`${name}-someone-else`, 3, 60_000, now), 0)
  })

  test(`${name}: pace() spaces calls out, and gives up when told not to wait`, async () => {
    setBackend(make())
    const t = Date.now()
    assert.equal(await pace(`${name}-svc`, 300), true)
    assert.equal(await pace(`${name}-svc`, 300), true)
    assert.ok(Date.now() - t >= 250, 'the second call waited its turn')
    assert.equal(await pace(`${name}-svc`, 5000, { maxWaitMs: 50 }), false, 'busy: gave up instead of waiting 5s')
  })
}

test('limits can’t be doubled by straddling the start of a new minute', async () => {
  setBackend(memoryBackend())
  const minute = 60_000
  const start = 100 * minute
  // 3 requests in the last moments of one minute…
  for (let i = 0; i < 3; i++) assert.equal(await overLimit('straddler', 3, minute, start + minute - 100), 0)
  // …don't buy 3 more a moment later, just because the clock ticked over.
  const wait = await overLimit('straddler', 3, minute, start + minute + 100)
  assert.ok(wait > 0, 'refused')
  assert.ok(wait <= 60, `told to wait ${wait}s, at most a minute`)
  // A minute later, the earlier requests have aged out.
  assert.equal(await overLimit('straddler', 3, minute, start + 2 * minute + 61_000), 0)
})

test('never more than the limit in any minute, wherever in the minute a burst starts', async () => {
  const minute = 60_000
  for (let offset = 0; offset < minute; offset += 7_000) {
    setBackend(memoryBackend())
    const allowed = []
    const t0 = 900 * minute + offset
    for (let t = t0; t < t0 + 3 * minute; t += 250) {
      const wait = await overLimit('burst', 30, minute, t)
      if (wait === 0) allowed.push(t)
      else assert.ok(wait >= 1 && wait <= 60, `wait ${wait}`)
    }
    for (let i = 0, j = 0; i < allowed.length; i++) {
      while (allowed[i] - allowed[j] >= minute) j++
      assert.ok(i - j + 1 <= 30, `${i - j + 1} requests within a minute (burst starting ${offset}ms in)`)
    }
  }
})

test('clientAddress: IPv6 grouped by /64, proxy header only when trusted', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
  assert.equal(clientAddress(req('::ffff:203.0.113.9'), false), '203.0.113.9')
  assert.equal(clientAddress(req('2001:db8:aa:1::5'), false), '2001:db8:aa:1::/64')
  const proxied = req('10.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })
  assert.equal(clientAddress(proxied, false), '10.0.0.1')
  assert.equal(clientAddress(proxied, true), '198.51.100.7')
})

// ---------- through the API ----------

process.env.TRUST_PROXY = '1'
const { api } = await loadApi()
const server = createServer((req, res) => api.apiMiddleware(req, res, () => res.end()))
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
after(() => server.close())
const realFetch = globalThis.fetch

test('each visitor gets 30 searches a minute, then 429 with Retry-After', async () => {
  setBackend(null) // the default backend, as the server uses it
  mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  const get = (ip, q) => realFetch(`${base}/api/albums?album=${q}`, { headers: { 'x-forwarded-for': ip } })
  // Same query each time: answered from the cache, but still counted.
  for (let i = 0; i < 30; i++) assert.equal((await get('198.51.100.1', 'limits')).status, 200, `request ${i + 1}`)
  const limited = await get('198.51.100.1', 'limits')
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.match((await limited.json()).error, /Too many requests/)
  assert.equal((await get('198.51.100.2', 'limits')).status, 200, 'other visitors are unaffected')
})

test('GET /api/health reports status, upstream services and the cache', async () => {
  const res = await realFetch(`${base}/api/health`)
  assert.equal(res.status, 200)
  const health = await res.json()
  assert.ok(['ok', 'degraded'].includes(health.status))
  assert.equal(typeof health.uptimeSeconds, 'number')
  assert.equal(health.cache.backend, 'memory')
  assert.ok(health.upstream.musicbrainz.ok >= 1, 'the searches above were recorded')
})

test('health turns "degraded" when a service’s latest call failed', async () => {
  mockFetch({ 'musicbrainz.org': () => new Response('down', { status: 500, headers: { 'content-type': 'text/plain' } }) })
  await realFetch(`${base}/api/albums?album=health-check-failure`, { headers: { 'x-forwarded-for': '198.51.100.9' } })
  const health = await (await realFetch(`${base}/api/health`)).json()
  assert.equal(health.status, 'degraded')
  assert.deepEqual(health.failing, ['musicbrainz'])
})

test('only GET is allowed', async () => {
  assert.equal((await realFetch(`${base}/api/albums?album=x`, { method: 'POST' })).status, 404)
})

test('backend() is memory without REDIS_URL', async () => {
  setBackend(null)
  assert.equal((await backend()).kind, 'memory')
})
