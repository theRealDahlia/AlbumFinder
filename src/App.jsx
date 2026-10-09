import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api.js'
import StoreMap from './StoreMap.jsx'
import StoreCard from './StoreCard.jsx'
import { openStatus, parseHours } from './hours.js'
import { roundedMiles } from './distance.js'
import { useSuggestions } from './useSuggestions.js'
import { AlbumHeader, ArtistHeader, CoverStack, LoadingResults, PinIcon, Vinyl } from './views.jsx'
import './App.css'

// Front-page suggestions. `id` is the MusicBrainz release group, used for the cover.
const EXAMPLES = [
  { id: '416bb5e5-c7d1-3977-8fd7-7c9daf6c2be6', title: 'Rumours', artist: 'Fleetwood Mac', city: 'Portland', state: 'OR' },
  { id: '8e8a594f-2175-38c7-a871-abb68ec363e7', title: 'Kind of Blue', artist: 'Miles Davis', city: 'Berlin', state: '' },
  { id: '6e335887-60ba-38f0-95af-fae7774336bf', title: 'In Rainbows', artist: 'Radiohead', city: 'London', state: '' },
].map((e) => ({
  ...e,
  place: e.state ? `${e.city}, ${e.state}` : e.city,
  cover: `/api/cover/${e.id}`,
}))

const RADII_MILES = [1, 2, 5, 10, 25]
const FIELDS = ['album', 'artist', 'city', 'state', 'near', 'radius']
// Moving the map searches around its center, once it has stopped moving for a moment, and
// not when zoomed out so far that "around here" would be a whole region.
const MIN_AREA_ZOOM = 8
const MOVE_SETTLE_MS = 600
const MAX_AREA_KM = 25

/**
 * The search in the address bar: ?album=&artist= and either &city=&state= or &near=lat,lon
 * ("Near me"), with &radius= when it's an area chosen by moving the map.
 */
function readParams() {
  const p = new URLSearchParams(location.search)
  return Object.fromEntries(FIELDS.map((k) => [k, p.get(k) || '']))
}

function urlFor(q) {
  const url = new URL(location.href)
  url.search = ''
  for (const k of FIELDS) if (q[k]) url.searchParams.set(k, q[k])
  return url
}

const hasSearch = (q) => Boolean((q.album || q.artist) && (q.city || q.near))

/**
 * Whether repeating a failed search could help: yes for busy or unreachable servers
 * (5xx, too many requests, or no response at all), no for "couldn't find that city".
 */
function canRetry(failure) {
  return !failure.status || failure.status === 429 || failure.status >= 500
}

/**
 * The artist credit most of these albums share, so a one-off duet ("Ella Fitzgerald &
 * Louis Armstrong") or variant spelling ("Jaÿ‐Z") doesn't name the whole artist.
 */
function usualCredit(albums) {
  const counts = new Map()
  for (const a of albums || []) counts.set(a.artist, (counts.get(a.artist) || 0) + 1)
  let best = null
  for (const [credit, n] of counts) if (!best || n > counts.get(best)) best = credit
  return best
}

