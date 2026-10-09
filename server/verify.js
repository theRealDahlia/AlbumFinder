// Cross-checks record shops found on OpenStreetMap against Discogs, to confirm they sell vinyl.
//
// Discogs can't search for sellers, so for each shop we guess likely usernames from its name
// and website, and accept a Discogs profile only if it backs up what OpenStreetMap says: it
// lists the shop's website, or it has the shop's name and is in the shop's city. A matching
// seller must also have vinyl for sale. Discogs allows only 25-60 requests a minute, so shops
// are checked one at a time in the background and the answers kept on disk; searches never wait.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { discogs } from './discogs.js'
import { isVinyl } from './stock.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const VERIFIED_FILE = join(DATA_DIR, 'discogs-verified.json')
const VERIFIED_FRESH_MS = 30 * 24 * 60 * 60 * 1000
// Shops that couldn't be matched are looked at again sooner: a shop may start selling on Discogs.
const UNVERIFIED_FRESH_MS = 14 * 24 * 60 * 60 * 1000
const FAILED_RETRY_MS = 10 * 60 * 1000
const MAX_RESULTS = 5000
const MAX_KNOWN = 20000
const MAX_QUEUE = 300
const MAX_IDS = 100
const MAX_CANDIDATES = 5

// Words that say what a shop is rather than which shop it is.
const GENERIC = new Set(['the', 'and', 'records', 'record', 'store', 'shop', 'music', 'vinyl', 'lps', 'cds', 'co', 'inc', 'ltd'])
// Second-level labels that come before a country code ("shop.co.uk").
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov'])

// ---------- guessing and matching ----------

const words = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
const coreWords = (s) => words(s).filter((w) => !GENERIC.has(w))

/** "https://www.roughtrade.com/shop" → "roughtrade.com". */
function hostOf(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The distinctive label of a host: "roughtrade.com" → "roughtrade", "shop.foo.co.uk" → "foo". */
function domainLabel(host) {
  const labels = host.split('.')
  if (labels.length < 2) return null
  const second = labels.at(-2)
  return SECOND_LEVEL.has(second) && labels.length > 2 ? labels.at(-3) : second
}

/** Discogs usernames a shop might use, most likely first. */
export function discogsCandidates({ name, website }) {
  const host = website && hostOf(website)
  const label = host && domainLabel(host)
  const all = words(name)
  const core = coreWords(name)
  const guesses = [label, all.join(''), core.join(''), all.join('_'), all.join('-'), core.join('_')]
  const unique = [...new Set(guesses.filter((g) => g && /^[\w-]{3,40}$/.test(g)))]
  return unique.slice(0, MAX_CANDIDATES)
}

/** Why a Discogs profile is this shop, or null if nothing on it backs that up. */
export function profileMatch(profile, store) {
  const shopHost = store.website && hostOf(store.website)
  const profileHost = profile.home_page && hostOf(profile.home_page)
  if (shopHost && profileHost && shopHost === profileHost) return 'website'

  const same = (a, b) => a.length > 0 && a.join('') === b.join('')
  const sameName = [profile.name, profile.username].some(
    (n) => same(words(n), words(store.name)) || same(coreWords(n), coreWords(store.name)),
  )
  const city = words(store.city).join(' ')
  const sameCity = city && ` ${words(profile.location).join(' ')} `.includes(` ${city} `)
  return sameName && sameCity ? 'name and city' : null
}

// ---------- checking one shop ----------

const isDiscogsRefusal = (err) => err.status === 404 || err.upstream === 403

/** Vinyl among a seller's newest 100 listings, and how many listings they have in all. */
async function vinylFor(seller) {
  const path = `/users/${encodeURIComponent(seller)}/inventory?status=For%20Sale&per_page=100&page=1&sort=listed&sort_order=desc`
  try {
    const data = await discogs(path)
    const listings = data.listings || []
    return { vinyl: listings.filter((l) => isVinyl(l.release?.format)).length, forSale: data.pagination?.items ?? listings.length }
  } catch (err) {
    if (isDiscogsRefusal(err)) return { vinyl: 0, forSale: 0 } // not a seller, or hidden
    throw err
  }
}

/**
 * Look for the shop's Discogs seller account and check that it has vinyl for sale.
 * Resolves to { status: 'verified', seller, basis } or { status: 'unverified' }; throws when
 * Discogs itself is failing, since that says nothing about the shop.
 */
export async function verifyStore(store) {
  for (const candidate of discogsCandidates(store)) {
    let profile
    try {
      profile = await discogs(`/users/${encodeURIComponent(candidate)}`)
    } catch (err) {
      if (isDiscogsRefusal(err)) continue
      throw err
    }
    const basis = profileMatch(profile, store)
    if (!basis || !(profile.num_for_sale > 0)) continue
    const { vinyl } = await vinylFor(profile.username)
    if (vinyl > 0) return { status: 'verified', seller: profile.username, basis }
  }
  return { status: 'unverified' }
}

// ---------- results kept on disk ----------

let results = null // storeId -> { name, status, checkedAt, seller?, basis? }
async function loadResults() {
  if (!results) {
    try {
      results = JSON.parse(await readFile(VERIFIED_FILE, 'utf8'))
    } catch {
      results = {}
    }
  }
  return results
}

let writeChain = Promise.resolve()
function saveResults() {
  const newest = Object.entries(results)
    .sort(([, a], [, b]) => b.checkedAt - a.checkedAt)
    .slice(0, MAX_RESULTS)
  results = Object.fromEntries(newest)
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(VERIFIED_FILE), { recursive: true })
      const tmp = `${VERIFIED_FILE}.tmp`
      await writeFile(tmp, JSON.stringify(results))
      await rename(tmp, VERIFIED_FILE)
    })
    .catch((err) => console.warn('[discogs-verified]', err.message))
  return writeChain
}

