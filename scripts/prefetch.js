// Look up store lists ahead of time, so first searches for these cities are instant.
//
//   npm run prefetch                         the built-in list of popular cities
//   npm run prefetch -- "Leeds" "Austin, TX" your own list
//
// Cities that are still fresh (looked up in the last week) are skipped.

import { POPULAR_CITIES, prefetchCities } from '../server/stores.js'

const cities = process.argv.slice(2).length ? process.argv.slice(2) : POPULAR_CITIES
console.log(`Checking ${cities.length} cities…`)
const results = await prefetchCities(cities, {
  log: (r) => console.log(`  ${r.city}: ${r.status}${r.stores != null ? ` (${r.stores} stores)` : ''}${r.error ? ` – ${r.error}` : ''}`),
})
const count = (status) => results.filter((r) => r.status === status).length
console.log(`Done: ${count('updated')} updated, ${count('fresh')} already fresh, ${count('failed')} failed.`)
process.exitCode = count('failed') ? 1 : 0
