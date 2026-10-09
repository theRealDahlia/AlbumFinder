// The HTTP API, used by both the Vite dev server (as middleware) and server/index.js.
//
//   GET /api/albums?album=&artist=      albums (MusicBrainz)
//   GET /api/stores?city=&state=        record stores in a city (OpenStreetMap)
//   GET /api/stores?lat=&lon=[&radius=]  record stores near a location (with a radius: a map area)
//   GET /api/suggest?field=&q=&artist=  search-as-you-type suggestions
//   GET /api/cover/<release-group id>  album cover image (cached copy of Cover Art Archive's)
//   GET /api/stock?album=&artist=       what shops linked to Discogs have in stock
//   GET /api/verification?ids=a,b       which shops are confirmed as vinyl sellers on Discogs
//   GET /api/health                     monitoring

import { HttpError } from './util.js'
import { backend, clientAddress, overLimit } from './shared.js'
import { searchAlbums, suggest } from './musicbrainz.js'
import { findStores, findStoresNear, suggestCities } from './stores.js'
import { countRequest, healthReport } from './health.js'
import { getCover } from './covers.js'
import { discogsStock } from './discogs.js'
import { rememberStores, verificationFor } from './verify.js'

export { searchAlbums, suggest } from './musicbrainz.js'
export { findStores, findStoresNear, placeQuery, prefetchCities, suggestCities } from './stores.js'

// Requests each visitor may make per minute. Searches are the expensive ones: they're
// what reaches MusicBrainz (one request a second for the whole site) and OpenStreetMap.
const LIMITS = {
  search: 30,
  suggest: 120,
  cover: 600,
  other: 300,
}

function sendCover(res, cover) {
  if (cover.missing) {
    res.statusCode = 404
    res.setHeader('Cache-Control', 'public, max-age=86400') // the page shows a placeholder record
    res.end()
  } else {
    res.statusCode = 200
    res.setHeader('Content-Type', cover.type)
    res.setHeader('Content-Length', String(cover.body.length))
    res.setHeader('Cache-Control', 'public, max-age=2592000')
    res.end(cover.body)
  }
  countRequest(res.statusCode)
}

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
  countRequest(status)
}

async function checkLimit(req, res, bucket) {
  const wait = await overLimit(`${bucket}:${clientAddress(req)}`, LIMITS[bucket], 60_000)
  if (!wait) return
  res.setHeader('Retry-After', String(wait))
  throw new HttpError(429, `Too many requests. Please wait ${wait} seconds and try again.`)
}

/** What shops linked to Discogs have in stock that matches a search. */
async function stock(p) {
  const query = { album: (p.get('album') || '').trim(), artist: (p.get('artist') || '').trim() }
  if (!query.album && !query.artist) throw new HttpError(400, 'Enter an album or an artist')
  return { stock: await discogsStock(query) }
}

const ROUTES = {
  'GET /api/albums': {
    bucket: 'search',
    // `q` is the original parameter name for the album; still accepted.
    handle: async (p) => ({ albums: await searchAlbums({ album: p.get('album') ?? p.get('q') ?? '', artist: p.get('artist') ?? '' }) }),
  },
  'GET /api/stores': {
    bucket: 'search',
    handle: async (p) => {
      const found = await (p.has('lat')
        ? findStoresNear(p.get('lat'), p.get('lon'), p.get('radius'))
        : findStores(p.get('city') || '', p.get('state') || ''))
      rememberStores(found.stores) // so they can be checked on Discogs afterwards
      return found
    },
  },
  'GET /api/suggest': {
    bucket: 'suggest',
    handle: async (p) => ({
      suggestions:
        p.get('field') === 'city'
          ? await suggestCities(p.get('q'))
          : await suggest(p.get('field'), p.get('q'), { artist: p.get('artist') ?? '' }),
    }),
  },
  'GET /api/stock': { bucket: 'other', handle: stock },
  'GET /api/verification': { bucket: 'other', handle: (p) => verificationFor((p.get('ids') || '').split(',').filter(Boolean)) },
  'GET /api/health': {
    bucket: 'other',
    handle: async () => {
      const store = await backend()
      return healthReport({ cache: { backend: store.kind, keys: await store.size() } })
    },
  },
}

/** Connect-style middleware: handles /api/* and passes everything else on. */
export async function apiMiddleware(req, res, next) {
  if (!req.url.startsWith('/api/')) return next()
  try {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname.startsWith('/api/cover/')) {
      await checkLimit(req, res, 'cover')
      return sendCover(res, await getCover(url.pathname.slice('/api/cover/'.length)))
    }
    const route = ROUTES[`${req.method} ${url.pathname}`]
    if (!route) throw new HttpError(404, 'Not found')
    await checkLimit(req, res, route.bucket)
    res.setHeader('Cache-Control', 'no-store') // answers depend on the request
    return send(res, 200, await route.handle(url.searchParams))
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 500)
    if (status >= 500) console.error('[api]', err)
    send(res, status, { error: status === 504 ? 'A data source timed out, try again' : err.message })
  }
}
