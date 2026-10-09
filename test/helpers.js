import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export const html = (status) => new Response('<html>busy</html>', { status, headers: { 'content-type': 'text/html' } })

/**
 * Replace global fetch with a router. `routes` maps a host (or `host/path`) to a
 * handler `(url, init) => Response`. Every call is recorded in `calls`.
 */
export function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ url, init })
    const handler = routes[`${url.host}${url.pathname}`] || routes[url.host]
    if (!handler) throw new Error(`Unexpected fetch to ${url}`)
    return handler(url, init)
  }
  return calls
}

/** Load server/api.js against a fresh, empty data directory. */
export async function loadApi() {
  const dir = await mkdtemp(join(tmpdir(), 'albumfinder-test-'))
  process.env.DATA_DIR = dir
  const api = await import('../server/api.js')
  return { api, dir }
}

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
