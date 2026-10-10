// Record stores, from OpenStreetMap: Nominatim to find the city, Overpass for the shops.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import tzLookup from '@photostructure/tz-lookup'
import { HttpError, cleanInput, fetchJson, haversineKm, sleep } from './util.js'
import { cached, pace } from './shared.js'
import { record } from './health.js'

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
// Resolved from the working directory (npm scripts run from the project root), not
// import.meta.url, because Vite bundles this file into node_modules/.vite-temp in dev.
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const STORES_CACHE_FILE = join(DATA_DIR, 'stores-cache.json')
const STORES_FRESH_MS = 7 * 24 * 60 * 60 * 1000
// Older entries are only a fallback for outages; past this they're dropped, and the file
// is capped so it can't grow forever.
const STORES_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const STORES_MAX_CITIES = 500
const NEAR_RADIUS_KM = 15
const NEAR_TTL_MS = 24 * 60 * 60 * 1000
// Map areas are searched at one of these radii (the smallest that covers the request), so
// nearby searches share cached results; 25 km keeps Overpass queries manageable.
const AREA_RADII_KM = [2, 5, 10, 15, 25]
const AREA_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000

// ---------- finding the place ----------

function timezoneAt(lat, lon) {
  try {
    return tzLookup(lat, lon)
  } catch {
    return null
  }
}

async function geocodeCity(city) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&q=${encodeURIComponent(city)}`
  await pace('nominatim', 1100)
  const results = await record('nominatim', () => fetchJson(url))
  const place =
    results.find((r) => ['city', 'town', 'village', 'municipality', 'suburb', 'borough'].includes(r.addresstype)) ||
    results[0]
  if (!place) throw new HttpError(404, `Couldn't find a city called "${city}"`)
  let [south, north, west, east] = place.boundingbox.map(Number)
  // Keep the search area sensible: clamp huge regions to ~60 km around the centre,
  // and widen tiny ones (a point result) to ~10 km.
  const lat = Number(place.lat)
  const lon = Number(place.lon)
  const clampLat = 0.55
  const clampLon = 0.55 / Math.cos((lat * Math.PI) / 180)
  const minLat = 0.09
  const minLon = 0.09 / Math.cos((lat * Math.PI) / 180)
  south = Math.max(south, lat - clampLat)
  north = Math.min(north, lat + clampLat)
  west = Math.max(west, lon - clampLon)
  east = Math.min(east, lon + clampLon)
  if (north - south < 2 * minLat) [south, north] = [lat - minLat, lat + minLat]
  if (east - west < 2 * minLon) [west, east] = [lon - minLon, lon + minLon]
  return { name: place.display_name, lat, lon, bbox: [south, west, north, east] }
}

// Geocoders handle full state names more reliably than abbreviations ("Portland, ME").
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
}

const US_STATE_CODES = Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [name, code]))

/** "Portland" + "or" → "Portland, Oregon"; a state is optional (most countries don't need one). */
export function placeQuery(city, state) {
  const c = cleanInput(city, 120)
  const s = cleanInput(state, 60).replace(/\.$/, '')
  const fullState = US_STATES[s.toUpperCase()] || s
  return fullState ? `${c}, ${fullState}` : c
}

// ---------- finding the shops ----------

// Public Overpass servers are often overloaded. Start with whichever answered last,
// bring in another mirror every few seconds, and take the first good answer.
let preferredMirror = 0

async function overpass(query) {
  const started = Date.now()
  try {
    return await overpassRound(query)
  } catch (err) {
    // Mirrors often fail fast with 500/504 when briefly overloaded; one retry usually helps.
    if (Date.now() - started > 15000) throw err
    await sleep(2000)
    return overpassRound(query)
  }
}

