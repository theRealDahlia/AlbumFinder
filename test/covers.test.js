import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, utimes, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadApi, mockFetch, uuid } from './helpers.js'

const { api, dir } = await loadApi()
const { pruneCovers } = await import('../server/covers.js')
const realFetch = globalThis.fetch
const server = createServer((req, res) => api.apiMiddleware(req, res, () => res.end()))
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
after(() => server.close())

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const image = (body = JPEG, type = 'image/jpeg') => () => new Response(body, { status: 200, headers: { 'content-type': type } })
const archive = (id) => `coverartarchive.org/release-group/${id}/front-250`

test('fetches a cover once, then serves it from disk with long caching', async () => {
  let fetched = 0
  mockFetch({
    [archive(uuid(1))]: () => {
      fetched++
      return image()()
    },
  })
  for (let i = 0; i < 2; i++) {
    const res = await realFetch(`${base}/api/cover/${uuid(1)}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.match(res.headers.get('cache-control'), /max-age=2592000/)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG)
  }
  assert.equal(fetched, 1)
  assert.ok((await readdir(join(dir, 'covers'))).includes(`${uuid(1)}.jpg`))
})

test('concurrent requests for the same cover share one download', async () => {
  let fetched = 0
  mockFetch({
    [archive(uuid(2))]: async () => {
      fetched++
      await new Promise((r) => setTimeout(r, 50))
      return image()()
    },
  })
  const all = await Promise.all([1, 2, 3].map(() => realFetch(`${base}/api/cover/${uuid(2)}`)))
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200])
  assert.equal(fetched, 1)
})

test('a missing cover is a cached 404, so the archive isn’t asked again for a day', async () => {
  let fetched = 0
  mockFetch({
    [archive(uuid(3))]: () => {
      fetched++
      return new Response('', { status: 404 })
    },
  })
  for (let i = 0; i < 2; i++) assert.equal((await realFetch(`${base}/api/cover/${uuid(3)}`)).status, 404)
  assert.equal(fetched, 1)
})

test('archive errors and non-images are not cached', async () => {
  let calls = 0
  mockFetch({
    [archive(uuid(4))]: () => (++calls === 1 ? new Response('busy', { status: 503 }) : image(Buffer.from('<html>'), 'text/html')()),
  })
  assert.equal((await realFetch(`${base}/api/cover/${uuid(4)}`)).status, 502)
  assert.equal((await realFetch(`${base}/api/cover/${uuid(4)}`)).status, 502)
  assert.equal(calls, 2, 'asked again after a failure')
})

test('only MusicBrainz ids are accepted', async () => {
  const calls = mockFetch({})
  for (const id of ['../../etc/passwd', 'nope', `${uuid(5)}.jpg`]) {
    assert.equal((await realFetch(`${base}/api/cover/${encodeURIComponent(id)}`)).status, 400, id)
  }
  assert.equal(calls.length, 0)
})

test('pruning keeps the newest covers', async () => {
  const covers = join(dir, 'covers')
  await mkdir(covers, { recursive: true })
  for (let i = 10; i < 15; i++) {
    const file = join(covers, `${uuid(i)}.jpg`)
    await writeFile(file, JPEG)
    const t = new Date(Date.now() - (20 - i) * 60_000) // uuid(14) is newest
    await utimes(file, t, t)
  }
  const before = (await readdir(covers)).length
  assert.equal(await pruneCovers(before - 2), 2)
  const left = await readdir(covers)
  assert.ok(!left.includes(`${uuid(10)}.jpg`) && !left.includes(`${uuid(11)}.jpg`), 'the oldest two went')
  assert.ok(left.includes(`${uuid(14)}.jpg`))
})
