import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from './api.js'
import App from './App.jsx'

vi.mock('./api.js', () => ({
  searchAlbums: vi.fn(),
  findStores: vi.fn(),
  findStoresNear: vi.fn(),
  suggest: vi.fn(),
  findStock: vi.fn(),
  findVerification: vi.fn(),
}))
// Leaflet needs real layout; a stand-in shows what the map was given, and keeps its props so
// tests can act as the map would (e.g. call onMove as if someone dragged it).
const map = vi.hoisted(() => ({ props: null }))
vi.mock('./StoreMap.jsx', () => ({
  default: (props) => {
    map.props = props
    const { stores, selectedId, onSelect, status } = props
    return (
    <div data-testid="map" data-count={stores.length} data-selected={selectedId ?? ''}>
      {status && <p role="status">{status.text}</p>}
      {stores.map((s) => (
        <button key={s.id} type="button" data-testid={`marker-${s.id}`} onClick={() => onSelect(s.id)} />
      ))}
    </div>
    )
  },
}))

// ---------- fixtures ----------

const album = (id, title, artist = 'Fleetwood Mac', extra = {}) => ({
  id,
  title,
  artist,
  year: '1977',
  kind: 'Album',
  cover: `https://covers.test/${id}.jpg`,
  ...extra,
})
const RUMOURS = album('a1', 'Rumours')
const TUSK = album('a2', 'Tusk', 'Fleetwood Mac', { year: '1979' })

const store = (n, name, distanceKm) => ({
  id: `node/${n}`,
  name,
  distanceKm,
  lat: 45.5,
  lon: -122.6,
  address: `${n} Main St`,
  phone: null,
  website: null,
  hours: null,
})
// What /api/stock answers; `parts` says what's different from "nothing found anywhere".
const report = (parts = {}) => ({ stock: {}, others: {}, checked: [], pending: 0, ...parts })
const PORTLAND = {
  city: { name: 'Portland, Multnomah County, Oregon, United States', lat: 45.5, lon: -122.6 },
  stores: [store(2, 'Far Records', 5.2), store(1, 'Near Records', 0.4)],
}

/** A request the test resolves by hand. Like fetch, it rejects when its signal aborts. */
function controllable() {
  const calls = []
  const impl = (...args) => {
    const signal = args.at(-1)
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    calls.push({ args: args.slice(0, -1), signal, resolve, reject })
    return promise
  }
  return { calls, impl }
}

// ---------- helpers ----------

let user
beforeEach(() => {
  history.replaceState(null, '', '/')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  // jsdom has no scrollIntoView; record the calls instead.
  Element.prototype.scrollIntoView = vi.fn()
  window.matchMedia = vi.fn(() => ({ matches: false }))
  api.searchAlbums.mockResolvedValue([RUMOURS, TUSK])
  api.findStores.mockResolvedValue(PORTLAND)
  api.findStoresNear.mockResolvedValue({ ...PORTLAND, city: { ...PORTLAND.city, name: 'your location', near: true } })
  api.suggest.mockResolvedValue([])
  api.findStock.mockResolvedValue(report())
  api.findVerification.mockResolvedValue({ verified: {}, pending: 0 })
  user = userEvent.setup()
})
afterEach(cleanup)

// Exact label text ("State" also says "optional"); a loose match would hit "Album Finder home".
const field = (name) => screen.getByLabelText(name === 'State' ? /^State\s*optional$/ : name)

async function search({ album = '', artist = '', city = '', state = '' }) {
  for (const [name, value] of Object.entries({ Album: album, Artist: artist, City: city, State: state })) {
    await user.clear(field(name))
    if (value) await user.type(field(name), value)
  }
  await user.click(screen.getByRole('button', { name: 'Find it' }))
}

const steps = () => [...document.querySelectorAll('.loading-steps li')]

// ---------- tests ----------

describe('front page', () => {
  test('shows the headline, search form and suggestions, and no results', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveProperty('textContent', 'Find that record on a real shelf.')
    expect(screen.getAllByRole('button', { name: /^Search for / })).toHaveLength(3)
    expect(screen.queryByText(/record stores? in/)).toBeNull()
  })

  test('a suggestion fills in the form and searches for it', async () => {
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Search for Rumours by Fleetwood Mac in Portland, OR' }))
    expect(field('Album').value).toBe('Rumours')
    expect(field('Artist').value).toBe('Fleetwood Mac')
    expect(field('City').value).toBe('Portland')
    expect(field('State').value).toBe('OR')
    expect(api.searchAlbums).toHaveBeenCalledWith('Rumours', 'Fleetwood Mac', expect.any(AbortSignal))
    expect(api.findStores).toHaveBeenCalledWith('Portland', 'OR', expect.any(AbortSignal))
    expect(await screen.findByText('2 record stores in Portland, OR')).toBeTruthy()
  })
})