async function overpassRound(query) {
  const order = OVERPASS_MIRRORS.map((_, i) => (preferredMirror + i) % OVERPASS_MIRRORS.length)
  const controllers = order.map(() => new AbortController())
  const attempts = order.map(async (mirrorIndex, n) => {
    const mirror = OVERPASS_MIRRORS[mirrorIndex]
    const signal = controllers[n].signal
    if (n) await sleep(n * 3000)
    if (signal.aborted) throw new Error('cancelled')
    try {
      const data = await fetchJson(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        timeoutMs: 30000,
        signal,
      })
      // A query that runs out of time still comes back as 200, with the error in `remark`.
      if (data.remark && /error|timed out/i.test(data.remark)) throw new Error(data.remark)
      preferredMirror = mirrorIndex
      return data.elements || []
    } catch (err) {
      if (!signal.aborted) console.warn(`[overpass] ${mirror}: ${err.message}`)
      throw err
    }
  })
  try {
    return await record('overpass', () => Promise.any(attempts))
  } catch {
    throw new HttpError(502, 'The store directory is busy right now, try again in a minute')
  } finally {
    controllers.forEach((c) => c.abort())
  }
}

// shop=music is sometimes used for instrument shops; skip the obvious ones.
const INSTRUMENT_SHOP = /guitar|piano|drum|violin|instrument|music (company|center|centre)|band ?&? ?orchestra/i

function formatAddress(tags) {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
  const line = [street, tags['addr:city']].filter(Boolean).join(', ')
  return line || tags['addr:full'] || null
}

function normaliseUrl(url) {
  if (!url) return null
  const u = url.split(';')[0].trim()
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

/** Record shops inside `bbox` ([south, west, north, east]), with distances from `center`. */
async function storesInBox(bbox, center) {
  const box = bbox.map((n) => n.toFixed(5)).join(',')
  // Record shops are mostly tagged shop=music; some mappers use shop=records,
  // and some second-hand/media shops are explicitly tagged as selling vinyl.
  // Only shops that list their opening hours: a shop without them can't be told from a closed or
  // long-gone one. Exact values and rare keys first let Overpass use its tag index instead of scanning every shop.
  const query = `[out:json][timeout:25];
(
  nwr["shop"="music"]["opening_hours"](${box});
  nwr["shop"="records"]["opening_hours"](${box});
  nwr["vinyl"~"^(yes|only)$"]["shop"]["opening_hours"](${box});
  nwr["sales:vinyl"~"^(yes|only)$"]["shop"]["opening_hours"](${box});
);
out center tags;`
  const elements = await overpass(query)
  return elements
    .filter((e) => e.tags?.name && e.tags.opening_hours?.trim() && !INSTRUMENT_SHOP.test(e.tags.name))
    .map((e) => {
      const t = e.tags
      const lat = e.lat ?? e.center?.lat
      const lon = e.lon ?? e.center?.lon
      return {
        id: `${e.type}/${e.id}`,
        name: t.name,
        lat,
        lon,
        address: formatAddress(t),
        city: t['addr:city'] || null,
        phone: t.phone || t['contact:phone'] || null,
        website: normaliseUrl(t.website || t['contact:website']),
        hours: t.opening_hours.trim(),
        distanceKm: haversineKm(center.lat, center.lon, lat, lon),
      }
    })
    .filter((s) => s.lat != null && s.lon != null)
}

// ---------- by city, with a disk cache ----------

// Store lists change slowly, so keep them on disk: fresh for a week, and served
// stale if the store directory is down.
let storesDisk = null
async function loadStoresDisk() {
  if (!storesDisk) {
    try {
      storesDisk = JSON.parse(await readFile(STORES_CACHE_FILE, 'utf8'))
    } catch {
      storesDisk = {}
    }
  }
  return storesDisk
}

function pruneStoresDisk() {
  const cutoff = Date.now() - STORES_KEEP_MS
  const keep = Object.entries(storesDisk)
    .filter(([, entry]) => entry.savedAt > cutoff)
    .sort(([, x], [, y]) => y.savedAt - x.savedAt)
    .slice(0, STORES_MAX_CITIES)
  storesDisk = Object.fromEntries(keep)
}

let storesWriteChain = Promise.resolve()
function saveStoresDisk() {
  pruneStoresDisk()
  storesWriteChain = storesWriteChain
    .then(() => writeJsonAtomic(STORES_CACHE_FILE, storesDisk))
    .catch((err) => console.warn('[stores-cache]', err.message))
  return storesWriteChain
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, file)
}

/**
 * Lists saved before timezones were added get one on the way out, and lists saved before shops
 * needed opening hours lose the ones without.
 */
