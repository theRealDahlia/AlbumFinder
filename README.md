# Stacks

Find vinyl records on real shelves. Search for an album or an artist, pick a city (or use your location), and see the record stores there: which ones list it in stock, which are open now, and phone numbers, websites and directions for the rest.

## Run it

Needs Node 22.12 or newer.

```bash
npm install
npm run dev        # http://localhost:5173 (API included via a Vite plugin)
```

Production:

```bash
npm run build
CONTACT=you@example.com npm start   # serves dist/ and the API on PORT (default 3000)
```

Or with Docker (see the [Dockerfile](Dockerfile)):

```bash
docker build -t album-finder .
docker run -p 3000:3000 -v album-finder-data:/data -e CONTACT=you@example.com album-finder
```

### Settings

| Variable | What it does |
| --- | --- |
| `CONTACT` | A website or email address, sent to MusicBrainz and OpenStreetMap as they ask. **Set this for real use**; apps without one may be throttled. |
| `PORT` | Port for `npm start` (default 3000). |
| `DATA_DIR` | Where cached data, covers and Discogs inventories are kept (default `./data`). Keep it on persistent storage. |
| `REDIS_URL` | Share caches, rate limits and API pacing between several copies of the server. Without it, each copy keeps its own in memory. |
| `TRUST_PROXY=1` | Behind a reverse proxy or load balancer: read visitors' addresses from `X-Forwarded-For`, so per-visitor limits work. Don't set it otherwise; the header could be forged. |
| `DISCOGS_TOKEN` | Optional Discogs personal access token: syncs inventories at 60 requests a minute instead of 25. |

## What it does