describe('searching', () => {
  test('needs an album or an artist', async () => {
    render(<App />)
    await search({ city: 'Portland' })
    expect(screen.getByRole('alert').textContent).toMatch('Enter an album or an artist')
    expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull()
    expect(api.searchAlbums).not.toHaveBeenCalled()
  })

  test('shows the album and the stores, nearest first, and updates the link', async () => {
    render(<App />)
    await search({ album: 'Rumours', artist: 'Fleetwood Mac', city: 'Portland' })
    expect(await screen.findByRole('heading', { name: 'Rumours' })).toBeTruthy()
    expect(screen.getByText('2 record stores in Portland')).toBeTruthy()
    const names = screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)
    expect(names).toEqual(['Near Records', 'Far Records'])
    expect(screen.getByText(/whether they have Rumours/)).toBeTruthy()
    expect(location.search).toBe('?album=Rumours&artist=Fleetwood+Mac&city=Portland')
  })

  test('selecting a store marks it and tells the map', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    const far = await screen.findByRole('button', { name: 'Far Records' })
    await user.click(far)
    expect(far.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('map').dataset.selected).toBe('node/2')
  })

  test('runs the search from a shared link on load', async () => {
    history.replaceState(null, '', '/?artist=Radiohead&city=London')
    api.searchAlbums.mockResolvedValue([album('r1', 'OK Computer', 'Radiohead')])
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Radiohead' })).toBeTruthy()
    expect(api.searchAlbums).toHaveBeenCalledWith('', 'Radiohead', expect.any(AbortSignal))
    expect(field('Artist').value).toBe('Radiohead')
  })

  test.each([
    [{ album: 'Zzz', artist: 'Nobody' }, 'No album called “Zzz” by “Nobody” found'],
    [{ album: 'Zzz' }, 'No album matched “Zzz”'],
    [{ artist: 'Nobody' }, 'No artist matched “Nobody”'],
  ])('says when nothing matched %o', async (query, message) => {
    api.searchAlbums.mockResolvedValue([])
    render(<App />)
    await search({ ...query, city: 'Portland' })
    expect(await screen.findByText(new RegExp(message))).toBeTruthy()
  })
})