export default function App() {
  const [initial] = useState(readParams)
  const [albumQuery, setAlbumQuery] = useState(initial.album)
  const [artistQuery, setArtistQuery] = useState(initial.artist)
  const [cityQuery, setCityQuery] = useState(initial.city)
  const [stateQuery, setStateQuery] = useState(initial.state)
  // "lat,lon" when searching near a point instead of a city: the visitor's location ("Near
  // me"), or the map's center, in which case there's also a radius (km) from the map.
  const [near, setNear] = useState(initial.near)
  const [nearRadius, setNearRadius] = useState(initial.radius)
  const [locating, setLocating] = useState(false)
  // The search being loaded: its query, and which of its two lookups have finished.
  const [pending, setPending] = useState(null)
  const loading = pending !== null
  // { message, retry }: `retry` is the search to repeat, when repeating it could help.
  const [error, setError] = useState(null)
  const [albums, setAlbums] = useState(null)
  const [album, setAlbum] = useState(null)
  const [place, setPlace] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  // What the last search asked for, as typed: decides between album and artist results.
  const [searched, setSearched] = useState(null)
  const [radiusMiles, setRadiusMiles] = useState(null)
  const [openOnly, setOpenOnly] = useState(false)
  const [view, setView] = useState('list') // phones show the list or the map
  const [stockFor, setStockFor] = useState({ key: null, stock: {} })
  const [now, setNow] = useState(() => new Date())
  // Changes with each new search, telling the map to fit itself to the new stores. Moving
  // the map doesn't change it, so the map never jumps away from where it was put.
  const [fitKey, setFitKey] = useState(0)
  // A note over the map while moving it: { kind: 'updating' | 'error' | 'hint', text }.
  const [areaStatus, setAreaStatus] = useState(null)
  const areaFlight = useRef(null)
  const moveTimer = useRef(null)
  // The map area shown (or being fetched), so moving back to it doesn't look it up again.
  const shownArea = useRef(null)
  // The search in flight. A new search (or going home) aborts it, so only the latest search's
  // results ever reach the page, and its requests stop instead of running on in the background.
  const inFlight = useRef(null)

  // "Open now" should stay right while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const runSearch = useCallback(async (query, { history: mode = 'push' } = {}) => {
    const q = Object.fromEntries(FIELDS.map((k) => [k, (query[k] || '').trim()]))
    if (q.near) {
      q.city = ''
      q.state = ''
    } else q.radius = ''
    if (!q.album && !q.artist) return setError({ message: 'Enter an album or an artist to search for.' })
    if (!q.city && !q.near) return setError({ message: 'Enter a city to search in, or use your location.' })

    // Each search is a step in the browser's history, so Back returns to the previous one.
    const url = urlFor(q)
    if (mode === 'push' && url.href !== location.href) history.pushState(null, '', url)
    else if (mode !== 'none') history.replaceState(null, '', url)

    stopAreaUpdates()
    inFlight.current?.abort()
    const search = new AbortController()
    inFlight.current = search
    setPending({ query: q, albumsDone: false, storesDone: false })
    setError(null)
    setSelectedId(null)
    setRadiusMiles(null)
    setOpenOnly(false)
    setView('list')
    const done = (step) => () => {
      if (!search.signal.aborted) setPending((p) => p && { ...p, [step]: true })
    }
    const albumsReq = api.searchAlbums(q.album, q.artist, search.signal)
    const [lat, lon] = q.near.split(',')
    const storesReq = q.near
      ? api.findStoresNear(lat, lon, q.radius, search.signal)
      : api.findStores(q.city, q.state, search.signal)
    albumsReq.then(done('albumsDone'), () => {})
    storesReq.then(done('storesDone'), () => {})
    const [albumRes, storeRes] = await Promise.allSettled([albumsReq, storesReq])
    // A newer search replaced this one: its results (or abort errors) are not wanted.
    if (search.signal.aborted) return
    inFlight.current = null
    setPending(null)
    setError(null) // e.g. an "enter a city" message from a submit made while this was loading
    if (albumRes.status === 'rejected' || storeRes.status === 'rejected') {
      const failure = albumRes.reason || storeRes.reason
      setError({ message: failure.message, retry: canRetry(failure) ? q : null })
      setAlbums(null)
      setPlace(null)
      return
    }
    setSearched(q)
    setAlbums(albumRes.value)
    // An artist search shows all their albums until one is picked.
    setAlbum(q.album ? albumRes.value[0] || null : null)
    // Keep the state as typed for the heading ("Portland, ME").
    setPlace({ ...storeRes.value, state: q.state })
    setFitKey((k) => k + 1)
  }, [])

  /** Drop any pending or running update from moving the map (a new search supersedes it). */
  function stopAreaUpdates() {
    clearTimeout(moveTimer.current)
    areaFlight.current?.abort()
    areaFlight.current = null
    shownArea.current = null
    setAreaStatus(null)
  }
  useEffect(() => () => clearTimeout(moveTimer.current), [])

  const fillForm = (q) => {
    setAlbumQuery(q.album || '')
    setArtistQuery(q.artist || '')
    setCityQuery(q.city || '')
    setStateQuery(q.state || '')
    setNear(q.near || '')
    setNearRadius(q.radius || '')
  }

  /** Back to the empty home page. */
  const resetHome = useCallback(({ history: mode }) => {
    inFlight.current?.abort() // cancel any search still loading
    inFlight.current = null
    stopAreaUpdates()
    for (const set of [setAlbumQuery, setArtistQuery, setCityQuery, setStateQuery, setNear, setNearRadius]) set('')
    for (const set of [setAlbums, setAlbum, setPlace, setSearched, setSelectedId, setError, setPending]) set(null)
    if (mode === 'push' && location.pathname + location.search !== '/') history.pushState(null, '', '/')
    window.scrollTo(0, 0)
  }, [])

  // Run the search from a shared link on first load.
  useEffect(() => {
    if (!hasSearch(initial)) return
    const t = setTimeout(() => runSearch(initial, { history: 'replace' }))
    return () => clearTimeout(t)
  }, [initial, runSearch])

  // Back and Forward: show the search in the address bar.
  useEffect(() => {
    const onPop = () => {
      const q = readParams()
      if (!hasSearch(q)) return resetHome({ history: 'none' })
      fillForm(q)
      runSearch(q, { history: 'none' })
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [runSearch, resetHome])

  /** The logo: home without reloading. Modified clicks still open a new tab. */
  const goHome = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    resetHome({ history: 'push' })
  }

  const current = () => ({ album: albumQuery, artist: artistQuery, city: cityQuery, state: stateQuery, near, radius: nearRadius })

  const submit = (e) => {
    e.preventDefault()
    runSearch(current())
  }

  /** "Near me": the browser's location, rounded to about a kilometre. */
  const locateMe = () => {
    if (!navigator.geolocation) {
      return setError({ message: 'Your browser can’t share its location. Type a city instead.' })
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        const spot = `${pos.coords.latitude.toFixed(2)},${pos.coords.longitude.toFixed(2)}`
        setNear(spot)
        setNearRadius('')
        setCityQuery('')
        setStateQuery('')
        setError(null)
        if (albumQuery.trim() || artistQuery.trim()) runSearch({ ...current(), near: spot, radius: '' })
      },
      (err) => {
        setLocating(false)
        setError({
          message:
            err.code === err.PERMISSION_DENIED
              ? 'Location access is blocked for this site. Type a city instead, or allow location in your browser.'
              : 'Couldn’t find your location. Type a city instead.',
        })
      },
      { timeout: 10_000, maximumAge: 300_000 },
    )
  }

  const tryExample = (e) => {
    const q = { album: e.title, artist: e.artist, city: e.city, state: e.state, near: '', radius: '' }
    fillForm(q)
    runSearch(q)
  }

  const hasResults = albums && place
  const home = !hasResults && !loading

  // ---------- moving the map ----------

  /** The map was dragged or zoomed: once it settles, show the shops around its center. */
  const onMapMove = (view) => {
    if (!searched || loading) return
    clearTimeout(moveTimer.current)
    if (view.zoom < MIN_AREA_ZOOM) {
      return setAreaStatus({ kind: 'hint', text: 'Zoom in to see the shops around here.' })
    }
    moveTimer.current = setTimeout(() => updateArea(view), MOVE_SETTLE_MS)
  }

  /** Look up the shops around the map's center; the album and everything else stay as they are. */
  const updateArea = async (view) => {
    const lat = view.lat.toFixed(3)
    const lon = view.lon.toFixed(3)
    const radius = String(Math.round(Math.min(view.radiusKm, MAX_AREA_KM) * 10) / 10)
    // Zooming between levels that all cap at 25 km, or moving back, can land on the same area.
    const key = `${lat},${lon},${radius}`
    if (key === shownArea.current) {
      // Already shown: just clear a "zoom in" note. Still loading: leave "Updating…" up.
      if (!areaFlight.current) setAreaStatus(null)
      return
    }
    shownArea.current = key
    areaFlight.current?.abort()
    const request = new AbortController()
    areaFlight.current = request
    setAreaStatus({ kind: 'updating', text: 'Updating shops for this area…' })
    try {
      const value = await api.findStoresNear(lat, lon, radius, request.signal)
      if (request.signal.aborted) return
      const q = { ...searched, city: '', state: '', near: `${value.city.lat},${value.city.lon}`, radius: String(value.city.radiusKm) }
      setSearched(q)
      setPlace({ ...value, state: '' })
      fillForm(q)
      setSelectedId((id) => (value.stores.some((s) => s.id === id) ? id : null))
      setAreaStatus(null)
      // The same step in history, updated: map moves shouldn't pile up Back steps.
      history.replaceState(null, '', urlFor(q))
    } catch {
      if (request.signal.aborted) return
      shownArea.current = null // so moving back here tries again
      setAreaStatus({ kind: 'error', text: 'Couldn’t update the shops for this area. Move the map to try again.' })
    } finally {
      if (areaFlight.current === request) areaFlight.current = null
    }
  }
  const artistOnly = searched && !searched.album
  // The artist's name as MusicBrainz spells it, falling back to what was typed.
  const artistName = (artistOnly && usualCredit(albums)) || searched?.artist

  // ---------- stock ----------
  // Looked up once the album (or, for an artist search, the artist) is known.
  const stockTitle = album?.title ?? ''
  const stockArtist = album?.artist ?? artistName
  const stockKey = hasResults && (album || artistName) ? JSON.stringify([stockTitle, stockArtist]) : null
  useEffect(() => {
    if (!stockKey) return
    const request = new AbortController()
    api
      .findStock(stockTitle, stockArtist, request.signal)
      .then((stock) => setStockFor({ key: stockKey, stock }))
      .catch(() => {}) // stock is a bonus; the store list stands on its own
    return () => request.abort()
  }, [stockKey, stockTitle, stockArtist])
  const stock = stockFor.key === stockKey ? stockFor.stock : {}

  // ---------- suggestions ----------
  const albumSuggestions = useSuggestions('album', albumQuery, { artist: artistQuery })
  const artistSuggestions = useSuggestions('artist', artistQuery)
  const citySuggestions = useSuggestions('city', cityQuery, { enabled: !near })

  const changeCity = (value) => {
    setNear('')
    setNearRadius('')
    // Picking a suggestion ("Portland, Maine") fills the City and State boxes separately.
    const picked = citySuggestions.find((s) => s.value === value && s.city)
    setCityQuery(picked ? picked.city : value)
    if (picked) setStateQuery(picked.state)
  }

  const changeAlbum = (value) => {
    setAlbumQuery(value)
    // Picking an album suggestion fills in its artist, if that's unambiguous.
    const matches = albumSuggestions.filter((s) => s.value === value)
    if (matches.length === 1 && !artistQuery.trim()) setArtistQuery(matches[0].detail)
  }

  // ---------- the store list ----------
  const timezone = place?.city.timezone
  const allStores = place ? place.stores : []
  const stores = allStores
    .filter((s) => radiusMiles == null || roundedMiles(s.distanceKm) <= radiusMiles)
    .filter((s) => !openOnly || openStatus(parseHours(s.hours), now, timezone)?.open)
    .sort((a, b) => Number(Boolean(stock[b.id]?.length)) - Number(Boolean(stock[a.id]?.length)) || a.distanceKm - b.distanceKm)
  const inStockCount = allStores.filter((s) => stock[s.id]?.length).length
  const anyHours = allStores.some((s) => parseHours(s.hours))
  const filtered = stores.length !== allStores.length
  // A map area has a (possibly null) name from the server; "Near me" has none.
  const isMapArea = place?.city.near && place.city.area !== undefined
  const where = isMapArea
    ? `around ${place.city.area || 'this area'}`
    : place?.city.near
      ? 'near you'
      : `in ${place?.city.name.split(',')[0]}${place?.state ? `, ${place.state}` : ''}`
  const nearLabel = nearRadius ? (isMapArea && place.city.area) || 'Map area' : 'Your location'
  const osmEditUrl = place ? `https://www.openstreetmap.org/edit#map=15/${place.city.lat}/${place.city.lon}` : null

  return (
    <div className="app">
      <header className={`hero ${home ? 'home' : 'compact'}`}>
        <a href="/" className="brand" onClick={goHome} aria-label="Album Finder home">
          <Vinyl />
          <span>Album Finder</span>
        </a>
        <div className="hero-main">
          {home && (
            <>
              <h1>Find that record on a real shelf.</h1>
              <p className="lede">
                Search for an album or an artist, pick a city, and find the record stores nearby to call or visit.
              </p>
            </>
          )}
          <form className="search" onSubmit={submit}>
            <label className="field album-field">
              <span>Album</span>
              <input
                value={albumQuery}
                onChange={(e) => changeAlbum(e.target.value)}
                placeholder="e.g. Blue"
                autoFocus={!initial.album && !initial.artist}
                list="album-suggestions"
                autoComplete="off"
              />
            </label>
            <label className="field artist-field">
              <span>Artist</span>
              <input
                value={artistQuery}
                onChange={(e) => setArtistQuery(e.target.value)}
                placeholder="e.g. Joni Mitchell"
                list="artist-suggestions"
                autoComplete="off"
              />
            </label>
            <div className="field city-field">
              <div className="field-top">
                <label htmlFor="city-input">City</label>
                <button type="button" className="locate" onClick={locateMe} disabled={locating}>
                  <PinIcon /> {locating ? 'Locating…' : 'Near me'}
                </button>
              </div>
              <input
                id="city-input"
                value={near ? nearLabel : cityQuery}
                onFocus={(e) => near && e.target.select()}
                onChange={(e) => changeCity(e.target.value)}
                placeholder="e.g. Chicago"
                list="city-suggestions"
                autoComplete="off"
                className={near ? 'is-location' : ''}
              />
            </div>
            <label className="field state-field">
              <span>
                State <small>optional</small>
              </span>
              <input
                value={stateQuery}
                onChange={(e) => setStateQuery(e.target.value)}
                placeholder="e.g. IL"
                autoComplete="address-level1"
                disabled={Boolean(near)}
              />
            </label>
            {/* Stays enabled while loading: submitting again replaces the current search. */}
            <button type="submit">Find it</button>
            <Suggestions id="album-suggestions" items={albumSuggestions} />
            <Suggestions id="artist-suggestions" items={artistSuggestions} />
            <Suggestions id="city-suggestions" items={citySuggestions} />
          </form>
          {/* Right under the form, where it's seen even when the page above it is tall (phones). */}
          {error && (
            <div className="notice error" role="alert">
              {error.message}{' '}
              {error.retry && (
                <button type="button" className="link" onClick={() => runSearch(error.retry, { history: 'none' })}>
                  Try again
                </button>
              )}
            </div>
          )}
          {home && (
            <div className="try">
              <span id="try-label">Try</span>
              <ul aria-labelledby="try-label">
                {EXAMPLES.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      className="try-chip"
                      aria-label={`Search for ${e.title} by ${e.artist} in ${e.place}`}
                      onClick={() => tryExample(e)}
                    >
                      <strong>{e.title}</strong>
                      <span>
                        <PinIcon />
                        {e.place}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {home && <CoverStack examples={EXAMPLES} onPick={tryExample} />}
      </header>

      <main>
        {loading && <LoadingResults {...pending} />}

        {hasResults && !loading && (
          <>
            {albums.length === 0 ? (
              <div className="notice">
                {searched.album && searched.artist
                  ? `No album called “${searched.album}” by “${searched.artist}” found. Check the spelling, or try just one of them.`
                  : searched.album
                    ? `No album matched “${searched.album}”. Try adding the artist.`
                    : `No artist matched “${searched.artist}”. Check the spelling.`}
              </div>
            ) : album ? (
              <AlbumHeader
                album={album}
                albums={albums}
                onChoose={setAlbum}
                onBack={artistOnly ? () => setAlbum(null) : null}
                backLabel={`All albums by ${artistName}`}
              />
            ) : (
              <ArtistHeader artist={artistName} albums={albums} onChoose={setAlbum} />
            )}

            <section className="results">
              <div className="results-head">
                <div>
                  <h2>
                    {allStores.length} record {allStores.length === 1 ? 'store' : 'stores'} {where}
                  </h2>
                  {allStores.length > 0 && (album || artistName) && (
                    <p className="sub">
                      {inStockCount > 0 &&
                        `${inStockCount} ${inStockCount === 1 ? 'has' : 'have'} ${album ? 'it' : 'records by them'} listed in stock. `}
                      Nearest first. Call ahead to check{' '}
                      {album ? `whether they have ${album.title}` : `what they have by ${artistName}`}.
                    </p>
                  )}
                </div>
                {allStores.length > 0 && (
                  <div className="filters">
                    <label>
                      Distance{' '}
                      <select
                        value={radiusMiles ?? ''}
                        onChange={(e) => setRadiusMiles(e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">Any</option>
                        {RADII_MILES.map((miles) => (
                          <option key={miles} value={miles}>
                            Within {miles} mi
                          </option>
                        ))}
                      </select>
                    </label>
                    {anyHours && (
                      <label className="toggle">
                        <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open
                        now
                      </label>
                    )}
                  </div>
                )}
              </div>
              {filtered && (
                <p className="sub showing">
                  Showing {stores.length} of {allStores.length}.{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setRadiusMiles(null)
                      setOpenOnly(false)
                    }}
                  >
                    Show all
                  </button>
                </p>
              )}

              {stores.length > 0 && (
                <div className="view-toggle" role="group" aria-label="Show stores as">
                  {['list', 'map'].map((v) => (
                    <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
                      {v === 'list' ? 'List' : 'Map'}
                    </button>
                  ))}
                </div>
              )}

              <div className={`layout view-${view}`}>
                <StoreMap
                  center={place.city}
                  stores={stores}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  fitKey={fitKey}
                  onMove={onMapMove}
                  area={isMapArea ? { lat: place.city.lat, lon: place.city.lon, radiusKm: place.city.radiusKm } : null}
                  status={areaStatus}
                />
                <ul className="stores">
                  {allStores.length === 0 && (
                    <li className="notice">
                      No record stores are mapped {where} on OpenStreetMap yet. Try a nearby larger city, or{' '}
                      <a href={osmEditUrl} target="_blank" rel="noreferrer">
                        add a shop you know
                      </a>
                      .
                    </li>
                  )}
                  {allStores.length > 0 && stores.length === 0 && (
                    <li className="notice">No stores match these filters.</li>
                  )}
                  {view === 'map' && !selectedId && stores.length > 0 && (
                    <li className="map-hint">Tap a shop on the map to see its details.</li>
                  )}
                  {stores.map((s) => (
                    <StoreCard
                      key={s.id}
                      store={s}
                      timezone={timezone}
                      now={now}
                      stock={stock[s.id]}
                      selected={s.id === selectedId}
                      onSelect={() => setSelectedId(s.id)}
                    />
                  ))}
                </ul>
              </div>
              {allStores.length > 0 && (
                <p className="missing">
                  Missing a shop?{' '}
                  <a href={osmEditUrl} target="_blank" rel="noreferrer">
                    Add it to OpenStreetMap
                  </a>
                  , and it will appear here once our copy of the map refreshes (within a week).
                </p>
              )}
            </section>
          </>
        )}
      </main>

      <footer>
        Store data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Album data
        from <a href="https://musicbrainz.org">MusicBrainz</a> · Some stock from{' '}
        <a href="https://www.discogs.com">Discogs</a>. Stock varies, so call ahead.
      </footer>
    </div>
  )
}

function Suggestions({ id, items }) {
  return (
    <datalist id={id}>
      {items.map((s) => (
        <option key={`${s.value}|${s.detail}`} value={s.value} label={s.detail || undefined} />
      ))}
    </datalist>
  )
}
