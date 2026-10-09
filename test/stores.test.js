import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, html, mockFetch, loadApi } from './helpers.js'

const { api, dir } = await loadApi()

// A store list cached long ago, used to check the stale fallback.
const STALE = {
  city: { name: 'Staleville', lat: 1, lon: 1 },
  stores: [
    { id: 'node/1', name: 'Old Shop', hours: 'Mo-Fr 10:00-17:00' },
    { id: 'node/2', name: 'Saved Before Hours Were Required', hours: null },
  ],
}
const DAY = 86400000
await writeFile(
  join(dir, 'stores-cache.json'),
  JSON.stringify({
    staleville: { value: STALE, savedAt: Date.now() - 8 * DAY }, // stale, but kept as a fallback
    ancientville: { value: STALE, savedAt: Date.now() - 40 * DAY }, // too old to keep
  }),
)

const portland = {
  addresstype: 'city',
  lat: '45.52',
  lon: '-122.67',
  display_name: 'Portland, Oregon, United States',
  boundingbox: ['45.43', '45.65', '-122.84', '-122.47'],
}

const ELEMENTS = [
  {
    type: 'node',
    id: 1,
    lat: 45.523,
    lon: -122.68,
    tags: {
      name: 'Everyday Music',
      shop: 'music',
      'addr:housenumber': '1313',
      'addr:street': 'W Burnside St',
      'addr:city': 'Portland',
      website: 'everydaymusic.com;https://other.example',
      'contact:phone': '+1 503 274 0961',
      opening_hours: 'Mo-Su 11:00-18:00',
    },
  },
  { type: 'way', id: 2, center: { lat: 45.5, lon: -122.6 }, tags: { name: 'Crossroads', shop: 'records', vinyl: 'only', opening_hours: 'Mo-Sa 10:00-18:00' } },
  { type: 'node', id: 3, lat: 45.5, lon: -122.6, tags: { shop: 'music' } }, // no name
  { type: 'node', id: 4, lat: 45.5, lon: -122.6, tags: { name: 'Portland Guitar Shop', shop: 'music', opening_hours: 'Mo-Sa 10:00-18:00' } },
  { type: 'node', id: 5, lat: 45.5, lon: -122.6, tags: { name: 'Bad URL', shop: 'music', website: 'javascript:alert(1)', opening_hours: 'Mo-Sa 10:00-18:00' } },
  { type: 'node', id: 6, lat: 45.5, lon: -122.6, tags: { name: 'No Hours Records', shop: 'records' } }, // no opening hours
  { type: 'node', id: 9, lat: 45.5, lon: -122.6, tags: { name: 'Blank Hours Records', shop: 'records', opening_hours: '  ' } },
]

const overpassOk = () => json({ elements: ELEMENTS })

test('turns Overpass elements into store records', async () => {
  const calls = mockFetch({ 'nominatim.openstreetmap.org': () => json([portland]), 'overpass-api.de': overpassOk })
  const { city, stores } = await api.findStores('Portland, OR')
  assert.equal(city.name, portland.display_name)
  const query = calls.find((c) => c.url.host === 'overpass-api.de').init.body.get('data')
  assert.equal(query.match(/\["opening_hours"\]/g).length, 4, 'every kind of shop is asked for with its opening hours')
  assert.deepEqual(
    stores.map((s) => s.id),
    ['node/1', 'way/2', 'node/5'],
    'unnamed shops, instrument shops and shops without opening hours are dropped',
  )
  const [everyday, crossroads, bad] = stores
  assert.equal(everyday.address, '1313 W Burnside St, Portland')
  assert.equal(everyday.city, 'Portland')
  assert.equal(crossroads.city, null)
  assert.equal(everyday.website, 'https://everydaymusic.com')
  assert.equal(everyday.phone, '+1 503 274 0961')
  assert.equal(everyday.hours, 'Mo-Su 11:00-18:00')
  assert.ok(everyday.distanceKm > 0 && everyday.distanceKm < 2)
  assert.deepEqual([crossroads.lat, crossroads.lon], [45.5, -122.6])
  assert.deepEqual(
    Object.keys(everyday).sort(),
    ['address', 'city', 'distanceKm', 'hours', 'id', 'lat', 'lon', 'name', 'phone', 'website'],
    'only fields the app uses',
  )
  assert.ok(bad.website.startsWith('https://'), 'non-http URLs are never passed through as-is')
})

