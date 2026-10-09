import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { json, loadApi, mockFetch } from './helpers.js'
import { memoryBackend, setBackend } from '../server/shared.js'

const { api } = await loadApi()
const realFetch = globalThis.fetch
// Discogs allows a request every 1-2.5 s; the tests shouldn't wait for that.
setBackend({ ...memoryBackend(), acquire: async () => true })

const server = createServer((req, res) => api.apiMiddleware(req, res, () => res.end()))
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
after(() => server.close())
const get = async (path) => (await realFetch(`${base}${path}`)).json()

const lp = (title, artist) => ({ release: { title, artist, format: 'LP, Album' }, price: { value: 20, currency: 'USD' } })
const shop = (id, name) => ({
  type: 'node',
  id,
  lat: 53.8,
  lon: -1.55,
  tags: { name, shop: 'records', opening_hours: 'Mo-Sa 10:00-18:00', 'addr:city': 'Leeds', website: `https://${name.replace(' ', '').toLowerCase()}.example` },
})
// Shop A has the album, B has other Fleetwood Mac, C has neither, and D isn't on Discogs at all.
const INVENTORY = {
  ShopA: [lp('Rumours', 'Fleetwood Mac'), lp('Kid A', 'Radiohead')],
  ShopB: [lp('Tusk', 'Fleetwood Mac'), lp('Mirage', 'Fleetwood Mac')],
  ShopC: [lp('Kid A', 'Radiohead')],
}
const inventoryRoute = (seller) => () => json({ pagination: { page: 1, pages: 1, items: INVENTORY[seller].length }, listings: INVENTORY[seller] })
const profileRoute = (seller) => () =>
  json({ username: seller, num_for_sale: INVENTORY[seller].length, home_page: `https://${seller.toLowerCase()}.example` })

mockFetch({
  'nominatim.openstreetmap.org': () => json([{ addresstype: 'city', lat: '53.8', lon: '-1.55', display_name: 'Leeds', boundingbox: ['53.7', '53.9', '-1.7', '-1.4'] }]),
  'overpass-api.de': () => json({ elements: [shop(1, 'Shop A'), shop(2, 'Shop B'), shop(3, 'Shop C'), shop(4, 'Shop D')] }),
  'api.discogs.com': () => new Response('{}', { status: 404 }),
  ...Object.fromEntries(
    Object.keys(INVENTORY).flatMap((seller) => [
      [`api.discogs.com/users/${seller.toLowerCase()}`, profileRoute(seller)],
      [`api.discogs.com/users/${seller}/inventory`, inventoryRoute(seller)],
    ]),
  ),
})

async function until(ask, done) {
  for (let i = 0; i < 400; i++) {
    const answer = await ask()
    if (done(answer)) return answer
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('gave up waiting')
}

const SEARCH = '/api/stock?album=Rumours&artist=Fleetwood+Mac'

test('before any shop is verified there is nothing to report', async () => {
  assert.deepEqual(await get(SEARCH), { stock: {}, others: {}, checked: [], pending: 0 })
})

test('verified shops are told apart: has the album, has other works by the artist, has neither', async () => {
  await get('/api/stores?city=Leeds')
  const ids = 'node/1,node/2,node/3,node/4'
  const { verified } = await until(() => get(`/api/verification?ids=${ids}`), (a) => !a.pending)
  assert.deepEqual(Object.keys(verified), ['node/1', 'node/2', 'node/3'], 'Shop D is not on Discogs')

  const report = await until(() => get(SEARCH), (r) => !r.pending)
  assert.deepEqual(Object.keys(report.stock), ['node/1'])
  assert.equal(report.stock['node/1'][0].title, 'Rumours')
  assert.deepEqual(Object.keys(report.others), ['node/2'])
  assert.deepEqual(report.others['node/2'].map((i) => i.title), ['Tusk', 'Mirage'])
  assert.deepEqual(report.checked.sort(), ['node/1', 'node/2', 'node/3'], 'C was searched and has neither; D was never checked')
})

test('an artist search counts their records as stock, and an album with no artist has no "other works"', async () => {
  const artist = await get('/api/stock?artist=Fleetwood+Mac')
  assert.deepEqual(Object.keys(artist.stock).sort(), ['node/1', 'node/2'])
  assert.deepEqual(artist.others, {})

  const albumOnly = await get('/api/stock?album=Kid+A')
  assert.deepEqual(albumOnly.others, {}, 'without an artist there is no "other works"')
})