| Piece | Source |
| --- | --- |
| Albums and artists | [MusicBrainz](https://musicbrainz.org); covers from [Cover Art Archive](https://coverartarchive.org), cached by the server |
| Finding the city | [Nominatim](https://nominatim.org) (OpenStreetMap) |
| Record stores, hours | [Overpass API](https://overpass-api.de) (OpenStreetMap) |
| Suggestions as you type | MusicBrainz (albums, artists), [Photon](https://photon.komoot.io) (cities) |
| Stock | The Discogs inventories of verified shops and shops linked to a Discogs seller account |

**Searching.** Album and artist can be used together (that exact album), or alone: an artist on their own lists their most popular official albums to pick from. The artist must really be the one typed: every word has to be in the artist's name or an alias (a small typo is forgiven), so "whoopie cat" doesn't turn up Cat Stevens just because MusicBrainz scores him highly for "cat". The optional **State** tells apart same-named cities. **Near me** uses the browser's location, rounded to about a kilometre. Each search is a step in the browser's history, and links are shareable: `/?album=Kind+of+Blue&artist=Miles+Davis&city=Berlin`, `/?artist=Radiohead&near=45.52,-122.68`.

**Moving the map** searches where you look: drag or zoom it, and once it stops the store list updates to the shops around its center (named, e.g. "around Soho, City of Westminster", with a dashed outline of the area). The album stays as it is; only the shops are looked up again. The area matches what's visible, up to 25 km; zoomed out further than that, the map asks you to zoom in. Map moves update the link (`/?album=Rumours&near=51.513,-0.135&radius=5`) without adding Back steps.

**Results.** Only shops that list their opening hours on OpenStreetMap are shown: a shop with none can't be told from one that has closed, and the hours are what the Open now / Closed status needs. Shops listing the album in stock come first, then the rest nearest first. Opening hours are shown in plain words with **Open now / Closed**, worked out in the shop's own timezone; a distance filter narrows the list, and ticking **Open now** greys out the shops that are closed: they stay listed (still marked Closed, below the open ones) but can't be clicked. On phones, a List/Map switch keeps the map from crowding the list. Each card links to OpenStreetMap ("Fix details") so anyone can correct a shop's details, and "Missing a shop?" opens the map editor.

## Stock

There's no public source for what physical shops have on their shelves. Many shops also sell on Discogs, though, so the server uses the Discogs inventory of every shop that [verification](#verified-vinyl-sellers) confirms as a Discogs seller, plus any shop linked by hand. It syncs each inventory (and searches it locally, since Discogs' API can't search an inventory), then marks each of those shops for the search:

- **In stock**: it lists the album (or, in an artist search, records by them), with price and condition.
- **Sells other works by the artist**: no copy of the album, but other records by the artist, which are listed.
- **No … in their Discogs stock**: it has neither. The card notes that Discogs may not show everything on the shelf and links to the shop's website to check (or says to call ahead, if it has none).

A shop with no Discogs inventory (one that isn't verified) says nothing either way. Shops with the album come first, then those with other works by the artist. A big inventory takes a few minutes to download the first time, and the page asks again until it's there; after that each inventory is refreshed daily.

To link a shop by hand (for one verification didn't find, or to override it):

```bash
npm run discogs -- link node/123 sellername
npm run discogs -- sync          # or wait for the daily sync
npm run discogs -- list
npm run discogs -- unlink node/123
```

The shop id is in the "Fix details" link on the shop's card (`openstreetmap.org/node/123`). Nothing ties a shop to a Discogs account automatically except verification, so check that the seller really is that shop before linking it.

## Verified vinyl sellers

OpenStreetMap says what a shop is tagged as, not what it sells. So once a shop is found there, the server cross-checks it against Discogs in the background. Discogs can't search for sellers, so it guesses usernames from the shop's name and website, and accepts a profile only if it backs up what OpenStreetMap says: the profile lists the shop's website, or it has the shop's name and is in the shop's city. The seller must also have vinyl among its newest 100 listings. Shops that pass get a **Sells vinyl · Discogs** badge linking to the seller page (and their stock is searched, as above) and are listed under **Verified vinyl sellers**; every other shop is listed below them under **Other record stores**. Shops move up as they're confirmed, and the page says so while checks are still running.

**Checked ahead of time.** The production server doesn't wait for a search: a couple of minutes after starting (and every six hours after), it queues the nearest 100 shops of every saved city for checking, and downloads the inventory of each one it confirms. Those checks sit behind any a visitor is waiting on, so searches always go first. It's slow, since Discogs allows only a few requests a minute (set `DISCOGS_TOKEN` to get 60), so it takes a while after a fresh start, but a city that's been warmed up (run `npm run prefetch` first to save the popular ones) is fully verified, with stock, the moment someone searches it.

A shop in the second list isn't necessarily fake: plenty of real record shops don't sell on Discogs. Checks run one at a time (Discogs allows 25 requests a minute, 60 with `DISCOGS_TOKEN`), so a large city takes a few minutes to fill in; answers are kept in `data/discogs-verified.json` for 30 days (14 for shops that didn't match) and `GET /api/verification?ids=node/1,way/2` reports them. Only shops the server itself returned can be checked.

## Keeping it fast

- **Store lists** are cached on disk for a week, refreshed in the background before they go stale, and served stale if OpenStreetMap's servers are down. Warm the cache for popular cities ahead of time (or your own list) with:

  ```bash
  npm run prefetch
  npm run prefetch -- "Leeds" "Austin, TX"
  ```

- **Covers** are fetched from Cover Art Archive once, then served from disk (newest 5,000 kept).
- **MusicBrainz and Nominatim** allow about one request a second for the whole site; the server paces itself (across copies, with `REDIS_URL`) and caches results. Suggestions give up rather than make searches wait.

## Limits and monitoring

Each visitor (by IP address, or by /64 for IPv6) may make 30 searches, 120 suggestion requests and 600 cover requests a minute; over that the API answers `429` with `Retry-After`.

`GET /api/health` reports uptime, request counts, the cache backend, and each upstream service's successes, failures, average time and last error. `status` is `degraded` when a service's latest call failed (the site still works from cache). Point an uptime monitor at it. The production server also logs one JSON line per request (method, path, status, time; search terms are left out).

## Tests

No network needed: every outside service is mocked.

```bash
npm test               # both suites
npm run test:server    # server (Node's test runner, test/); build first to include the production-server test
npm run test:ui        # the React app in a simulated browser (Vitest + Testing Library, src/*.test.*)
```

## Code layout

- `server/api.js`: the HTTP API; `server/index.js`: the production server and background jobs
- `server/musicbrainz.js`, `stores.js`, `covers.js`: albums, stores, covers
- `server/discogs.js`, `stock.js`: stock from Discogs, and matching it to searches
- `server/verify.js`: confirming shops sell vinyl by finding their Discogs seller account
- `server/shared.js`: caching, rate limits and pacing (memory or Redis); `server/health.js`: monitoring
- `src/App.jsx`: the search page; `src/StoreCard.jsx`: a shop's card; `src/hours.js`: opening hours
- `scripts/`: `prefetch` and `discogs` commands
# AlbumFinder
