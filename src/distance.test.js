import { expect, test } from 'vitest'
import { formatMiles, roundedMiles, toMiles } from './distance.js'

test('converts kilometres to miles', () => {
  expect(toMiles(1.609344)).toBeCloseTo(1, 10)
  expect(toMiles(10)).toBeCloseTo(6.2137, 4)
  expect(toMiles(0)).toBe(0)
})

test('rounds to a tenth of a mile, as the cards show it', () => {
  expect(roundedMiles(1.62)).toBe(1) // 1.007 mi
  expect(roundedMiles(1.7)).toBe(1.1) // 1.056 mi
  expect(roundedMiles(0.05)).toBe(0)
})

test.each([
  [0.4, '0.2 mi'],
  [1.6, '1.0 mi'],
  [5.2, '3.2 mi'],
  [26.8, '16.7 mi'],
  [0.1, '0.1 mi'],
  [0.05, '< 0.1 mi'], // 0.03 mi: "0.0 mi" would read as "right here"
  [0, '< 0.1 mi'],
])('%s km shows as %s', (km, text) => {
  expect(formatMiles(km)).toBe(text)
})
