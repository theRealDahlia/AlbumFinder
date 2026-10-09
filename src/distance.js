// Distances come from the server in kilometres; the page shows miles.

const KM_PER_MILE = 1.609344

export const toMiles = (km) => km / KM_PER_MILE

/**
 * Miles to one decimal place, as shown on store cards. The distance filter uses this
 * too, so a shop whose card says "1.0 mi" is "within 1 mi".
 */
export const roundedMiles = (km) => Math.round(toMiles(km) * 10) / 10

/** "0.2 mi", "16.7 mi". Shops under a tenth of a mile away show "< 0.1 mi", not "0.0 mi". */
export function formatMiles(km) {
  const miles = roundedMiles(km)
  return miles === 0 ? '< 0.1 mi' : `${miles.toFixed(1)} mi`
}