function fromDisk(value) {
  const stores = value.stores.filter((s) => s.hours)
  const timezone = value.city.timezone !== undefined ? value.city.timezone : timezoneAt(value.city.lat, value.city.lon)
  return { ...value, city: { ...value.city, timezone }, stores }
}

/** Every saved store list ({ city, stores }), current or stale, for work that gets ready ahead of searches. */
export async function cachedStoreLists() {
  return Object.values(await loadStoresDisk()).map((entry) => fromDisk(entry.value))
}

export async function findStores(city, state = '') {
  if (!cleanInput(city, 120)) throw new HttpError(400, 'Enter a city')
  const c = placeQuery(city, state)
  const key = c.toLowerCase()
  const saved = (await loadStoresDisk())[key]
  if (saved && Date.now() - saved.savedAt < STORES_FRESH_MS) return fromDisk(saved.value)
  try {
    return await refreshCity(c)
  } catch (err) {
    if (saved && err.status === 502) return fromDisk(saved.value)
    throw err
  }
}

/** Look a city's stores up again and save them. */
async function refreshCity(c) {
  const value = await cached(`stores:${c.toLowerCase()}`, async () => {
    const place = await geocodeCity(c)
    const stores = await storesInBox(place.bbox, place)
    return { city: { name: place.name, lat: place.lat, lon: place.lon, timezone: timezoneAt(place.lat, place.lon) }, stores }
  })
  storesDisk[c.toLowerCase()] = { value, savedAt: Date.now() }
  saveStoresDisk()
  return value
}

// ---------- near a location, or around the map's center ----------

/** "Chalk Farm, Greater London" for a point, from Nominatim's reverse lookup; null if unknown. */
async function areaName(center) {
  return cached(
    `area-name:${center.lat},${center.lon}`,
    async () => {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${center.lat}&lon=${center.lon}`
      await pace('nominatim', 1100)
      const { address = {} } = await record('nominatim', () => fetchJson(url))
      // Suburb-level names read well; the finer "neighbourhood" can be an admin unit
      // ("Manhattan Community Board 3").
      const local = address.suburb || address.quarter || address.borough || address.town || address.village
      const wider = address.city || address.town || address.county || address.state
      if (local && wider && local !== wider) return `${local}, ${wider}`
      return local || wider || null
    },
    AREA_NAME_TTL_MS,
  )
}

/**
 * Stores near a point. Without a radius it's "Near me": 15 km. With one, it's the area
 * shown on the map: the radius is snapped up to a standard size (25 km at most), and the
 * area is named ("Chalk Farm, Greater London") for the heading.
 *
 * "Near me" points are the visitor's own location, so they're rounded to about a kilometre:
 * plenty for finding shops, and not kept more precisely than that. A map center isn't
 * private, and rounding it that far moved Soho's center to Millbank, so it keeps ~100 m.
 */
export async function findStoresNear(lat, lon, radius) {
  // Number('') is 0, which would quietly search the Gulf of Guinea; insist on real numbers.
  const toNumber = (v) => (String(v ?? '').trim() === '' ? NaN : Number(v))
  const la = toNumber(lat)
  const lo = toNumber(lon)
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 85 || Math.abs(lo) > 180) {
    throw new HttpError(400, 'Invalid location')
  }
  const isArea = radius != null && radius !== ''
  let radiusKm = NEAR_RADIUS_KM
  if (isArea) {
    const wanted = toNumber(radius)
    if (!Number.isFinite(wanted) || wanted <= 0) throw new HttpError(400, 'Invalid radius')
    radiusKm = AREA_RADII_KM.find((r) => r >= wanted) ?? AREA_RADII_KM.at(-1)
  }
  const precision = isArea ? 1000 : 100
  const center = { lat: Math.round(la * precision) / precision, lon: Math.round(lo * precision) / precision }
  return cached(
    `near:${center.lat},${center.lon}:${radiusKm}:${isArea ? 'area' : 'me'}`,
    async () => {
      const dLat = radiusKm / 111
      const dLon = dLat / Math.cos((center.lat * Math.PI) / 180)
      const bbox = [center.lat - dLat, center.lon - dLon, center.lat + dLat, center.lon + dLon]
      const [stores, area] = await Promise.all([
        storesInBox(bbox, center),
        isArea ? areaName(center).catch(() => null) : undefined, // a name is nice to have, not essential
      ])
      return {
        city: {
          name: isArea ? area || 'this area' : 'your location',
          ...center,
          timezone: timezoneAt(center.lat, center.lon),
          near: true,
          radiusKm,
          ...(isArea && { area }),
        },
        stores: stores.filter((s) => s.distanceKm <= radiusKm),
      }
    },
    NEAR_TTL_MS,
  )
}

// ---------- city suggestions as you type ----------

/**
 * Cities for the City field, from Photon (komoot's OpenStreetMap search, which is built
 * for search-as-you-type; Nominatim's rules forbid that use). Gives up quietly when busy.
 * Each has `value` to show ("Portland, Oregon") and the `city` and `state` to fill the
 * form's two boxes with when picked; US states are abbreviated ("OR").
 */
export async function suggestCities(text) {
  const q = cleanInput(text, 100)
  if (q.length < 3) return []
  try {
    return await cached(
      `suggest:city:v2:${q.toLowerCase()}`, // v2: also has city and state apart
      async () => {
        if (!(await pace('photon', 250, { maxWaitMs: 1000 }))) throw new Error('busy')
        const url = `https://photon.komoot.io/api/?limit=8&layer=city&layer=locality&q=${encodeURIComponent(q)}`
        const data = await record('photon', () => fetchJson(url, { timeoutMs: 5000 }))
        const seen = new Set()
        const out = []
        for (const f of data.features || []) {
          const { name, state, country, countrycode } = f.properties || {}
          if (!name) continue
          const value = [name, state].filter(Boolean).join(', ')
          if (seen.has(value.toLowerCase())) continue
          seen.add(value.toLowerCase())
          const stateBox = (countrycode === 'US' && US_STATE_CODES[state]) || state || ''
          out.push({ value, detail: country || '', city: name, state: stateBox })
        }
        return out.slice(0, 6)
      },
      7 * 24 * 60 * 60 * 1000,
    )
  } catch {
    return []
  }
}

