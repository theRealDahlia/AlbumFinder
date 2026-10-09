import { afterEach, expect, test, vi } from 'vitest'
import { findStores, searchAlbums } from './api.js'

afterEach(() => vi.unstubAllGlobals())

test('failed requests carry the server’s message and status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Couldn’t find a city called "X"' }, { status: 404 })))
  await expect(findStores('X', '')).rejects.toMatchObject({ message: 'Couldn’t find a city called "X"', status: 404 })
})

test('a non-JSON error page still gives a useful message and status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })))
  await expect(searchAlbums('Blue', '')).rejects.toMatchObject({ message: 'Request failed (502)', status: 502 })
})

test('passes the abort signal to fetch and the query in the URL', async () => {
  const fetch = vi.fn(async () => Response.json({ albums: [] }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  await searchAlbums('Blue', 'Joni Mitchell', signal)
  expect(fetch).toHaveBeenCalledWith('/api/albums?album=Blue&artist=Joni+Mitchell', { signal })
})
