// Matching stock listings (from shops' Discogs inventories) to a search.

import { artistMatch, tokenize } from './util.js'

// Edition words that don't change which album it is.
const EDITION_WORDS = new Set(
  'deluxe edition remastered remaster reissue anniversary expanded limited special collectors version mono stereo'.split(' '),
)
const titleWords = (s) => tokenize(s).filter((t) => !EDITION_WORDS.has(t))

/**
 * Vinyl only: this is a record-shop finder. "LP" (also "2xLP"), "Vinyl" and record sizes
 * always mean vinyl, even in an "LP + CD" set; "EP" only does when nothing says CD,
 * cassette or file, since Discogs uses it for "CD, EP" too.
 */
export function isVinyl(format) {
  const f = format || ''
  if (/(?:\b|\dx)LP\b|\bVinyl\b|\b(7|10|12)("|-?inch\b)/i.test(f)) return true
  return /(?:\b|\dx)EP\b/i.test(f) && !/\b(CD|CDr|Cass|Cassette|File|DVD)\b/i.test(f)
}

/**
 * Whether a listing is the album searched for (or, with no album, any record by the
 * artist). Titles must match apart from edition words ("Rumours (Deluxe Edition)" is
 * Rumours; "Rumours Live" isn't), and the artist must match.
 */
export function listingMatches(item, { album, artist }) {
  if (artist && !artistMatch(tokenize(item.artist), tokenize(artist))) return false
  if (!album) return Boolean(artist)
  const want = titleWords(album)
  const have = titleWords(item.title)
  return want.length > 0 && want.length === have.length && want.every((w) => have.includes(w))
}
