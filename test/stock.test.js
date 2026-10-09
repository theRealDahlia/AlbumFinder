import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, loadApi, mockFetch } from './helpers.js'

const { api, dir } = await loadApi()
const { isVinyl, listingMatches } = await import('../server/stock.js')
const discogs = await import('../server/discogs.js')
const realFetch = globalThis.fetch

// ---------- matching ----------

test('matching: titles ignore edition words; artists ignore "and"/"&" and "The"', () => {
  const item = (title, artist) => ({ title, artist })
  const rumours = { album: 'Rumours', artist: 'Fleetwood Mac' }
  assert.ok(listingMatches(item('Rumours', 'Fleetwood Mac'), rumours))
  assert.ok(listingMatches(item('Rumours (Deluxe Edition)', 'Fleetwood Mac'), rumours))
  assert.ok(!listingMatches(item('Rumours Live', 'Fleetwood Mac'), rumours), 'a different album')
  assert.ok(!listingMatches(item('Rumours', 'Some Tribute Band'), rumours))
  assert.ok(listingMatches(item('Bookends', 'Simon & Garfunkel'), { album: 'Bookends', artist: 'Simon and Garfunkel' }))
  assert.ok(listingMatches(item('Kid A', 'Radiohead'), { album: '', artist: 'Radiohead' }), 'artist only: anything by them')
  assert.ok(!listingMatches(item('Kid A', 'Radiohead'), { album: '', artist: '' }))
})

test('vinyl formats', () => {
  for (const f of ['LP, Album', '2xLP, Album, RE', '12"', '7", Single', 'Vinyl, LP', 'EP', '2xLP, Album + CD']) {
    assert.ok(isVinyl(f), f)
  }
  for (const f of ['CD, Album', 'CD, EP', 'Cassette, EP', 'File, MP3', '', null]) assert.ok(!isVinyl(f), String(f))
})

// ---------- Discogs ----------

const listing = (title, artist, format, price = 20) => ({
  release: { title, artist, format },
  condition: 'Very Good Plus (VG+)',
  price: { value: price, currency: 'GBP' },
  uri: `https://www.discogs.com/sell/item/${title.length}${price}`,
})

test('linking checks the seller exists', async () => {
  mockFetch({
    'api.discogs.com/users/realshop': () => json({ username: 'RealShop', num_for_sale: 120 }),
    'api.discogs.com/users/nobody': () => new Response('{}', { status: 404 }),
  })
  assert.deepEqual(await discogs.linkSeller('node/1', 'realshop'), { seller: 'RealShop', forSale: 120 })
  await assert.rejects(discogs.linkSeller('node/2', 'nobody'), /No such Discogs seller/)
  await assert.rejects(discogs.linkSeller('not-an-id', 'realshop'), /OpenStreetMap shop id/)
  await assert.rejects(discogs.linkSeller('node/3', '../../etc'), /Discogs username/)
  assert.deepEqual(Object.keys(await discogs.readLinks()), ['node/1'])
})

test('syncing reads every page, keeps vinyl only, and tidies artist names', async () => {
  const pages = {
    1: [listing('Rumours', 'Fleetwood Mac', 'LP, Album'), listing('Rumours', 'Fleetwood Mac', 'CD, Album')],
    2: [listing('1999', 'Prince (2)*', '2xLP, Album', 35)],
  }
  const calls = mockFetch({
    'api.discogs.com/users/RealShop/inventory': (url) => {
      const page = Number(url.searchParams.get('page'))
      return json({ pagination: { page, pages: 2 }, listings: pages[page] })
    },
  })
  const [result] = await discogs.syncAll({ force: true })
  assert.deepEqual(result, { seller: 'RealShop', status: 'synced', items: 2 })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.searchParams.get('status'), 'For Sale')
  const saved = JSON.parse(await readFile(join(dir, 'discogs', 'realshop.json'), 'utf8'))
  assert.deepEqual(saved.items.map((i) => `${i.artist} – ${i.title}`), ['Fleetwood Mac – Rumours', 'Prince – 1999'])

  assert.deepEqual((await discogs.syncAll())[0].status, 'fresh', 'synced less than a day ago: skipped')
})

test('the stock report finds the album at linked shops, and says what it searched', async () => {
  const report = await discogs.stockReport({ album: '1999', artist: 'Prince' })
  assert.deepEqual(Object.keys(report.stock), ['node/1'])
  assert.equal(report.stock['node/1'][0].source, 'discogs')
  assert.equal(report.stock['node/1'][0].price, 35)
  assert.deepEqual(report.others, {})
  assert.deepEqual(report.checked, ['node/1'])
  assert.equal(report.pending, 0)
})

test('with the artist but not the album, a shop has other works by them; with neither, nothing', async () => {
  const other = await discogs.stockReport({ album: 'Purple Rain', artist: 'Prince' })
  assert.deepEqual(other.stock, {})
  assert.deepEqual(Object.keys(other.others), ['node/1'])
  assert.equal(other.others['node/1'][0].title, '1999')
  assert.deepEqual(other.checked, ['node/1'], 'searched, so a shop in neither map really has nothing')

  const none = await discogs.stockReport({ album: 'Kid A', artist: 'Radiohead' })
  assert.deepEqual([none.stock, none.others, none.checked], [{}, {}, ['node/1']])

  const artistOnly = await discogs.stockReport({ album: '', artist: 'Prince' })
  assert.deepEqual(Object.keys(artistOnly.stock), ['node/1'], 'an artist search lists their records as stock')
  assert.deepEqual(artistOnly.others, {})
})

// ---------- through the API ----------

const server = createServer((req, res) => api.apiMiddleware(req, res, () => res.end()))
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
after(() => server.close())

test('GET /api/stock returns matches from linked shops, and needs a query', async () => {
  const { stock } = await (await realFetch(`${base}/api/stock?album=1999&artist=Prince`)).json()
  assert.deepEqual(Object.keys(stock), ['node/1'])
  assert.equal(stock['node/1'][0].source, 'discogs')
  assert.equal((await realFetch(`${base}/api/stock`)).status, 400)
})

test('shops can no longer manage stock through the site', async () => {
  for (const method of ['GET', 'PUT']) {
    assert.equal((await realFetch(`${base}/api/manage`, { method })).status, 404, method)
  }
})