/** A saved answer that's still good: recent, and for a shop with the same name. */
function freshResult(store) {
  const saved = results[store.id]
  if (!saved || saved.name !== store.name) return null
  const ttl = saved.status === 'verified' ? VERIFIED_FRESH_MS : UNVERIFIED_FRESH_MS
  return Date.now() - saved.checkedAt < ttl ? saved : null
}

/** Shops confirmed as vinyl sellers, as { storeId: Discogs username }. */
export async function verifiedSellers() {
  await loadResults()
  const confirmed = Object.entries(results).filter(
    ([, r]) => r.status === 'verified' && Date.now() - r.checkedAt < VERIFIED_FRESH_MS,
  )
  return Object.fromEntries(confirmed.map(([storeId, r]) => [storeId, r.seller]))
}

// ---------- the background queue ----------

// Shops the server has returned in searches. Only these can be checked, so a visitor can't
// make us look up arbitrary names on Discogs.
const known = new Map()
const queue = []
const waiting = new Set()
const failedAt = new Map()
let current = null
let working = false

/** Remember the shops a search returned (id, name, website, city), ready to be checked. */
export function rememberStores(stores) {
  for (const { id, name, website, city } of stores) {
    known.delete(id) // re-insert so iteration order is oldest first
    known.set(id, { id, name, website: website ?? null, city: city ?? null })
  }
  while (known.size > MAX_KNOWN) known.delete(known.keys().next().value)
}

async function work() {
  if (working) return
  working = true
  try {
    while (queue.length) {
      const store = queue.shift()
      current = store.id
      waiting.delete(store.id)
      try {
        const outcome = await verifyStore(store)
        results[store.id] = { name: store.name, ...outcome, checkedAt: Date.now() }
        await saveResults()
      } catch (err) {
        failedAt.set(store.id, Date.now())
        console.warn(`[discogs-verify] ${store.name}: ${err.message}`)
      }
      current = null
    }
  } finally {
    current = null
    working = false
  }
}

const inFlight = (id) => waiting.has(id) || current === id
const recentlyFailed = (id) => Date.now() - (failedAt.get(id) ?? -Infinity) < FAILED_RETRY_MS

/**
 * What's known about these shops, and queues the rest to be checked.
 * `verified` maps a store id to its Discogs seller and page; `pending` counts shops still
 * being checked, so the page knows to ask again.
 */
export async function verificationFor(ids) {
  await loadResults()
  const verified = {}
  let pending = 0
  for (const id of ids.slice(0, MAX_IDS)) {
    const store = known.get(id)
    if (!store) continue
    const saved = freshResult(store)
    if (saved) {
      if (saved.status === 'verified') {
        verified[id] = { seller: saved.seller, url: `https://www.discogs.com/seller/${encodeURIComponent(saved.seller)}/profile` }
      }
    } else if (inFlight(id)) {
      pending++
    } else if (!recentlyFailed(id) && queue.length < MAX_QUEUE) {
      queue.push(store)
      waiting.add(id)
      pending++
    }
  }
  if (queue.length) work()
  return { verified, pending }
}
