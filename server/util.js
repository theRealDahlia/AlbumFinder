// Small helpers shared by the server modules.

// MusicBrainz and Nominatim ask for "App/version ( contact )" and may throttle apps without
// a contact. Set CONTACT to a website or email address when running this for real.
export const USER_AGENT = `AlbumFinder/0.1 ( ${process.env.CONTACT || 'vinyl record store finder'} )`

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Trim, collapse whitespace and cap length: user input goes into upstream URLs. */
export const cleanInput = (s, max) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

export async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
    signal: AbortSignal.any([AbortSignal.timeout(init.timeoutMs ?? 15000), init.signal].filter(Boolean)),
  })
  if (!res.ok) throw new HttpError(502, `Upstream ${new URL(url).host} returned ${res.status}`)
  const type = res.headers.get('content-type') || ''
  if (!type.includes('json')) throw new HttpError(502, `Upstream ${new URL(url).host} is busy`)
  return res.json()
}

export const tokenize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

// Words that are spelled differently from credit to credit ("Simon and Garfunkel" vs
// "Simon & Garfunkel", "Guns N' Roses", "Beatles" vs "The Beatles"), so they don't count.
const CONNECTORS = new Set(['and', 'n', 'the', 'with', 'feat', 'featuring'])
export const nameWords = (tokens) => tokens.filter((t) => !CONNECTORS.has(t))

/** How well an artist credit matches the artist wanted: 1 exact, 0.6 contains it, 0 not. */
export function artistMatch(creditTokens, wantedTokens) {
  const credit = nameWords(creditTokens)
  const wanted = nameWords(wantedTokens)
  if (!wanted.length) return 0
  if (!wanted.every((t) => credit.includes(t))) return 0
  return credit.length === wanted.length ? 1 : 0.6
}

/** Edit distance between two words: how many single-letter changes turn one into the other. */
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]
}

/**
 * Whether two words are the same allowing for a typo: one wrong, missing or extra letter, or two in
 * long words. Words under four letters must match exactly, since one letter changes them completely.
 */
export function similarWord(a, b) {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 4) return false
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1)
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2
  return Math.round(12742 * Math.asin(Math.sqrt(a)) * 10) / 10
}
