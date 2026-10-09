import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadApi, uuid } from './helpers.js'

const { api, dir } = await loadApi()
const realFetch = globalThis.fetch

// ---------- API middleware ----------

const server = createServer((req, res) =>
  api.apiMiddleware(req, res, () => {
    res.statusCode = 418
    res.end('next')
  }),
)
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
after(() => server.close())

/** Raw request so paths are sent exactly as written (fetch would normalise them). */
function raw(port, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ port, path, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('passes non-API requests on', async () => {
  assert.equal((await fetch(`${base}/index.html`)).status, 418)
})

test('unknown API routes and methods are 404', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404)
  assert.equal((await fetch(`${base}/api/albums`, { method: 'DELETE' })).status, 404)
})

test('missing query parameters are 400 with a message', async () => {
  for (const path of ['/api/albums', '/api/stores']) {
    const res = await fetch(base + path)
    assert.equal(res.status, 400, path)
    assert.ok((await res.json()).error, path)
  }
})

test('stock reports are no longer accepted or served', async () => {
  const post = await fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ albumId: uuid(9), storeId: 'way/7', status: 'in_stock' }),
  })
  assert.equal(post.status, 404)
  assert.equal((await fetch(`${base}/api/reports?albumId=${uuid(9)}`)).status, 404)
})

test('GET /api/albums accepts album, artist, or the older q parameter', async () => {
  // Fake MusicBrainz for the server; this test's own requests use the real fetch.
  const seen = []
  globalThis.fetch = async (input) => {
    const url = new URL(input)
    seen.push(url.searchParams.get('query'))
    return Response.json(url.pathname.endsWith('/artist') ? { artists: [] } : { 'release-groups': [] })
  }
  try {
    for (const qs of ['album=Blue&artist=Joni', 'q=Blue', 'artist=Joni']) {
      assert.equal((await realFetch(`${base}/api/albums?${qs}`)).status, 200, qs)
    }
  } finally {
    globalThis.fetch = realFetch
  }
  assert.match(seen[0], /releasegroup:\(Blue\) AND artist:\(Joni\)/)
  assert.match(seen[1], /releasegroup:\(Blue\)\^3/)
  assert.match(seen[2], /^artist:\(Joni\)$/)
})

test('GET /api/stores rejects a state without a city', async () => {
  const res = await fetch(`${base}/api/stores?state=OR`)
  assert.equal(res.status, 400)
})

test('a malformed request URL does not crash the middleware', async () => {
  const port = server.address().port
  const res = await raw(port, '/api/albums?q=%E0%A4%A')
  assert.ok(res.status < 500, `status ${res.status}`)
  assert.equal((await fetch(`${base}/api/nope`)).status, 404, 'server still up')
})

// ---------- production server ----------

const root = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(`${root}/dist/index.html`)

test('production server survives bad paths and never serves files outside dist', { skip: !built && 'run `npm run build` first' }, async () => {
  const port = 30000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (c) => String(c).includes('running') && resolve())
      child.on('exit', () => reject(new Error(`server exited: ${stderr}`)))
    })

    const index = await raw(port, '/')
    assert.equal(index.status, 200)
    assert.match(index.body, /<div id="root">/)

    for (const path of ['/%E0', '/..%2fpackage.json', '/../package.json', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await raw(port, path)
      assert.ok(res.status < 500, `${path} → ${res.status}`)
      assert.doesNotMatch(res.body, /"scripts"|root:/, `${path} leaked a file`)
    }
    // Caching: fingerprinted build files never change, the page itself must always be revalidated.
    const asset = index.body.match(/\/assets\/[\w.-]+\.js/)[0]
    const assetRes = await realFetch(`http://localhost:${port}${asset}`)
    assert.equal(assetRes.status, 200)
    assert.match(assetRes.headers.get('cache-control'), /immutable/)
    assert.equal((await realFetch(`http://localhost:${port}/`)).headers.get('cache-control'), 'no-cache')

    assert.equal((await raw(port, '/', { method: 'POST' })).status, 405, 'pages are GET/HEAD only')
    assert.equal(child.exitCode, null, `server crashed: ${stderr}`)
    assert.equal((await raw(port, '/')).status, 200, 'still serving after bad requests')
  } finally {
    child.kill()
  }
})
