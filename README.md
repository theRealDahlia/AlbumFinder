# Album Finder

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
| Stock | The Discogs inventories of shops linked to a Discogs seller account |

**Searching.** Album and artist can be used together (that exact album), or alone: an artist on their own lists their most popular official albums to pick from. The optional **State** tells apart same-named cities. **Near me** uses the browser's location, rounded to about a kilometre. Each search is a step in the browser's history, and links are shareable: `/?album=Kind+of+Blue&artist=Miles+Davis&city=Berlin`, `/?artist=Radiohead&near=45.52,-122.68`.

**Moving the map** searches where you look: drag or zoom it, and once it stops the store list updates to the shops around its center (named, e.g. "around Soho, City of Westminster", with a dashed outline of the area). The album stays as it is; only the shops are looked up again. The area matches what's visible, up to 25 km; zoomed out further than that, the map asks you to zoom in. Map moves update the link (`/?album=Rumours&near=51.513,-0.135&radius=5`) without adding Back steps.

**Results.** Shops listing the album in stock come first, then the rest nearest first. Opening hours are shown in plain words with **Open now / Closed**, worked out in the shop's own timezone; filters narrow by distance or to shops open now. On phones, a List/Map switch keeps the map from crowding the list. Each card links to OpenStreetMap ("Fix details") so anyone can correct a shop's details, and "Missing a shop?" opens the map editor.

## Stock

There's no public source for what physical shops have on their shelves. Many shops also sell on Discogs, though, so a shop can be linked to its Discogs seller account; the server then syncs that inventory daily (searching it locally, since Discogs' API can't search an inventory) and shows matching vinyl as "In stock":

```bash
npm run discogs -- link node/123 sellername
npm run discogs -- sync          # or wait for the daily sync
npm run discogs -- list
npm run discogs -- unlink node/123
```

The shop id is in the "Fix details" link on the shop's card (`openstreetmap.org/node/123`). Nothing ties an OpenStreetMap shop to a Discogs account automatically, so check that the seller really is that shop before linking it.

## Verified vinyl sellers

OpenStreetMap says what a shop is tagged as, not what it sells. So once a shop is found there, the server cross-checks it against Discogs in the background. Discogs can't search for sellers, so it guesses usernames from the shop's name and website, and accepts a profile only if it backs up what OpenStreetMap says: the profile lists the shop's website, or it has the shop's name and is in the shop's city. The seller must also have vinyl among its newest 100 listings. Shops that pass get a **Sells vinyl · Discogs** badge linking to the seller page, and a **Verified on Discogs** filter.

A shop without the badge isn't necessarily fake: plenty of real record shops don't sell on Discogs. Checks run one at a time (Discogs allows 25 requests a minute, 60 with `DISCOGS_TOKEN`), so a large city takes a few minutes to fill in; answers are kept in `data/discogs-verified.json` for 30 days (14 for shops that didn't match) and `GET /api/verification?ids=node/1,way/2` reports them. Only shops the server itself returned can be checked.

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
