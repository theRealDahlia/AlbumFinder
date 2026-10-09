import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, loadApi, mockFetch } from './helpers.js'
import { memoryBackend } from '../server/shared.js'

const { dir } = await loadApi()
const { setBackend } = await import('../server/shared.js')
const verify = await import('../server/verify.js')
// Discogs allows a request every 1-2.5 s; the tests shouldn't wait for that.
setBackend({ ...memoryBackend(), acquire: async () => true })

const lp = (title = 'Rumours', format = 'LP, Album') => ({ release: { title, artist: 'Fleetwood Mac', format } })
const profile = (extra = {}) => ({ username: 'RoughTrade', num_for_sale: 50, ...extra })
const notFound = () => new Response('{}', { status: 404 })

// ---------- guessing and matching ----------

test('candidates: the website, then the name with and without shop words', () => {
  assert.deepEqual(verify.discogsCandidates({ name: 'Rough Trade Records', website: 'https://www.roughtrade.com/shop' }), [
    'roughtrade',
    'roughtraderecords',
    'rough_trade_records',
    'rough-trade-records',
    'rough_trade',
  ])
  assert.deepEqual(verify.discogsCandidates({ name: 'Amoeba Music', website: 'amoeba.com' }), ['amoeba', 'amoebamusic', 'amoeba_music', 'amoeba-music'])
  assert.deepEqual(verify.discogsCandidates({ name: 'Disque', website: 'https://shop.disque.co.uk/' }), ['disque'], 'country domains, subdomains and no repeats')
  assert.deepEqual(verify.discogsCandidates({ name: 'Ab', website: null }), [], 'names under 3 letters give nothing to look up')
  assert.deepEqual(verify.discogsCandidates({ name: 'Café Vinyl', website: null }), ['cafevinyl', 'cafe', 'cafe_vinyl', 'cafe-vinyl'], 'accents are dropped')
  assert.deepEqual(verify.discogsCandidates({ name: '!!', website: null }), [])
})

test('a profile matches by website, or by name and city together, and never by name alone', () => {
  const shop = { name: 'Rough Trade', website: 'https://www.roughtrade.com/', city: 'London' }
  assert.equal(verify.profileMatch(profile({ home_page: 'http://roughtrade.com' }), shop), 'website')
  assert.equal(verify.profileMatch(profile({ name: 'Rough Trade Records', location: 'Brick Lane, London, UK' }), { ...shop, website: null }), 'name and city')
  assert.equal(verify.profileMatch(profile({ username: 'roughtrade', location: 'Brooklyn, NY' }), shop), null, 'same name, different city')
  assert.equal(verify.profileMatch(profile({ username: 'roughtrade' }), shop), null, 'no location given')
  assert.equal(verify.profileMatch(profile({ username: 'smoothtrade', name: 'Smooth Trade', location: 'London', home_page: 'https://other.com' }), shop), null, 'different name and website')
  assert.equal(verify.profileMatch(profile({ username: 'roughtrade', location: 'Londonderry' }), shop), null, 'a city must be a whole word')
  assert.equal(verify.profileMatch(profile({ username: 'x', home_page: 'https://roughtrade.com' }), { ...shop, website: null }), null, 'the shop has no website to compare')
})

// ---------- checking one shop ----------

test('a shop is verified when its Discogs profile matches and it has vinyl for sale', async () => {
  const calls = mockFetch({
    'api.discogs.com/users/roughtrade': () => json(profile({ home_page: 'https://roughtrade.com' })),
    'api.discogs.com/users/RoughTrade/inventory': () => json({ pagination: { items: 2 }, listings: [lp('Rumours', 'CD, Album'), lp()] }),
  })
  const shop = { id: 'node/1', name: 'Rough Trade', website: 'https://www.roughtrade.com', city: 'London' }
  assert.deepEqual(await verify.verifyStore(shop), { status: 'verified', seller: 'RoughTrade', basis: 'website' })
  assert.equal(calls.length, 2, 'the profile, then the inventory')
})

test('guesses that are not the shop are skipped, and a shop can match by name and city', async () => {
  const calls = mockFetch({
    'api.discogs.com/users/waxhall': notFound,
    'api.discogs.com/users/wax_hall': () => json(profile({ username: 'wax_hall', name: 'Wax Hall', location: 'Leeds, UK' })),
    'api.discogs.com/users/wax_hall/inventory': () => json({ listings: [lp('Kid A', '2xLP, Album')] }),
  })
  const shop = { id: 'node/2', name: 'Wax Hall', website: null, city: 'Leeds' }
  assert.deepEqual(await verify.verifyStore(shop), { status: 'verified', seller: 'wax_hall', basis: 'name and city' })
  assert.deepEqual(calls.map((c) => c.url.pathname), ['/users/waxhall', '/users/wax_hall', '/users/wax_hall/inventory'])
})

