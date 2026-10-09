// Production server: serves the built site from dist/ plus the /api routes.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware } from './api.js'
import { refreshAgingCities } from './stores.js'
import { syncAll } from './discogs.js'
import { verifiedSellers } from './verify.js'

const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const PORT = Number(process.env.PORT) || 3000
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Allow', 'GET, HEAD')
    return res.end('Method not allowed')
  }
  let path
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    res.statusCode = 400
    return res.end('Bad request')
  }
  const file = resolve(DIST, `.${normalize(`/${path}`)}`)
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.statusCode = 404
    return res.end('Not found')
  }
  // Extensionless paths are client-side routes: serve the app shell.
  const target = extname(file) ? file : join(DIST, 'index.html')
  try {
    const body = await readFile(target)
    res.setHeader('Content-Type', TYPES[extname(target)] || 'application/octet-stream')
    // Vite fingerprints everything in assets/ (index-56GFbTOw.js), so those never change;
    // everything else (the page, favicon) is revalidated so new deploys show up.
    const fingerprinted = target.startsWith(join(DIST, 'assets') + sep)
    res.setHeader('Cache-Control', fingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('Not found')
  }
}

if (!process.env.CONTACT) {
  console.warn('Set CONTACT to a website or email address: MusicBrainz and OpenStreetMap ask for one and may throttle apps without it.')
}

const HOUR = 60 * 60 * 1000

/** One JSON line per request, for log services. Paths only: search terms stay out of logs. */
function logRequest(req, res, started) {
  const path = (req.url || '').split('?')[0]
  console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path, status: res.statusCode, ms: Date.now() - started }))
}

createServer((req, res) => {
  const started = Date.now()
  res.on('finish', () => logRequest(req, res, started))
  apiMiddleware(req, res, () => serveStatic(req, res)).catch((err) => {
    console.error('[server]', err)
    if (!res.headersSent) res.statusCode = 500
    res.end()
  })
}).listen(PORT, () => {
  console.log(`Stacks running at http://localhost:${PORT}`)
})

// Background upkeep: re-check store lists that are about to go stale, a few at a time,
// so searches keep hitting fresh lists without anyone waiting for a lookup.
setInterval(() => refreshAgingCities().catch((err) => console.warn('[refresh]', err.message)), 6 * HOUR).unref()

// Discogs inventories of verified and linked shops: shortly after starting, then daily (each sync
// skips shops synced in the last day, so restarts don't re-download everything).
const syncDiscogs = () =>
  verifiedSellers()
    .then((verified) => syncAll({ verified }))
    .then((results) => results.filter((r) => r.status !== 'fresh').forEach((r) => console.log('[discogs]', JSON.stringify(r))))
    .catch((err) => console.warn('[discogs]', err.message))
setTimeout(syncDiscogs, 60 * 1000).unref()
setInterval(syncDiscogs, 24 * HOUR).unref()