// ---------- keeping popular cities warm ----------

export const POPULAR_CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Portland, OR', 'Seattle', 'San Francisco', 'Austin', 'Nashville',
  'Brooklyn', 'Philadelphia', 'Boston', 'Denver', 'Minneapolis', 'Detroit', 'Toronto', 'Montreal',
  'London', 'Manchester', 'Glasgow', 'Dublin', 'Paris', 'Berlin', 'Hamburg', 'Amsterdam', 'Copenhagen',
  'Stockholm', 'Barcelona', 'Madrid', 'Tokyo', 'Osaka', 'Melbourne', 'Sydney', 'Mexico City',
]

/**
 * Look up store lists ahead of time so first searches are instant. Cities that are
 * still fresh are skipped; lookups run one at a time to go easy on the public servers.
 */
export async function prefetchCities(cities = POPULAR_CITIES, { log = () => {} } = {}) {
  const results = []
  for (const city of cities) {
    const [name, state = ''] = city.split(/,\s*/)
    const key = placeQuery(name, state).toLowerCase()
    const saved = (await loadStoresDisk())[key]
    if (saved && Date.now() - saved.savedAt < STORES_FRESH_MS) {
      results.push({ city, status: 'fresh' })
      continue
    }
    try {
      const { stores } = await refreshCity(placeQuery(name, state))
      results.push({ city, status: 'updated', stores: stores.length })
    } catch (err) {
      results.push({ city, status: 'failed', error: err.message })
    }
    log(results.at(-1))
  }
  return results
}

/** Re-check saved cities that will go stale within a day, a few at a time. */
export async function refreshAgingCities({ max = 5 } = {}) {
  const soon = Date.now() - (STORES_FRESH_MS - 24 * 60 * 60 * 1000)
  const aging = Object.entries(await loadStoresDisk())
    .filter(([, entry]) => entry.savedAt < soon)
    .sort(([, x], [, y]) => x.savedAt - y.savedAt)
    .slice(0, max)
  for (const [key] of aging) {
    try {
      await refreshCity(key)
    } catch (err) {
      console.warn(`[refresh] ${key}: ${err.message}`)
    }
  }
  return aging.length
}
