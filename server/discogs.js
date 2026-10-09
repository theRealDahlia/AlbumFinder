// Stock from shops that sell on Discogs. A shop is linked to its Discogs seller account
// by hand (`npm run discogs -- link …`), since nothing ties an OpenStreetMap shop to a
// Discogs account automatically. Linked inventories are synced daily and searched locally:
// Discogs' API can list a seller's inventory but can't search it.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HttpError, USER_AGENT } from './util.js'
import { pace } from './shared.js'
import { record } from './health.js'
import { isVinyl, listingMatches } from './stock.js'

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
const LINKS_FILE = join(DATA_DIR, 'discogs-links.json')
const INVENTORY_DIR = join(DATA_DIR, 'discogs')
const SYNC_EVERY_MS = 24 * 60 * 60 * 1000
const MAX_PAGES = 100 // 10,000 listings per shop
const SELLER = /^[\w.-]{1,64}$/

const token = () => process.env.DISCOGS_TOKEN || ''
// Discogs allows 25 requests a minute without a token and 60 with one.
const interval = () => (token() ? 1100 : 2500)

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, file)
}

// ---------- links between shops and Discogs sellers ----------

export const readLinks = () => readJson(LINKS_FILE, {})

export async function linkSeller(storeId, seller) {
  if (!/^(node|way|relation)\/\d+$/.test(storeId)) throw new Error(`"${storeId}" isn't an OpenStreetMap shop id like node/123`)
  if (!SELLER.test(seller)) throw new Error(`"${seller}" isn't a Discogs username`)
  const profile = await discogs(`/users/${encodeURIComponent(seller)}`)
  const links = await readLinks()
  links[storeId] = { seller: profile.username, linkedAt: new Date().toISOString() }
  await writeJson(LINKS_FILE, links)
  return { seller: profile.username, forSale: profile.num_for_sale ?? null }
}

export async function unlinkSeller(storeId) {
  const links = await readLinks()
  const existed = storeId in links
  delete links[storeId]
  await writeJson(LINKS_FILE, links)
  return existed
}

// ---------- syncing inventories ----------

/** One Discogs API call, paced to its rate limit. A refusal carries Discogs' own status as `upstream`. */
export async function discogs(path) {
  await pace('discogs', interval())
  return record('discogs', async () => {
    const res = await fetch(`https://api.discogs.com${path}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(token() && { Authorization: `Discogs token=${token()}` }),
      },
      signal: AbortSignal.timeout(20000),
    })
    if (res.status === 404) throw new HttpError(404, 'No such Discogs seller')
    if (!res.ok) throw Object.assign(new HttpError(502, `Discogs returned ${res.status}`), { upstream: res.status })
    return res.json()
  })
}

/** Discogs disambiguates artist names ("Prince (2)", "Pee Wee*"); drop those marks. */
const cleanArtist = (name) => String(name || '').replace(/\*/g, '').replace(/\s*\(\d+\)/g, '').trim()

function toItem(listing) {
  const r = listing.release || {}
  return {
    title: r.title,
    artist: cleanArtist(r.artist),
    format: r.format || '',
    condition: listing.condition || null,
    price: listing.price?.value ?? null,
    currency: listing.price?.currency ?? null,
    url: listing.uri || null,
  }
}

const inventoryFile = (seller) => join(INVENTORY_DIR, `${seller.toLowerCase()}.json`)
const inventories = new Map() // seller -> saved inventory, read once

async function loadInventory(seller) {
  if (!inventories.has(seller)) inventories.set(seller, await readJson(inventoryFile(seller), null))
  return inventories.get(seller)
}

/** Fetch a seller's whole for-sale inventory (vinyl only) and save it. */
export async function syncSeller(seller, { log = () => {} } = {}) {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await discogs(
      `/users/${encodeURIComponent(seller)}/inventory?status=For%20Sale&per_page=100&page=${page}&sort=listed&sort_order=desc`,
    )
    for (const listing of data.listings || []) {
      const item = toItem(listing)
      if (item.title && isVinyl(item.format)) items.push(item)
    }
    const pages = data.pagination?.pages ?? 1
    log(`  ${seller}: page ${page} of ${pages}`)
    if (page >= pages) break
  }
  const inventory = { seller, syncedAt: new Date().toISOString(), items }
  await writeJson(inventoryFile(seller), inventory)
  inventories.set(seller, inventory)
  return inventory
}

/** Sync every linked seller whose inventory is more than a day old (or `force`). */
export async function syncAll({ force = false, log = () => {} } = {}) {
  const sellers = [...new Set(Object.values(await readLinks()).map((l) => l.seller))]
  const results = []
  for (const seller of sellers) {
    const saved = await loadInventory(seller)
    if (!force && saved && Date.now() - Date.parse(saved.syncedAt) < SYNC_EVERY_MS) {
      results.push({ seller, status: 'fresh', items: saved.items.length })
      continue
    }
    try {
      const { items } = await syncSeller(seller, { log })
      results.push({ seller, status: 'synced', items: items.length })
    } catch (err) {
      results.push({ seller, status: 'failed', error: err.message })
    }
  }
  return results
}

// ---------- searching ----------

/** Matching vinyl listings at linked shops: { [storeId]: items }. */
export async function discogsStock(query, { perStore = 5 } = {}) {
  const stock = {}
  for (const [storeId, { seller }] of Object.entries(await readLinks())) {
    const inventory = await loadInventory(seller)
    if (!inventory) continue
    const matches = inventory.items.filter((item) => listingMatches(item, query)).slice(0, perStore)
    if (matches.length) stock[storeId] = matches.map((item) => ({ source: 'discogs', ...item }))
  }
  return stock
}