describe('loading', () => {
  test('shows each lookup, ticking it off when it actually finishes', async () => {
    const albums = controllable()
    const stores = controllable()
    api.searchAlbums.mockImplementation(albums.impl)
    api.findStores.mockImplementation(stores.impl)
    render(<App />)
    await search({ album: 'Rumours', artist: 'Fleetwood Mac', city: 'Portland', state: 'OR' })

    expect(steps().map((li) => li.textContent)).toEqual([
      'Looking up Rumours by Fleetwood Mac – in progress',
      'Finding record stores in Portland, OR – in progress',
    ])
    await act(() => albums.calls[0].resolve([RUMOURS]))
    expect(steps().map((li) => li.classList.contains('done'))).toEqual([true, false])
    await act(() => stores.calls[0].resolve(PORTLAND))
    expect(screen.queryByLabelText('Loading results')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Rumours' })).toBeTruthy()
  })

  test('a new search cancels the one loading, and only the latest result is shown', async () => {
    const albums = controllable()
    const stores = controllable()
    api.searchAlbums.mockImplementation(albums.impl)
    api.findStores.mockImplementation(stores.impl)
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    expect(screen.getByRole('button', { name: 'Find it' }).disabled).toBe(false)
    await search({ album: 'Tusk', city: 'Chicago' })

    expect(albums.calls[0].signal.aborted).toBe(true)
    expect(stores.calls[0].signal.aborted).toBe(true)
    expect(albums.calls[1].signal.aborted).toBe(false)
    expect(steps()[0].textContent).toBe('Looking up Tusk – in progress')

    await act(async () => {
      albums.calls[1].resolve([TUSK])
      stores.calls[1].resolve({ ...PORTLAND, city: { ...PORTLAND.city, name: 'Chicago, Illinois' } })
    })
    expect(screen.getByRole('heading', { name: 'Tusk' })).toBeTruthy()
    expect(screen.getByText('2 record stores in Chicago')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('the logo goes home and cancels a search in progress', async () => {
    const albums = controllable()
    api.searchAlbums.mockImplementation(albums.impl)
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await user.click(screen.getByRole('link', { name: 'Album Finder home' }))

    expect(albums.calls[0].signal.aborted).toBe(true)
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    expect(location.pathname + location.search).toBe('/')
    expect(['Album', 'Artist', 'City', 'State'].map((n) => field(n).value)).toEqual(['', '', '', ''])
    await act(() => Promise.resolve())
    expect(screen.queryByLabelText('Loading results')).toBeNull()
  })

  test('the logo still opens a new tab on a modified click', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    fireEvent.click(screen.getByRole('link', { name: 'Album Finder home' }), { metaKey: true })
    expect(screen.getByRole('heading', { name: 'Rumours' })).toBeTruthy()
  })
})

describe('errors', () => {
  test('a failed search can be retried, and the retry repeats the search that failed', async () => {
    api.searchAlbums.mockRejectedValueOnce(new Error('MusicBrainz is busy'))
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch('MusicBrainz is busy')

    await user.clear(field('Album'))
    await user.type(field('Album'), 'Half typed')
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(api.searchAlbums).toHaveBeenLastCalledWith('Rumours', '', expect.any(AbortSignal))
    expect(await screen.findByRole('heading', { name: 'Rumours' })).toBeTruthy()
  })
})

describe('artist search', () => {
  test('lists the artist’s albums; picking one narrows the search and back returns', async () => {
    api.searchAlbums.mockResolvedValue([album('r1', 'OK Computer', 'Radiohead'), album('r2', 'Kid A', 'Radiohead')])
    render(<App />)
    await search({ artist: 'radiohead', city: 'London' })

    expect(await screen.findByRole('heading', { name: 'Radiohead' })).toBeTruthy()
    expect(screen.getByText(/what they have by Radiohead/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Kid A, 1977' }))
    expect(screen.getByRole('heading', { name: 'Kid A' })).toBeTruthy()
    expect(screen.getByText(/whether they have Kid A/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '← All albums by Radiohead' }))
    expect(screen.getByRole('heading', { name: 'Radiohead' })).toBeTruthy()
  })
})

describe('album covers', () => {
  test('a cover that failed to load does not stop the next album’s cover from loading', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    const header = () => screen.getByRole('heading', { name: /Rumours|Tusk/ }).closest('section')
    // The header's own cover, not the thumbnails in "Not the right album?".
    const mainCover = () => header().querySelector(':scope > .cover img')

    fireEvent.error(mainCover())
    expect(mainCover()).toBeNull()

    await user.click(screen.getByText('Not the right album?'))
    await user.click(screen.getByRole('button', { name: /Tusk/ }))
    expect(screen.getByRole('heading', { name: 'Tusk' })).toBeTruthy()
    const img = mainCover()
    expect(img?.getAttribute('src')).toBe('https://covers.test/a2.jpg')
    expect(img?.classList.contains('loaded')).toBe(false)
  })
})

describe('regressions', () => {
  test('choosing a store on the map scrolls its card into view', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    await user.click(screen.getByTestId('marker-node/2'))
    expect(screen.getByRole('button', { name: 'Far Records' }).getAttribute('aria-pressed')).toBe('true')
    const scrolledCard = Element.prototype.scrollIntoView.mock.contexts.at(-1)
    expect(scrolledCard?.textContent).toMatch('Far Records')
  })

  test('an artist search is headed by the artist’s usual credit, not a one-off duet', async () => {
    api.searchAlbums.mockResolvedValue([
      album('e1', 'Ella and Louis', 'Ella Fitzgerald & Louis Armstrong'),
      album('e2', 'Ella Sings Gershwin', 'Ella Fitzgerald'),
      album('e3', 'Ella in Berlin', 'Ella Fitzgerald'),
    ])
    render(<App />)
    await search({ artist: 'ella fitzgerald', city: 'Berlin' })
    expect(await screen.findByRole('heading', { name: 'Ella Fitzgerald' })).toBeTruthy()
  })
})

describe('messages', () => {
  const formAndAlert = () => {
    const form = screen.getByRole('button', { name: 'Find it' }).closest('form')
    return [form, screen.getByRole('alert')]
  }

  test('a missing field is reported right under the search form', async () => {
    render(<App />)
    await search({ city: 'Portland' })
    const [form, alert] = formAndAlert()
    expect(form.nextElementSibling).toBe(alert)
  })

  test('a failed search is reported right under the search form', async () => {
    api.searchAlbums.mockRejectedValueOnce(Object.assign(new Error('MusicBrainz is busy'), { status: 502 }))
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('alert')
    const [form, alert] = formAndAlert()
    expect(form.nextElementSibling).toBe(alert)
  })

  test.each([
    ['a busy server (502)', Object.assign(new Error('busy'), { status: 502 }), true],
    ['a timeout (504)', Object.assign(new Error('timed out'), { status: 504 }), true],
    ['a dropped connection', new TypeError('Failed to fetch'), true],
    ['an unknown city (404)', Object.assign(new Error('Couldn’t find a city'), { status: 404 }), false],
    ['a bad request (400)', Object.assign(new Error('Enter a city'), { status: 400 }), false],
  ])('"Try again" is offered for %s: %s', async (_, failure, offered) => {
    api.findStores.mockRejectedValueOnce(failure)
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    const alert = await screen.findByRole('alert')
    expect(within(alert).queryByRole('button', { name: 'Try again' }) !== null).toBe(offered)
  })
})

describe('browser history', () => {
  test('Back and Forward move between searches, and through the home page', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    api.searchAlbums.mockResolvedValue([TUSK])
    await search({ album: 'Tusk', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Tusk' })

    api.searchAlbums.mockResolvedValue([RUMOURS])
    await act(async () => history.back())
    expect(await screen.findByRole('heading', { name: 'Rumours' })).toBeTruthy()
    expect(field('Album').value).toBe('Rumours')
    expect(location.search).toBe('?album=Rumours&city=Portland')

    await user.click(screen.getByRole('link', { name: 'Album Finder home' }))
    expect(location.pathname + location.search).toBe('/')
    api.searchAlbums.mockResolvedValue([RUMOURS])
    await act(async () => history.back())
    expect(await screen.findByRole('heading', { name: 'Rumours' })).toBeTruthy()
    await act(async () => history.forward())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy())
    expect(field('Album').value).toBe('')
  })
})

describe('near me', () => {
  const geolocate = (outcome) => {
    navigator.geolocation = {
      getCurrentPosition: vi.fn((ok, fail) => (outcome.coords ? ok(outcome) : fail({ PERMISSION_DENIED: 1, ...outcome }))),
    }
  }

  test('searches near the visitor, rounded to about a kilometre', async () => {
    geolocate({ coords: { latitude: 45.52347, longitude: -122.67621 } })
    render(<App />)
    await user.type(field('Album'), 'Rumours')
    await user.click(screen.getByRole('button', { name: /Near me/ }))
    expect(api.findStoresNear).toHaveBeenCalledWith('45.52', '-122.68', '', expect.any(AbortSignal))
    expect(await screen.findByText('2 record stores near you')).toBeTruthy()
    expect(field('City').value).toBe('Your location')
    expect(location.search).toBe('?album=Rumours&near=45.52%2C-122.68')
  })

  test('typing a city replaces the location', async () => {
    geolocate({ coords: { latitude: 45.5, longitude: -122.6 } })
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Near me/ }))
    expect(field('City').value).toBe('Your location')
    await user.type(field('City'), 'Chicago') // focusing selects "Your location", so typing replaces it
    expect(field('City').value).toBe('Chicago')
    await search({ album: 'Rumours', city: 'Chicago' })
    expect(api.findStores).toHaveBeenCalledWith('Chicago', '', expect.any(AbortSignal))
  })

  test('explains a blocked location instead of failing silently', async () => {
    geolocate({ code: 1 })
    render(<App />)
    await user.click(screen.getByRole('button', { name: /Near me/ }))
    expect(screen.getByRole('alert').textContent).toMatch('Location access is blocked')
  })
})