test('prefers a city result and clamps a huge bounding box', async () => {
  const calls = mockFetch({
    'nominatim.openstreetmap.org': () =>
      json([
        { ...portland, addresstype: 'state', boundingbox: ['0', '1', '0', '1'] },
        { ...portland, boundingbox: ['40', '50', '-130', '-115'] },
      ]),
    'overpass-api.de': () => json({ elements: [] }),
  })
  await api.findStores('Big Region')
  const query = new URLSearchParams(calls.at(-1).init.body.toString()).get('data')
  const [south, west, north, east] = query.match(/\(([-\d.,]+)\)/)[1].split(',').map(Number)
  assert.ok(north - south <= 1.11, `lat span ${north - south}`)
  assert.ok(east - west < 2, `lon span ${east - west}`)
  assert.ok(south < 45.52 && north > 45.52 && west < -122.67 && east > -122.67)
})

test('returns 404 for an unknown city', async () => {
  mockFetch({ 'nominatim.openstreetmap.org': () => json([]) })
  await assert.rejects(api.findStores('Nowhereville'), { status: 404 })
})

test('falls back to the next Overpass mirror', async () => {
  const calls = mockFetch({
    'nominatim.openstreetmap.org': () => json([portland]),
    'overpass-api.de': () => html(504),
    'overpass.private.coffee': overpassOk,
  })
  const { stores } = await api.findStores('Mirror Town')
  assert.equal(stores.length, 3)
  assert.ok(calls.some((c) => c.url.host === 'overpass-api.de'))
})

test('treats a 200 response with a timeout remark as a failure', async () => {
  mockFetch({
    'nominatim.openstreetmap.org': () => json([portland]),
    'overpass.private.coffee': () => json({ elements: [], remark: 'runtime error: Query timed out in "query"' }),
    'overpass.kumi.systems': overpassOk,
    'overpass-api.de': () => html(504),
  })
  const { stores } = await api.findStores('Remark City')
  assert.equal(stores.length, 3, 'must not accept the empty, timed-out result')
})

test('saves results to the disk cache', async () => {
  mockFetch({ 'nominatim.openstreetmap.org': () => json([portland]), 'overpass.kumi.systems': overpassOk })
  await api.findStores('  Disk   City ')
  await new Promise((r) => setTimeout(r, 50))
  const disk = JSON.parse(await readFile(join(dir, 'stores-cache.json'), 'utf8'))
  assert.equal(disk['disk city'].value.stores.length, 3)
  assert.equal('ancientville' in disk, false, 'entries older than 30 days are dropped on save')
  assert.equal('staleville' in disk, true, 'stale but recent entries are kept as a fallback')
})

test('serves a stale cached list when every mirror is down', { timeout: 30000 }, async () => {
  mockFetch({
    'nominatim.openstreetmap.org': () => json([portland]),
    'overpass-api.de': () => html(504),
    'overpass.private.coffee': () => html(500),
    'overpass.kumi.systems': () => html(500),
  })
  const stale = await api.findStores('Staleville')
  assert.deepEqual(stale.stores, [STALE.stores[0]], 'a list saved before hours were required loses the shops without them')
  assert.equal(stale.city.name, 'Staleville')
  assert.equal(typeof stale.city.timezone, 'string', 'lists saved before timezones existed get one added')
})

test('rejects an empty city with 400', async () => {
  await assert.rejects(api.findStores(' '), { status: 400 })
})

test('placeQuery adds an optional state, expanding US abbreviations', () => {
  assert.equal(api.placeQuery('Portland', 'OR'), 'Portland, Oregon')
  assert.equal(api.placeQuery(' portland ', 'me.'), 'portland, Maine')
  assert.equal(api.placeQuery('Munich', 'Bavaria'), 'Munich, Bavaria')
  assert.equal(api.placeQuery('Berlin', ''), 'Berlin')
  assert.equal(api.placeQuery('Berlin', '   '), 'Berlin')
})

test('the state is sent to the geocoder and keeps same-named cities apart', async () => {
  const calls = mockFetch({
    'nominatim.openstreetmap.org': (url) =>
      json([{ ...portland, display_name: `Portland, ${url.searchParams.get('q').split(', ')[1]}` }]),
    'overpass.kumi.systems': () => json({ elements: [] }),
    'overpass-api.de': () => json({ elements: [] }),
    'overpass.private.coffee': () => json({ elements: [] }),
  })
  const oregon = await api.findStores('Springfield', 'OR')
  const illinois = await api.findStores('Springfield', 'IL')
  const queries = calls.filter((c) => c.url.host.startsWith('nominatim')).map((c) => c.url.searchParams.get('q'))
  assert.deepEqual(queries, ['Springfield, Oregon', 'Springfield, Illinois'])
  assert.notEqual(oregon.city.name, illinois.city.name)
})

