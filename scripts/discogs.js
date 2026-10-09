// Link record shops to their Discogs seller accounts, and sync what they have for sale.
//
//   npm run discogs -- link node/123 sellername   link a shop (the id is in the "Fix details"
//                                                 link on its card: openstreetmap.org/node/123)
//   npm run discogs -- unlink node/123
//   npm run discogs -- list
//   npm run discogs -- sync                       sync inventories more than a day old
//   npm run discogs -- sync --force               sync them all now
//
// Set DISCOGS_TOKEN (a personal access token from discogs.com/settings/developers) to sync
// faster: 60 requests a minute instead of 25.

import { linkSeller, readLinks, syncAll, unlinkSeller } from '../server/discogs.js'

const [command, ...args] = process.argv.slice(2)

try {
  if (command === 'link' && args.length === 2) {
    const { seller, forSale } = await linkSeller(args[0], args[1])
    console.log(`Linked ${args[0]} to Discogs seller "${seller}"${forSale != null ? ` (${forSale} listings)` : ''}.`)
    console.log('Run `npm run discogs -- sync` to fetch their inventory.')
  } else if (command === 'unlink' && args.length === 1) {
    console.log((await unlinkSeller(args[0])) ? `Unlinked ${args[0]}.` : `${args[0]} wasn't linked.`)
  } else if (command === 'list') {
    const links = Object.entries(await readLinks())
    if (!links.length) console.log('No shops are linked yet.')
    for (const [storeId, { seller, linkedAt }] of links) console.log(`${storeId}  →  ${seller}  (linked ${linkedAt.slice(0, 10)})`)
  } else if (command === 'sync') {
    const results = await syncAll({ force: args.includes('--force'), log: (line) => console.log(line) })
    if (!results.length) console.log('No shops are linked yet.')
    for (const r of results) console.log(`${r.seller}: ${r.status}${r.items != null ? `, ${r.items} vinyl listings` : ''}${r.error ? ` – ${r.error}` : ''}`)
    process.exitCode = results.some((r) => r.status === 'failed') ? 1 : 0
  } else {
    console.log('Usage: npm run discogs -- link <shop id> <seller> | unlink <shop id> | list | sync [--force]')
    process.exitCode = 1
  }
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