describe('filters and views', () => {
  test('distance filter, in miles, with a count and a way back', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    const options = [...screen.getByLabelText(/Distance/).options].map((o) => o.textContent)
    expect(options).toEqual(['Any', 'Within 1 mi', 'Within 2 mi', 'Within 5 mi', 'Within 10 mi', 'Within 25 mi'])
    await user.selectOptions(screen.getByLabelText(/Distance/), 'Within 1 mi')
    expect(screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)).toEqual(['Near Records'])
    expect(screen.getByText(/Showing 1 of 2/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.getAllByRole('button', { name: /Records$/ })).toHaveLength(2)
  })

  test('"Within 1 mi" means a mile, not a kilometre', async () => {
    api.findStores.mockResolvedValue({
      ...PORTLAND,
      stores: [
        store(1, 'Inside Records', 1.5), // 0.93 mi, shown as 0.9 mi
        store(2, 'Edge Records', 1.62), // 1.007 mi, shown as 1.0 mi: it says 1.0, so it's within 1
        store(3, 'Outside Records', 1.7), // 1.06 mi, shown as 1.1 mi
      ],
    })
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    await user.selectOptions(screen.getByLabelText(/Distance/), 'Within 1 mi')
    expect(screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)).toEqual([
      'Inside Records',
      'Edge Records',
    ])
    expect([...document.querySelectorAll('.store .distance')].map((d) => d.textContent)).toEqual(['0.9 mi', '1.0 mi'])
  })

  test('store cards show distances in miles', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    const distances = [...document.querySelectorAll('.store .distance')].map((d) => d.textContent)
    expect(distances).toEqual(['0.2 mi', '3.2 mi']) // 0.4 km and 5.2 km
  })

  test('"Open now" uses the store’s own timezone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T17:30:00Z')) // Wednesday 10:30 in Portland
    api.findStores.mockResolvedValue({
      city: { ...PORTLAND.city, timezone: 'America/Los_Angeles' },
      stores: [
        { ...store(1, 'Weekday Records', 0.4), hours: 'Mo-Fr 10:00-18:00' },
        { ...store(2, 'Saturday Records', 0.9), hours: 'Sa 11:00-17:00' },
      ],
    })
    try {
      render(<App />)
      await search({ album: 'Rumours', city: 'Portland' })
      await screen.findByRole('heading', { name: 'Rumours' })
      expect(screen.getByText('Open now · until 6:00pm')).toBeTruthy()
      expect(screen.getByText('Closed now')).toBeTruthy()
      expect(screen.getByText('Mon–Fri 10:00am–6:00pm · Sat–Sun closed')).toBeTruthy()
      await user.click(screen.getByRole('checkbox', { name: /Open now/ }))
      expect(screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)).toEqual(['Weekday Records'])
    } finally {
      vi.useRealTimers()
    }
  })

  test('phones can switch between the list and the map', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
    const layout = () => screen.getByTestId('map').parentElement
    expect(layout().className).toMatch('view-list')
    await user.click(screen.getByRole('button', { name: 'Map' }))
    expect(layout().className).toMatch('view-map')
    expect(screen.getByText(/Tap a shop on the map/)).toBeTruthy()
    await user.click(screen.getByTestId('marker-node/1'))
    expect(screen.queryByText(/Tap a shop on the map/)).toBeNull()
  })

  test('"Missing a shop?" opens the OpenStreetMap editor at the city', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    const link = await screen.findByRole('link', { name: 'Add it to OpenStreetMap' })
    expect(link.getAttribute('href')).toBe('https://www.openstreetmap.org/edit#map=15/45.5/-122.6')
  })
})

describe('suggestions', () => {
  test('appear as you type, and picking an album fills in its artist', async () => {
    api.suggest.mockImplementation(async (fieldName) =>
      fieldName === 'album' ? [{ value: 'Rumours', detail: 'Fleetwood Mac' }] : [],
    )
    render(<App />)
    await user.type(field('Album'), 'Rumo')
    await waitFor(() => expect(document.querySelectorAll('#album-suggestions option')).toHaveLength(1))
    const option = document.querySelector('#album-suggestions option')
    expect([option.value, option.label]).toEqual(['Rumours', 'Fleetwood Mac'])
    expect(api.suggest).toHaveBeenCalledWith('album', 'Rumo', '', expect.any(AbortSignal))

    await user.type(field('Album'), 'urs') // as if the suggestion were picked
    expect(field('Artist').value).toBe('Fleetwood Mac')
  })

  test('picking a city suggestion puts the city and the state in their own boxes', async () => {
    api.suggest.mockImplementation(async (fieldName) =>
      fieldName === 'city'
        ? [
            { value: 'Portland, Oregon', detail: 'United States', city: 'Portland', state: 'OR' },
            { value: 'Portland, Maine', detail: 'United States', city: 'Portland', state: 'ME' },
          ]
        : [],
    )
    render(<App />)
    await user.type(field('City'), 'Portl')
    await waitFor(() => expect(document.querySelectorAll('#city-suggestions option')).toHaveLength(2))
    expect([...document.querySelectorAll('#city-suggestions option')].map((o) => o.value)).toEqual([
      'Portland, Oregon',
      'Portland, Maine',
    ])
    await user.type(field('City'), 'and, Maine') // as if "Portland, Maine" were picked
    expect(field('City').value).toBe('Portland')
    expect(field('State').value).toBe('ME')

    await search({ album: 'Rumours', city: 'Portland', state: 'ME' })
    expect(api.findStores).toHaveBeenCalledWith('Portland', 'ME', expect.any(AbortSignal))
  })

  test('typing a city with a comma yourself is left as typed', async () => {
    api.suggest.mockResolvedValue([])
    render(<App />)
    await user.type(field('City'), 'Portland, ME')
    expect(field('City').value).toBe('Portland, ME')
    expect(field('State').value).toBe('')
  })

  test('not asked for until three characters', async () => {
    render(<App />)
    await user.type(field('Artist'), 'Ra')
    await new Promise((r) => setTimeout(r, 400))
    expect(api.suggest).not.toHaveBeenCalled()
  })
})

