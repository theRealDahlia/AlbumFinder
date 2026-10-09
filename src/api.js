// Every call takes an optional AbortSignal, so a newer search can cancel an older one.
async function request(path, signal) {
  const res = await fetch(path, { signal })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status })
  return data
}

export const searchAlbums = (album, artist, signal) =>
  request(`/api/albums?${new URLSearchParams({ album, artist })}`, signal).then((d) => d.albums)

export const findStores = (city, state, signal) =>
  request(`/api/stores?${new URLSearchParams({ city, state })}`, signal)

/** Stores near a point: "Near me" without a radius, a map area (named by the server) with one. */
export const findStoresNear = (lat, lon, radius, signal) =>
  request(`/api/stores?${new URLSearchParams({ lat, lon, ...(radius && { radius }) })}`, signal)

export const suggest = (field, q, artist, signal) =>
  request(`/api/suggest?${new URLSearchParams({ field, q, artist })}`, signal).then((d) => d.suggestions)

/** What shops linked to Discogs have in stock: { [storeId]: [items] }. */
export const findStock = (album, artist, signal) =>
  request(`/api/stock?${new URLSearchParams({ album, artist })}`, signal).then((d) => d.stock)


/** Which of these shops are confirmed as vinyl sellers on Discogs: { verified: { [storeId]: { seller, url } }, pending }. */
export const findVerification = (ids, signal) =>
  request(`/api/verification?${new URLSearchParams({ ids: ids.join(',') })}`, signal)