test('a state alone is not enough', async () => {
  await assert.rejects(api.findStores('', 'OR'), { status: 400 })
})

// ---------- near a location ----------

test('stores near a location: rounded to ~1 km, within 15 km, with the local timezone', async () => {
  const calls = mockFetch({
    'overpass-api.de': () =>
      json({
        elements: [
          { type: 'node', id: 7, lat: 45.523, lon: -122.676, tags: { name: 'Close Records', shop: 'music', opening_hours: 'Mo-Sa 10:00-18:00' } },
          { type: 'node', id: 8, lat: 45.9, lon: -122.676, tags: { name: 'Too Far Records', shop: 'music', opening_hours: 'Mo-Sa 10:00-18:00' } },
        ],
      }),
  })
  const near = await api.findStoresNear('45.52347', '-122.67621')
  assert.deepEqual([near.city.lat, near.city.lon], [45.52, -122.68], 'only ~1 km precision is used')
  assert.equal(near.city.timezone, 'America/Los_Angeles')
  assert.equal(near.city.near, true)
  assert.deepEqual(near.stores.map((s) => s.name), ['Close Records'], '40 km away is dropped')
  assert.ok(!calls.some((c) => c.url.host.includes('nominatim')), 'no geocoding needed')
})

test('stores near a location: rejects nonsense coordinates', async () => {
  for (const [lat, lon] of [['abc', '1'], ['95', '0'], ['0', '200'], ['', '']]) {
    await assert.rejects(api.findStoresNear(lat, lon), { status: 400 }, `${lat},${lon}`)
  }
})

test('city lookups include the local timezone', async () => {
  mockFetch({ 'nominatim.openstreetmap.org': () => json([portland]), 'overpass-api.de': () => json({ elements: [] }) })
  assert.equal((await api.findStores('Timezone Town')).city.timezone, 'America/Los_Angeles')
})

// ---------- city suggestions ----------

test('city suggestions come from Photon, deduplicated, with city and state kept apart', async () => {
  const feature = (name, state, country, countrycode) => ({ properties: { name, state, country, countrycode } })
  mockFetch({
    'photon.komoot.io': () =>
      json({
        features: [
          feature('Portland', 'Oregon', 'United States', 'US'),
          feature('Portland', 'Oregon', 'United States', 'US'),
          feature('Portland', 'Maine', 'United States', 'US'),
          feature('Portsmouth', 'England', 'United Kingdom', 'GB'),
          feature('Portlaoise', null, 'Ireland', 'IE'),
        ],
      }),
  })
  assert.deepEqual(await api.suggestCities('portl'), [
    { value: 'Portland, Oregon', detail: 'United States', city: 'Portland', state: 'OR' }, // US states abbreviated
    { value: 'Portland, Maine', detail: 'United States', city: 'Portland', state: 'ME' },
    { value: 'Portsmouth, England', detail: 'United Kingdom', city: 'Portsmouth', state: 'England' },
    { value: 'Portlaoise', detail: 'Ireland', city: 'Portlaoise', state: '' },
  ])
})

test('city suggestions: too short, or the service failing, means none (never an error)', async () => {
  assert.deepEqual(await api.suggestCities('po'), [])
  mockFetch({ 'photon.komoot.io': () => new Response('down', { status: 503 }) })
  assert.deepEqual(await api.suggestCities('sprin'), [])
})

// ---------- keeping popular cities warm ----------

test('prefetch skips fresh cities and looks up the rest', async () => {
  const geocoded = []
  mockFetch({
    'nominatim.openstreetmap.org': (url) => {
      geocoded.push(url.searchParams.get('q'))
      return json([portland])
    },
    'overpass-api.de': () => json({ elements: [] }),
  })
  const results = await api.prefetchCities(['Timezone Town', 'Prefetch City, OR'])
  assert.deepEqual(results.map((r) => r.status), ['fresh', 'updated'])
  assert.deepEqual(geocoded, ['Prefetch City, Oregon'])
})

// ---------- map areas ----------