describe('stock', () => {
  test('shops with the album in stock come first, with price, condition and source', async () => {
    api.findStock.mockResolvedValue(report({ stock: {
      'node/2': [
        {
          source: 'discogs',
          title: 'Rumours',
          format: 'LP, Album',
          condition: 'Very Good Plus (VG+)',
          price: 22,
          currency: 'USD',
          url: 'https://www.discogs.com/sell/item/1',
        },
      ],
      'node/1': [{ source: 'discogs', title: 'Rumours', format: 'LP', condition: 'Mint (M)', price: 25, currency: 'GBP' }],
    } }))
    render(<App />)
    await search({ album: 'Rumours', artist: 'Fleetwood Mac', city: 'Portland' })
    expect(await screen.findAllByText('In stock')).toHaveLength(2)
    expect(api.findStock).toHaveBeenCalledWith('Rumours', 'Fleetwood Mac', expect.any(AbortSignal))
    expect(screen.getByText(/2 have it listed in stock/)).toBeTruthy()
    expect(screen.getByText('£25.00')).toBeTruthy()
    expect(screen.getByText('$22.00')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'On the shop’s Discogs page' }).getAttribute('href')).toBe(
      'https://www.discogs.com/sell/item/1',
    )
  })

  test('a shop with stock is listed before nearer shops without', async () => {
    api.findStock.mockResolvedValue(report({ stock: { 'node/2': [{ source: 'discogs', title: 'Rumours', format: 'LP' }] } }))
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByText('In stock')
    expect(screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)).toEqual(['Far Records', 'Near Records'])
  })

  test('the stock lookup gets the album title and artist intact, even with a "|" in the title', async () => {
    api.searchAlbums.mockResolvedValue([album('p1', 'Side A | Side B', 'Some Band')])
    render(<App />)
    await search({ album: 'Side A | Side B', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Side A | Side B' })
    expect(api.findStock).toHaveBeenCalledWith('Side A | Side B', 'Some Band', expect.any(AbortSignal))
  })

  test('a stock lookup failure leaves the store list as it is', async () => {
    api.findStock.mockRejectedValue(new Error('down'))
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    expect(await screen.findByText('2 record stores in Portland')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('what verified shops have for the search', () => {
  const item = (title, extra = {}) => ({ source: 'discogs', title, format: 'LP', ...extra })
  const FOUR = {
    ...PORTLAND,
    stores: [store(1, 'Nearest Records', 0.1), { ...store(2, 'Second Records', 1), website: 'https://second.example' }, store(3, 'Third Records', 2), store(4, 'Fourth Records', 3)],
  }
  // 4 has the album, 3 only other Fleetwood Mac, 2 has neither, and 1 has no inventory to look in.
  const MIXED = report({
    stock: { 'node/4': [item('Rumours', { price: 22, currency: 'USD' })] },
    others: { 'node/3': [item('Tusk'), item('Mirage')] },
    checked: ['node/2', 'node/3', 'node/4'],
  })
  const card = (name) => screen.getByRole('button', { name }).closest('li')

  async function searchRumours() {
    api.findStores.mockResolvedValue(FOUR)
    render(<App />)
    await search({ album: 'Rumours', artist: 'Fleetwood Mac', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
  }

  test('a shop with the album is marked in stock, with what it has', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    await within(card('Fourth Records')).findByText('In stock')
    expect(within(card('Fourth Records')).getByText('$22.00')).toBeTruthy()
  })

  test('a shop with other records by the artist but not the album says so, and lists them', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    const third = within(card('Third Records'))
    expect(await third.findByText('Sells other works by Fleetwood Mac')).toBeTruthy()
    expect(third.getByText('Tusk')).toBeTruthy()
    expect(third.getByText('Mirage')).toBeTruthy()
    expect(third.queryByText('In stock')).toBeNull()
  })

  test('a shop with neither the album nor the artist says that, and to check its website', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    const second = within(card('Second Records'))
    const note = await second.findByText(/No Rumours or other records by Fleetwood Mac in their Discogs stock/)
    expect(note.textContent).toMatch(/Their Discogs listings may not show everything on the shelf, so check their website\./)
    expect(second.getByRole('link', { name: 'check their website' }).getAttribute('href')).toBe('https://second.example')
  })

  test('without a website, the note says to call ahead instead', async () => {
    api.findStock.mockResolvedValue(report({ checked: ['node/1'] }))
    await searchRumours()
    const note = await within(card('Nearest Records')).findByText(/No Rumours or other records/)
    expect(note.textContent).toMatch(/so call ahead to check\./)
    expect(within(card('Nearest Records')).queryByRole('link', { name: 'check their website' })).toBeNull()
  })

  test('shops with the album or other works by the artist get no such note', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    await within(card('Fourth Records')).findByText('In stock')
    for (const name of ['Fourth Records', 'Third Records', 'Nearest Records']) {
      expect(within(card(name)).queryByText(/may not show everything/)).toBeNull()
    }
  })

  test('a shop without an inventory to search says nothing either way', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    await within(card('Fourth Records')).findByText('In stock')
    const first = card('Nearest Records')
    expect(within(first).queryByText(/In stock|Sells other works|in their Discogs stock/)).toBeNull()
  })

  test('shops are ordered: the album, then other works by the artist, then the rest nearest first', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    await screen.findAllByText('In stock')
    expect(screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)).toEqual([
      'Fourth Records',
      'Third Records',
      'Nearest Records',
      'Second Records',
    ])
  })

  test('the summary counts both', async () => {
    api.findStock.mockResolvedValue(MIXED)
    await searchRumours()
    expect(await screen.findByText(/1 has it listed in stock\. 1 more sells other records by Fleetwood Mac\./)).toBeTruthy()
  })

  test('for an artist search, a shop without their records says so', async () => {
    history.replaceState(null, '', '/?artist=Radiohead&city=Portland')
    api.searchAlbums.mockResolvedValue([album('r1', 'OK Computer', 'Radiohead')])
    api.findStock.mockResolvedValue(report({ checked: ['node/1'] }))
    render(<App />)
    await screen.findByRole('button', { name: 'Near Records' })
    expect(await within(card('Near Records')).findByText(/^No records by Radiohead in their Discogs stock\./)).toBeTruthy()
  })

  test('asks again while inventories are downloading, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      history.replaceState(null, '', '/?album=Rumours&artist=Fleetwood+Mac&city=Portland')
      api.findStores.mockResolvedValue(FOUR)
      api.findStock.mockResolvedValueOnce(report({ pending: 2 })).mockResolvedValue(MIXED)
      render(<App />)
      await screen.findByText('4 record stores in Portland')
      await waitFor(() => expect(api.findStock).toHaveBeenCalledTimes(1))
      expect((await screen.findByRole('status')).textContent).toMatch(/Checking shops on Discogs/)
      await act(() => vi.advanceTimersByTimeAsync(15000))
      expect(await screen.findAllByText('In stock')).toHaveLength(1)
      expect(screen.queryByRole('status')).toBeNull()
      await act(() => vi.advanceTimersByTimeAsync(60000))
      expect(api.findStock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('asks again when another shop is confirmed on Discogs', async () => {
    const check = controllable()
    api.findVerification.mockImplementation(check.impl)
    api.findStock.mockResolvedValue(report())
    await searchRumours()
    await waitFor(() => expect(api.findStock).toHaveBeenCalledTimes(1))
    await act(async () => check.calls[0].resolve({ verified: { 'node/2': { seller: 'S', url: 'https://www.discogs.com/seller/S/profile' } }, pending: 0 }))
    await waitFor(() => expect(api.findStock).toHaveBeenCalledTimes(2))
  })
})

describe('a city with no shops listing their hours', () => {
  test('says so, and asks for the hours to be added', async () => {
    api.findStores.mockResolvedValue({ city: PORTLAND.city, stores: [] })
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    expect((await screen.findByText(/No record stores with opening hours are mapped/)).textContent).toMatch(/on OpenStreetMap yet/)
    expect(screen.queryByText(/Missing a shop\?/)).toBeNull()
  })
})

describe('vinyl sellers verified on Discogs', () => {
  const SELLER = { seller: 'NearRecords', url: 'https://www.discogs.com/seller/NearRecords/profile' }

  test('a verified shop gets a badge linking to its Discogs seller page; others get none', async () => {
    api.findVerification.mockResolvedValue({ verified: { 'node/1': SELLER }, pending: 0 })
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    const badge = await screen.findByRole('link', { name: 'Sells vinyl · Discogs' })
    expect(badge.getAttribute('href')).toBe(SELLER.url)
    expect(screen.getAllByRole('link', { name: 'Sells vinyl · Discogs' })).toHaveLength(1)
    expect(within(badge.closest('li')).getByRole('button', { name: 'Near Records' })).toBeTruthy()
  })

  test('asks for the nearest shops first', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByText('2 record stores in Portland')
    await waitFor(() => expect(api.findVerification).toHaveBeenCalled())
    expect(api.findVerification).toHaveBeenCalledWith(['node/1', 'node/2'], expect.any(AbortSignal))
  })

  const group = (name) => within(screen.getByRole('heading', { name }).closest('section'))
  const names = (scope) => scope.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)

  test('verified shops are listed apart from the others, each list nearest first', async () => {
    api.searchAlbums.mockResolvedValue([RUMOURS])
    api.findStores.mockResolvedValue({
      ...PORTLAND,
      stores: [store(3, 'Middle Records', 2), store(2, 'Far Records', 5.2), store(1, 'Near Records', 0.4), store(4, 'Nearest Records', 0.1)],
    })
    api.findVerification.mockResolvedValue({ verified: { 'node/2': SELLER, 'node/3': SELLER }, pending: 0 })
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: /Verified vinyl sellers/ })
    expect(names(group(/Verified vinyl sellers/))).toEqual(['Middle Records', 'Far Records'])
    expect(names(group(/Other record stores/))).toEqual(['Nearest Records', 'Near Records'])
    expect(group(/Verified vinyl sellers/).getAllByRole('link', { name: 'Sells vinyl · Discogs' })).toHaveLength(2)
    expect(group(/Other record stores/).queryByRole('link', { name: 'Sells vinyl · Discogs' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Verified vinyl sellers 2' })).toBeTruthy()
    expect(screen.getByText('4 record stores in Portland')).toBeTruthy()
  })

  test('with nothing verified there is one list and no group headings', async () => {
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByText('2 record stores in Portland')
    expect(screen.queryByRole('heading', { name: /Verified vinyl sellers|Other record stores/ })).toBeNull()
    expect(screen.getAllByRole('list').filter((l) => l.classList.contains('stores'))).toHaveLength(1)
    expect(screen.queryByRole('link', { name: 'Sells vinyl · Discogs' })).toBeNull()
  })

  test('with every shop verified there is only the verified list', async () => {
    api.findVerification.mockResolvedValue({ verified: { 'node/1': SELLER, 'node/2': SELLER }, pending: 0 })
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: /Verified vinyl sellers/ })
    expect(screen.queryByRole('heading', { name: /Other record stores/ })).toBeNull()
    expect(names(group(/Verified vinyl sellers/))).toEqual(['Near Records', 'Far Records'])
  })

  test('the distance filter applies to both lists', async () => {
    api.findVerification.mockResolvedValue({ verified: { 'node/2': SELLER }, pending: 0 })
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('heading', { name: /Verified vinyl sellers/ })
    await user.selectOptions(screen.getByLabelText('Distance'), '1')
    expect(screen.queryByRole('heading', { name: /Verified vinyl sellers/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /Records$/ }).map((b) => b.textContent)).toEqual(['Near Records'])
  })

  test('says so while shops are still being checked', async () => {
    const check = controllable()
    api.findVerification.mockImplementation(check.impl)
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByText('2 record stores in Portland')
    expect(screen.queryByRole('status')).toBeNull()
    await waitFor(() => expect(check.calls).toHaveLength(1))
    await act(async () => check.calls[0].resolve({ verified: {}, pending: 2 }))
    expect((await screen.findByRole('status')).textContent).toMatch(/Checking shops on Discogs/)
  })

  test('keeps asking while shops are still being checked, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      history.replaceState(null, '', '/?album=Rumours&city=Portland')
      api.findVerification
        .mockResolvedValueOnce({ verified: {}, pending: 2 })
        .mockResolvedValueOnce({ verified: { 'node/1': SELLER }, pending: 1 })
        .mockResolvedValue({ verified: { 'node/1': SELLER }, pending: 0 })
      render(<App />)
      await screen.findByText('2 record stores in Portland')
      await waitFor(() => expect(api.findVerification).toHaveBeenCalledTimes(1))
      expect(screen.queryByRole('link', { name: 'Sells vinyl · Discogs' })).toBeNull()
      await act(() => vi.advanceTimersByTimeAsync(15000))
      expect(await screen.findByRole('link', { name: 'Sells vinyl · Discogs' })).toBeTruthy()
      await act(() => vi.advanceTimersByTimeAsync(15000))
      expect(api.findVerification).toHaveBeenCalledTimes(3)
      await act(() => vi.advanceTimersByTimeAsync(60000))
      expect(api.findVerification).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  test('badges stay when the map moves to a new area', async () => {
    const MOVED = { city: { ...PORTLAND.city, near: true, area: 'Elsewhere', radiusKm: 5 }, stores: [store(1, 'Near Records', 0.4), store(9, 'New Records', 1)] }
    api.findVerification.mockResolvedValue({ verified: { 'node/1': SELLER }, pending: 0 })
    api.findStoresNear.mockResolvedValue(MOVED)
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    await screen.findByRole('link', { name: 'Sells vinyl · Discogs' })
    api.findVerification.mockResolvedValue({ verified: {}, pending: 0 })
    await act(async () => map.props.onMove({ lat: 45.6, lon: -122.7, radiusKm: 5 }))
    await screen.findByRole('button', { name: 'New Records' })
    expect(screen.getByRole('link', { name: 'Sells vinyl · Discogs' })).toBeTruthy()
  })

  test('a failed check leaves the store list as it is', async () => {
    api.findVerification.mockRejectedValue(new Error('down'))
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    expect(await screen.findByText('2 record stores in Portland')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('moving the map', () => {
  const SOHO = {
    city: { name: 'Soho, London', area: 'Soho, London', lat: 51.513, lon: -0.135, near: true, radiusKm: 5, timezone: 'Europe/London' },
    stores: [store(31, 'Sister Ray', 0.3), store(1, 'Near Records', 0.9)],
  }
  const moveMap = (view) => act(async () => map.props.onMove(view))
  const settle = () => act(() => new Promise((r) => setTimeout(r, 700))) // the map waits for movement to stop

  async function searchPortland() {
    render(<App />)
    await search({ album: 'Rumours', artist: 'Fleetwood Mac', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Rumours' })
  }

  test('shows the shops around the new center, and names the area', async () => {
    api.findStoresNear.mockResolvedValue(SOHO)
    await searchPortland()
    const fitKey = map.props.fitKey
    const historyLength = history.length

    await moveMap({ lat: 51.51347, lon: -0.13512, radiusKm: 4.2, zoom: 13 })
    await settle()

    expect(api.findStoresNear).toHaveBeenCalledWith('51.513', '-0.135', '4.2', expect.any(AbortSignal))
    expect(await screen.findByText('2 record stores around Soho, London')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Rumours' })).toBeTruthy() // the album stays
    expect(api.searchAlbums).toHaveBeenCalledTimes(1) // only the shops were looked up again
    expect(field('City').value).toBe('Soho, London')
    expect(location.search).toBe('?album=Rumours&artist=Fleetwood+Mac&near=51.513%2C-0.135&radius=5')
    expect(history.length).toBe(historyLength) // map moves don't pile up Back steps
    expect(map.props.fitKey).toBe(fitKey) // the map isn't re-zoomed under the visitor
    expect(map.props.area).toEqual({ lat: 51.513, lon: -0.135, radiusKm: 5 })
  })

  test('quick successive moves cause one lookup, for where the map stopped', async () => {
    api.findStoresNear.mockResolvedValue(SOHO)
    await searchPortland()
    await moveMap({ lat: 51.4, lon: -0.2, radiusKm: 5, zoom: 12 })
    await moveMap({ lat: 51.45, lon: -0.17, radiusKm: 5, zoom: 12 })
    await moveMap({ lat: 51.513, lon: -0.135, radiusKm: 5, zoom: 12 })
    await settle()
    expect(api.findStoresNear).toHaveBeenCalledTimes(1)
    expect(api.findStoresNear.mock.calls[0].slice(0, 2)).toEqual(['51.513', '-0.135'])
  })

  test('moving back to the area already shown doesn’t look it up again (and clears the zoom note)', async () => {
    api.findStoresNear.mockResolvedValue(SOHO)
    await searchPortland()
    const soho = { lat: 51.513, lon: -0.135, radiusKm: 40, zoom: 9 } // wider than 25 km: capped
    await moveMap(soho)
    await settle()
    await screen.findByText('2 record stores around Soho, London')
    await moveMap({ ...soho, radiusKm: 400, zoom: 7 }) // zoomed out: just a note
    expect(screen.getByText(/Zoom in to see the shops/)).toBeTruthy()
    await moveMap({ ...soho, radiusKm: 60, zoom: 8 }) // back in: same 25 km area as before
    await settle()
    expect(api.findStoresNear).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Zoom in to see the shops/)).toBeNull()
  })

  test('the map reporting the same area again mid-update doesn’t hide "Updating…"', async () => {
    let finish
    api.findStoresNear.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await searchPortland()
    const soho = { lat: 51.513, lon: -0.135, radiusKm: 30, zoom: 9 }
    await moveMap(soho)
    await settle()
    expect(screen.getByText(/Updating shops/)).toBeTruthy()
    await moveMap({ ...soho, radiusKm: 60, zoom: 8 }) // same capped area, while it's still loading
    await settle()
    expect(screen.getByText(/Updating shops/)).toBeTruthy()
    expect(api.findStoresNear).toHaveBeenCalledTimes(1)
    await act(async () => finish(SOHO))
    expect(screen.queryByText(/Updating shops/)).toBeNull()
    expect(screen.getByText('2 record stores around Soho, London')).toBeTruthy()
  })

  test('after a failed update, the same area can be tried again', async () => {
    api.findStoresNear.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 502 })).mockResolvedValue(SOHO)
    await searchPortland()
    const soho = { lat: 51.513, lon: -0.135, radiusKm: 5, zoom: 12 }
    await moveMap(soho)
    await settle()
    expect(screen.getByText(/Couldn’t update the shops/)).toBeTruthy()
    await moveMap(soho)
    await settle()
    expect(await screen.findByText('2 record stores around Soho, London')).toBeTruthy()
    expect(api.findStoresNear).toHaveBeenCalledTimes(2)
  })

  test('zoomed far out, it asks to zoom in instead of searching a huge area', async () => {
    await searchPortland()
    await moveMap({ lat: 50, lon: 0, radiusKm: 400, zoom: 6 })
    await settle()
    expect(api.findStoresNear).not.toHaveBeenCalled()
    expect(screen.getByText(/Zoom in to see the shops around here/)).toBeTruthy()
    expect(screen.getByText('2 record stores in Portland')).toBeTruthy() // results unchanged
  })

  test('while updating it says so; if the update fails the shops shown stay', async () => {
    let fail
    api.findStoresNear.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
    await searchPortland()
    await moveMap({ lat: 51.513, lon: -0.135, radiusKm: 5, zoom: 12 })
    await settle()
    expect(screen.getByText(/Updating shops/)).toBeTruthy()
    await act(async () => fail(Object.assign(new Error('busy'), { status: 502 })))
    expect(screen.getByText(/Couldn’t update the shops/)).toBeTruthy()
    expect(screen.getByText('2 record stores in Portland')).toBeTruthy()
  })

  test('a selected shop stays selected if it’s still in the new area', async () => {
    api.findStoresNear.mockResolvedValue(SOHO)
    await searchPortland()
    await user.click(screen.getByRole('button', { name: 'Near Records' }))
    await moveMap({ lat: 51.513, lon: -0.135, radiusKm: 5, zoom: 12 })
    await settle()
    await screen.findByText('2 record stores around Soho, London')
    expect(screen.getByRole('button', { name: 'Near Records' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('moves while a new search is loading are ignored', async () => {
    const albums = controllable()
    api.searchAlbums.mockImplementation(albums.impl)
    render(<App />)
    await search({ album: 'Rumours', city: 'Portland' })
    // No results yet, so no map either; the search finishes before any move could count.
    expect(screen.queryByTestId('map')).toBeNull()
    await act(async () => albums.calls[0].resolve([RUMOURS]))
    const fitKey = map.props.fitKey
    api.searchAlbums.mockResolvedValue([TUSK])
    await search({ album: 'Tusk', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Tusk' })
    expect(map.props.fitKey).not.toBe(fitKey) // a new search does fit the map to its shops
  })

  test('Back after moving the map returns to the search before', async () => {
    api.findStoresNear.mockResolvedValue(SOHO)
    await searchPortland()
    api.searchAlbums.mockResolvedValue([TUSK])
    await search({ album: 'Tusk', city: 'Portland' })
    await screen.findByRole('heading', { name: 'Tusk' })
    await moveMap({ lat: 51.513, lon: -0.135, radiusKm: 5, zoom: 12 })
    await settle()
    await screen.findByText('2 record stores around Soho, London')

    api.searchAlbums.mockResolvedValue([RUMOURS])
    await act(async () => history.back())
    expect(await screen.findByRole('heading', { name: 'Rumours' })).toBeTruthy()
    expect(screen.getByText('2 record stores in Portland')).toBeTruthy()
  })

  test('a link to a map area opens that area', async () => {
    api.findStoresNear.mockResolvedValue(SOHO)
    history.replaceState(null, '', '/?album=Rumours&near=51.513,-0.135&radius=5')
    render(<App />)
    expect(await screen.findByText('2 record stores around Soho, London')).toBeTruthy()
    expect(api.findStoresNear).toHaveBeenCalledWith('51.513', '-0.135', '5', expect.any(AbortSignal))
  })
})