test('a matching seller with no vinyl does not count', async () => {
  const calls = mockFetch({
    'api.discogs.com/users/crates': () => json(profile({ username: 'crates', home_page: 'https://crates.example' })),
    'api.discogs.com/users/crates/inventory': () => json({ listings: [lp('Rumours', 'CD, Album'), lp('Kid A', 'Cassette')] }),
  })
  const shop = { id: 'node/6', name: 'Crates', website: 'https://crates.example', city: 'Leeds' }
  assert.deepEqual(await verify.verifyStore(shop), { status: 'unverified' })
  assert.equal(calls.length, 2)
})

test('a seller with nothing for sale is not looked into, and a hidden inventory counts as no vinyl', async () => {
  const calls = mockFetch({
    'api.discogs.com': notFound,
    'api.discogs.com/users/emptyshop': () => json(profile({ username: 'emptyshop', num_for_sale: 0, home_page: 'https://empty.example' })),
    'api.discogs.com/users/hiddenshop': () => json(profile({ username: 'hiddenshop', home_page: 'https://hidden.example' })),
    'api.discogs.com/users/hiddenshop/inventory': () => new Response('{}', { status: 403 }),
  })
  assert.deepEqual(await verify.verifyStore({ id: 'node/3', name: 'Emptyshop', website: 'https://empty.example' }), { status: 'unverified' })
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/inventory')), 'no listings: no inventory request')
  assert.deepEqual(await verify.verifyStore({ id: 'node/4', name: 'Hiddenshop', website: 'https://hidden.example' }), { status: 'unverified' })
})

test('when Discogs itself fails, the check throws instead of calling the shop unverified', async () => {
  mockFetch({ 'api.discogs.com': () => new Response('oops', { status: 500 }) })
  await assert.rejects(verify.verifyStore({ id: 'node/5', name: 'Whoever', website: null }), /Discogs returned 500/)
})

// ---------- the background queue ----------

async function settled(ids) {
  for (let i = 0; i < 100; i++) {
    const answer = await verify.verificationFor(ids)
    if (!answer.pending) return answer
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('still pending')
}

const savedFile = () => readFile(join(dir, 'discogs-verified.json'), 'utf8').then(JSON.parse, () => ({}))

test('shops the server never returned are ignored', async () => {
  const calls = mockFetch({})
  assert.deepEqual(await verify.verificationFor(['node/999', 'way/1']), { verified: {}, pending: 0 })
  assert.equal(calls.length, 0)
})

test('remembered shops are checked in the background, saved, and not checked again while fresh', async () => {
  const calls = mockFetch({
    'api.discogs.com/users/vinylhouse': () => json(profile({ username: 'VinylHouse', home_page: 'http://vinylhouse.example' })),
    'api.discogs.com/users/VinylHouse/inventory': () => json({ listings: [lp()] }),
    'api.discogs.com': notFound,
  })
  verify.rememberStores([
    { id: 'node/10', name: 'Vinyl House', website: 'http://vinylhouse.example', city: 'Leeds' },
    { id: 'node/11', name: 'No Discogs Records', website: null },
  ])
  const first = await verify.verificationFor(['node/10', 'node/11'])
  assert.equal(first.pending, 2, 'both are queued, nothing is known yet')
  assert.deepEqual(first.verified, {})

  const done = await settled(['node/10', 'node/11'])
  assert.deepEqual(done.verified, { 'node/10': { seller: 'VinylHouse', url: 'https://www.discogs.com/seller/VinylHouse/profile' } })
  const saved = await savedFile()
  assert.equal(saved['node/10'].status, 'verified')
  assert.equal(saved['node/11'].status, 'unverified')

  const before = calls.length
  await verify.verificationFor(['node/10', 'node/11'])
  assert.equal(calls.length, before, 'fresh answers are reused')
})

test('a renamed shop is checked again', async () => {
  const calls = mockFetch({ 'api.discogs.com': notFound })
  verify.rememberStores([{ id: 'node/20', name: 'Old Name Records', website: null }])
  await settled(['node/20'])
  const checked = calls.length
  verify.rememberStores([{ id: 'node/20', name: 'New Name Records', website: null }])
  await settled(['node/20'])
  assert.ok(calls.length > checked)
  assert.equal((await savedFile())['node/20'].name, 'New Name Records')
})

test('a failed check is not saved, is not retried straight away, and does not hold the page waiting', async () => {
  const calls = mockFetch({ 'api.discogs.com': () => new Response('down', { status: 500 }) })
  verify.rememberStores([{ id: 'node/30', name: 'Flaky Shop', website: null }])
  await settled(['node/30'])
  assert.equal((await savedFile())['node/30'], undefined)
  const checked = calls.length
  assert.deepEqual(await verify.verificationFor(['node/30']), { verified: {}, pending: 0 })
  assert.equal(calls.length, checked, 'cooling off')
})
