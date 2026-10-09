// Album covers, fetched from Cover Art Archive once and then served from disk. The
// archive often takes several seconds to answer; our copy answers at once.

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HttpError, USER_AGENT } from './util.js'
import { record } from './health.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const COVERS_DIR = join(DATA_DIR, 'covers')
const MISSING_TTL_MS = 24 * 60 * 60 * 1000 // a cover added to the archive shows up within a day
const MAX_BYTES = 2_000_000
const MAX_FILES = 5000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
const EXT_TYPES = Object.fromEntries(Object.entries(TYPES).map(([type, ext]) => [ext, type]))

const inflight = new Map()
let writesSincePrune = 0

/** What's on disk for this cover: { body, type }, { missing: true }, or null (unknown). */
async function fromDisk(id) {
  for (const [ext, type] of Object.entries(EXT_TYPES)) {
    try {
      return { body: await readFile(join(COVERS_DIR, `${id}.${ext}`)), type }
    } catch {
      // not this one
    }
  }
  try {
    const marker = await stat(join(COVERS_DIR, `${id}.missing`))
    if (Date.now() - marker.mtimeMs < MISSING_TTL_MS) return { missing: true }
  } catch {
    // never looked up
  }
  return null
}

async function save(name, body) {
  await mkdir(COVERS_DIR, { recursive: true })
  const tmp = join(COVERS_DIR, `${name}.tmp`)
  await writeFile(tmp, body)
  await rename(tmp, join(COVERS_DIR, name))
  if (++writesSincePrune >= 50) {
    writesSincePrune = 0
    pruneCovers().catch((err) => console.warn('[covers]', err.message))
  }
}

async function fromArchive(id) {
  const res = await fetch(`https://coverartarchive.org/release-group/${id}/front-250`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 404) return { missing: true }
  if (!res.ok) throw new HttpError(502, `Cover Art Archive returned ${res.status}`)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim()
  if (!TYPES[type]) throw new HttpError(502, `Unexpected cover type ${type || '(none)'}`)
  const body = Buffer.from(await res.arrayBuffer())
  if (body.length > MAX_BYTES) throw new HttpError(502, 'Cover too large')
  return { body, type }
}

/** The cover for a MusicBrainz release group: { body, type } or { missing: true }. */
export async function getCover(id) {
  if (!UUID.test(id)) throw new HttpError(400, 'Invalid album id')
  const saved = await fromDisk(id)
  if (saved) return saved
  if (inflight.has(id)) return inflight.get(id)
  const run = (async () => {
    const cover = await record('coverartarchive', () => fromArchive(id))
    if (cover.missing) await save(`${id}.missing`, '')
    else {
      await unlink(join(COVERS_DIR, `${id}.missing`)).catch(() => {})
      await save(`${id}.${TYPES[cover.type]}`, cover.body)
    }
    return cover
  })()
  inflight.set(id, run)
  const clear = () => inflight.delete(id)
  run.then(clear, clear)
  return run
}

/** Keep the newest covers, up to MAX_FILES. */
export async function pruneCovers(max = MAX_FILES) {
  let names
  try {
    names = (await readdir(COVERS_DIR)).filter((n) => !n.endsWith('.tmp'))
  } catch {
    return 0
  }
  if (names.length <= max) return 0
  const files = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(COVERS_DIR, n))).mtimeMs })))
  files.sort((a, b) => b.t - a.t)
  const old = files.slice(max)
  await Promise.all(old.map((f) => unlink(join(COVERS_DIR, f.n)).catch(() => {})))
  return old.length
}
