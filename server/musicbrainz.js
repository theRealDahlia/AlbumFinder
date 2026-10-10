// Albums and artists, from MusicBrainz.

import { HttpError, artistMatch, cleanInput, fetchJson, nameWords, similarWord, sleep, tokenize } from './util.js'
import { cached, pace } from './shared.js'
import { record } from './health.js'

const INTERVAL_MS = 1100 // MusicBrainz allows about one request per second per app
const SUGGEST_TTL_MS = 24 * 60 * 60 * 1000

export const coverUrl = (releaseGroupId) => `/api/cover/${releaseGroupId}`

/**
 * Make typed text safe to put inside a MusicBrainz (Lucene) query: escape special
 * characters, and lowercase AND/OR/NOT, which in capitals are search commands
 * ("NOT" would otherwise match millions of unrelated albums).
 */
export function luceneEscape(s) {
  return s
    .replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1')
    .replace(/\b(AND|OR|NOT)\b/g, (word) => word.toLowerCase())
}

/** One MusicBrainz search, within their rate limit. */
async function musicbrainz(entity, lucene, limit) {
  const url = `https://musicbrainz.org/ws/2/${entity}?fmt=json&limit=${limit}&query=${encodeURIComponent(lucene)}`
  await pace('musicbrainz', INTERVAL_MS)
  // MusicBrainz answers 503 when it is rate limiting; one polite retry usually works.
  return record('musicbrainz', () =>
    fetchJson(url).catch(async () => {
      await sleep(1500)
      await pace('musicbrainz', INTERVAL_MS)
      return fetchJson(url)
    }),
  )
}

/**
 * How an artist MusicBrainz returned fits the name that was typed:
 *   'exact'  the typed words are all of one of the artist's names (or aliases)
 *   'close'  every typed word is in one of those names, allowing a typo in longer words
 *            ("Radiohed", or "Stevens" for Cat Stevens)
 *   null     some typed word isn't in any of them ("whoopie cat" for Cat Stevens)
 * MusicBrainz scores a name that shares just one word with the search very highly, so its
 * score alone can't say whether this is the artist that was asked for.
 */
export function artistNameFit(artist, typed) {
  const wanted = nameWords(tokenize(typed))
  if (!wanted.length) return null
  const names = [artist.name, artist['sort-name'], ...(artist.aliases || []).flatMap((a) => [a.name, a['sort-name']])]
    .filter(Boolean)
    .map((n) => nameWords(tokenize(n)))
  if (names.some((credit) => artistMatch(credit, wanted) === 1)) return 'exact'
  const close = (credit) => wanted.every((w) => credit.some((c) => similarWord(w, c)))
  return names.some(close) ? 'close' : null
}

/**
 * An artist's official albums. A name search alone is swamped by bootlegs and
 * namesakes, so find the artist first. Prolific artists have hundreds of albums and
 * search results can't be sorted, so ask for widely released ones (10+ releases)
 * first and only top up with the rest for artists with few of those.
 */
async function artistAlbums(name) {
  const found = await musicbrainz('artist', `artist:(${luceneEscape(name)})`, 10)
  // MusicBrainz always returns its closest guesses, even when they share only a word with the
  // search: a low score means no real match, and the name has to fit what was typed.
  const fits = (found.artists || [])
    .filter((a) => a.score >= 80)
    .map((artist) => ({ artist, fit: artistNameFit(artist, name) }))
    .filter((x) => x.fit)
  const best = (fits.find((x) => x.fit === 'exact') ?? fits[0])?.artist
  if (!best) return []
  const base = `arid:${best.id} AND primarytype:album AND status:official`
  const popular = (await musicbrainz('release-group', `${base} AND releases:[10 TO 100000]`, 100))['release-groups'] || []
  if (popular.length >= 8) return popular
  const rest = (await musicbrainz('release-group', base, 100))['release-groups'] || []
  const seen = new Set(popular.map((g) => g.id))
  return [...popular, ...rest.filter((g) => !seen.has(g.id))]
}

const creditOf = (g) => (g['artist-credit'] || []).map((c) => c.name + (c.joinphrase || '')).join('')

/**
 * Albums matching an album title, an artist, or both. With only an artist, this is
 * that artist's most popular albums.
 */
