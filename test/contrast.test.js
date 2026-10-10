// Text colours must meet WCAG AA (4.5:1 for normal-size text) in both themes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** The custom properties declared in the first block after `marker`. */
function tokens(marker) {
  const start = css.indexOf(marker)
  const block = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(([, k, v]) => [k, v]))
}
const light = tokens(':root {')
const dark = { ...light, ...tokens('@media (prefers-color-scheme: dark)') }

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const PAIRS = [
  ['text', 'bg'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['accent', 'bg'], // links, labels, chip hover text
  ['accent', 'surface'], // store-card links
  ['accent-ink', 'accent'], // "Find it" button
  ['ok', 'bg'], // "Open now"
  ['ok', 'surface'], // "Open now" on a store card
  ['closed', 'bg'], // "Closed"
  ['closed', 'surface'], // "Closed" on a store card
  ['ok', 'ok-bg'], // "In stock" heading and links
  ['text', 'ok-bg'], // stock listings
  ['muted', 'ok-bg'], // format and condition
  ['text', 'surface-2'], // other works by the artist: listings and links
]

for (const [name, theme] of [['light', light], ['dark', dark]]) {
  test(`${name} theme text meets WCAG AA contrast`, () => {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(theme[fg], theme[bg])
      assert.ok(ratio >= 4.5, `${fg} ${theme[fg]} on ${bg} ${theme[bg]} is ${ratio.toFixed(2)}:1`)
    }
  })
}

test('the "Closed" status on a store card is red, from the closed colour', () => {
  const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
  assert.match(appCss, /\.open-status\.closed\s*\{\s*color:\s*var\(--closed\);?\s*\}/)
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.closed.slice(i, i + 2), 16))
    assert.ok(r > 150 && r > g * 1.8 && r > b * 1.8, `${name} closed colour ${theme.closed} should read as red`)
  }
})