const reverse = (address) => () => json({ address })
const londonStores = () =>
  json({
    elements: [
      { type: 'node', id: 21, lat: 51.5401, lon: -0.1401, tags: { name: 'Two Doors Down', shop: 'music', opening_hours: 'Mo-Sa 10:00-18:00' } }, // ~0.0 km
      { type: 'node', id: 22, lat: 51.585, lon: -0.14, tags: { name: 'Five Km North', shop: 'music', opening_hours: 'Mo-Sa 10:00-18:00' } }, // ~5 km
      { type: 'node', id: 23, lat: 51.63, lon: -0.14, tags: { name: 'Ten Km North', shop: 'music', opening_hours: 'Mo-Sa 10:00-18:00' } }, // ~10 km
    ],
  })

test('a map area: radius snapped up to a standard size, named after the suburb and city', async () => {
  const calls = mockFetch({
    'nominatim.openstreetmap.org/reverse': reverse({ suburb: 'Chalk Farm', city: 'Greater London', state: 'England' }),
    'overpass-api.de': londonStores,
  })
  const area = await api.findStoresNear('51.54', '-0.14', '4.2')
  assert.equal(area.city.radiusKm, 5, '4.2 km becomes 5 km')
  assert.equal(area.city.area, 'Chalk Farm, Greater London')
  assert.equal(area.city.near, true)
  assert.deepEqual(area.stores.map((s) => s.name), ['Two Doors Down', 'Five Km North'], 'only shops within 5 km')
  const reverseCall = calls.find((c) => c.url.pathname === '/reverse')
  assert.deepEqual([reverseCall.url.searchParams.get('lat'), reverseCall.url.searchParams.get('lon')], ['51.54', '-0.14'])
})

test('map areas are capped at 25 km, and nonsense radii are refused', async () => {
  mockFetch({ 'nominatim.openstreetmap.org/reverse': reverse({ city: 'Berlin' }), 'overpass-api.de': () => json({ elements: [] }) })
  assert.equal((await api.findStoresNear('52.52', '13.41', '400')).city.radiusKm, 25)
  for (const radius of ['0', '-3', 'wide']) {
    await assert.rejects(api.findStoresNear('52.52', '13.41', radius), { status: 400 }, radius)
  }
})

test('area names: suburb and city, or just one, never a district board', async () => {
  for (const [address, name] of [
    [{ suburb: 'Downtown', city: 'Portland', county: 'Multnomah County' }, 'Downtown, Portland'],
    [{ neighbourhood: 'Manhattan Community Board 3', suburb: 'Manhattan', city: 'New York' }, 'Manhattan, New York'],
    [{ suburb: 'Mitte', borough: 'Mitte', city: 'Berlin' }, 'Mitte, Berlin'],
    [{ city: 'Leeds', state: 'England' }, 'Leeds'],
    [{ village: 'Hay-on-Wye', county: 'Powys' }, 'Hay-on-Wye, Powys'],
    [{ state: 'Nevada' }, 'Nevada'],
  ]) {
    mockFetch({ 'nominatim.openstreetmap.org/reverse': reverse(address), 'overpass-api.de': () => json({ elements: [] }) })
    const lat = (Math.random() * 40 + 10).toFixed(2) // a new spot each time, so nothing is cached
    assert.equal((await api.findStoresNear(lat, '1.00', '5')).city.area, name)
  }
})

test('if naming the area fails, the shops still come back', async () => {
  mockFetch({
    'nominatim.openstreetmap.org/reverse': () => new Response('busy', { status: 503 }),
    'overpass-api.de': londonStores,
  })
  const area = await api.findStoresNear('51.60', '-0.14', '10') // a spot not named by an earlier test
  assert.equal(area.city.area, null)
  assert.equal(area.city.name, 'this area')
  assert.equal(area.stores.length, 3)
})

test('map areas keep the center to ~100 m (it’s the map, not the visitor), "Near me" to ~1 km', async () => {
  mockFetch({ 'nominatim.openstreetmap.org/reverse': reverse({ suburb: 'Soho', city: 'London' }), 'overpass-api.de': () => json({ elements: [] }) })
  const area = await api.findStoresNear('51.51347', '-0.13512', '5')
  assert.deepEqual([area.city.lat, area.city.lon], [51.513, -0.135])
  const me = await api.findStoresNear('51.51347', '-0.13512')
  assert.deepEqual([me.city.lat, me.city.lon], [51.51, -0.14])
})

test('"Near me" (no radius) is unchanged: 15 km, not named', async () => {
  const calls = mockFetch({ 'overpass-api.de': londonStores })
  const near = await api.findStoresNear('51.55', '-0.14')
  assert.equal(near.city.radiusKm, 15)
  assert.equal(near.city.area, undefined)
  assert.ok(!calls.some((c) => c.url.host.includes('nominatim')), 'no reverse lookup for "Near me"')
})