export async function searchAlbums({ album = '', artist = '' } = {}) {
  const a = cleanInput(album, 200)
  const b = cleanInput(artist, 200)
  if (!a && !b) throw new HttpError(400, 'Enter an album or an artist to search for')
  return cached(`albums:${a.toLowerCase()}|${b.toLowerCase()}`, async () => {
    const ta = luceneEscape(a)
    const tb = luceneEscape(b)
    let groups
    if (a && b) {
      groups = (await musicbrainz('release-group', `releasegroup:(${ta}) AND artist:(${tb}) AND primarytype:album`, 40))['release-groups']
    } else if (a) {
      groups = (await musicbrainz('release-group', `(releasegroup:(${ta})^3 OR artist:(${ta})) AND primarytype:album`, 40))['release-groups']
    } else {
      groups = await artistAlbums(b)
    }

    // MusicBrainz relevance alone puts obscure same-titled albums first, so rerank:
    // reward covering the query with title+artist words, penalise extra title words,
    // and prefer albums with many releases (a good popularity proxy).
    const qTokens = new Set(tokenize(a))
    const wantedArtist = tokenize(b)
    const ranked = (groups || []).map((g) => {
      const credit = creditOf(g)
      const titleTokens = tokenize(g.title)
      const creditTokens = tokenize(credit)
      const all = new Set([...titleTokens, ...creditTokens])
      const recall = [...qTokens].filter((x) => all.has(x)).length / (qTokens.size || 1)
      const titleRecall = [...qTokens].filter((x) => titleTokens.includes(x)).length / (qTokens.size || 1)
      const precision = titleTokens.filter((x) => qTokens.has(x)).length / (titleTokens.length || 1)
      const byArtist = artistMatch(creditTokens, wantedArtist)
      const secondary = g['secondary-types'] || []
      const popularity = 8 * Math.log1p(g.count || 0)
      const relevance =
        a && b
          ? 50 * titleRecall + 30 * precision + 40 * byArtist
          : a
            ? 60 * recall + 30 * precision
            : 60 * byArtist
      return {
        id: g.id,
        title: g.title,
        artist: credit,
        year: (g['first-release-date'] || '').slice(0, 4) || null,
        kind: secondary.length ? secondary.join(', ') : 'Album',
        cover: coverUrl(g.id),
        byArtist,
        rank: relevance + popularity + 0.2 * (g.score || 0) - (secondary.length ? 25 : 0),
      }
    })
    // Album + artist: only that artist's albums count, or "Blue" by Joni Mitchell could come
    // back as someone else's "Blue". Artist only: the albums already belong to the artist
    // MusicBrainz found, even if the name was typed slightly differently, so keep them all.
    const filtered = a && b ? ranked.filter((r) => r.byArtist > 0) : ranked
    return filtered
      .sort((x, y) => y.rank - x.rank)
      .slice(0, a ? 8 : 12)
      .map(({ rank, byArtist, ...result }) => result)
  })
}

// ---------- suggestions as you type ----------

/**
 * Lucene for text still being typed: every word must match, and the last one may be
 * unfinished ("kind of bl" → kind AND of AND bl*). Wildcard terms aren't lowercased by
 * the search engine, so everything is lowercased here.
 */
export function typingQuery(text) {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)) // "&" on its own can't match anything
    .map(luceneEscape)
  if (!words.length) return null
  words[words.length - 1] += '*'
  return words.join(' AND ')
}

/**
 * Suggestions for the Album or Artist field. These share MusicBrainz's one-request-per-
 * second budget with real searches, so they give up (returning nothing) rather than
 * wait more than a moment, and they need at least three characters.
 */
export async function suggest(field, text, { artist = '' } = {}) {
  const q = cleanInput(text, 100)
  const by = cleanInput(artist, 100)
  if (q.length < 3 || !['album', 'artist'].includes(field)) return []
  const key = `suggest:${field}:${q.toLowerCase()}|${by.toLowerCase()}`
  try {
    return await cached(
      key,
      async () => {
        if (!(await pace('musicbrainz', INTERVAL_MS, { maxWaitMs: 1500 }))) throw new Error('busy')
        const words = typingQuery(q)
        if (!words) return []
        if (field === 'artist') {
          const url = `https://musicbrainz.org/ws/2/artist?fmt=json&limit=8&query=${encodeURIComponent(`artist:(${words})`)}`
          const data = await record('musicbrainz', () => fetchJson(url))
          return uniqueBy(
            (data.artists || []).filter((x) => x.score >= 60).map((x) => ({ value: x.name, detail: x.disambiguation || x.country || '' })),
            (s) => s.value.toLowerCase(),
          ).slice(0, 6)
        }
        // Bracketed so AND applies to each part as a whole (unbracketed, MusicBrainz read the
        // artist as optional and suggested albums by anyone).
        const byArtist = by ? ` AND (artist:(${luceneEscape(by)}))` : ''
        const lucene = `(releasegroup:(${words}))${byArtist} AND primarytype:album`
        const search = async (q) => {
          const url = `https://musicbrainz.org/ws/2/release-group?fmt=json&limit=100&query=${encodeURIComponent(q)}`
          return ((await record('musicbrainz', () => fetchJson(url)))['release-groups'] || []).filter((g) => g.score >= 60)
        }
        // Every prefix match scores the same and results can't be sorted, so a common start
        // ("the dark side of") can bury the famous album among hundreds. Ask for widely
        // released albums first; only if there are few, look at everything (if there's time).
        let groups = await search(`${lucene} AND releases:[5 TO 100000]`)
        if (groups.length < 6 && (await pace('musicbrainz', INTERVAL_MS, { maxWaitMs: 1500 }))) {
          const seen = new Set(groups.map((g) => g.id))
          // Extra only: if this fails (MusicBrainz busy), keep what the first search found.
          const more = await search(lucene).catch(() => [])
          groups = [...groups, ...more.filter((g) => !seen.has(g.id))]
        }
        // MusicBrainz matches an artist on any of its words ("The Beatles" finds The Shadows),
        // so check the credit the way searches do.
        if (by) groups = groups.filter((g) => artistMatch(tokenize(creditOf(g)), tokenize(by)) > 0)
        groups.sort((x, y) => (y.count || 0) - (x.count || 0))
        return uniqueBy(
          groups.map((g) => ({ value: g.title, detail: creditOf(g) })),
          (s) => `${s.value}|${s.detail}`.toLowerCase(),
        ).slice(0, 6)
      },
      SUGGEST_TTL_MS,
    )
  } catch {
    return [] // suggestions are optional; never an error
  }
}

function uniqueBy(items, keyOf) {
  const seen = new Set()
  return items.filter((item) => {
    const k = keyOf(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
