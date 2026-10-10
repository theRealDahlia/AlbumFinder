import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as api from './api.js'
import { normalizeStock, settleDiscogs } from './discogsWait.js'

vi.mock('./api.js', () => ({ findVerification: vi.fn(), findStock: vi.fn() }))

const SELLER = { seller: 'S', url: 'https://www.discogs.com/seller/S/profile' }
const noWait = vi.fn(() => Promise.resolve())
const ask = (extra = {}) =>
  settleDiscogs({ ids: ['node/1', 'node/2'], stockQuery: ['Rumours', 'Fleetwood Mac'], signal: undefined, budgetMs: 40000, pollMs: 2000, wait: noWait, ...extra })

beforeEach(() => {
  vi.resetAllMocks()
  noWait.mockImplementation(() => Promise.resolve())
})

describe('normalizeStock', () => {
  test('fills in whatever an answer leaves out', () => {
    expect(normalizeStock({ stock: { 'node/1': [] } })).toEqual({ stock: { 'node/1': [] }, others: {}, checked: [], pending: 0 })
    expect(normalizeStock(undefined)).toEqual({ stock: {}, others: {}, checked: [], pending: 0 })
  })
})

describe('settleDiscogs', () => {
  test('asks once when everything is already known', async () => {
    api.findVerification.mockResolvedValue({ verified: { 'node/1': SELLER }, pending: 0 })
    api.findStock.mockResolvedValue({ stock: { 'node/1': [{ title: 'Rumours' }] }, others: {}, checked: ['node/1'], pending: 0 })
    const result = await ask()
    expect(api.findVerification).toHaveBeenCalledTimes(1)
    expect(api.findVerification).toHaveBeenCalledWith(['node/1', 'node/2'], undefined)
    expect(api.findStock).toHaveBeenCalledWith('Rumours', 'Fleetwood Mac', undefined)
    expect(result).toMatchObject({ verified: { 'node/1': SELLER }, verifyPending: 0, stockPending: 0 })
    expect(result.report.stock['node/1']).toHaveLength(1)
    expect(noWait).not.toHaveBeenCalled()
  })

  test('keeps asking, every poll, until nothing is left, and reports the progress', async () => {
    api.findVerification
      .mockResolvedValueOnce({ verified: {}, pending: 2 })
      .mockResolvedValueOnce({ verified: { 'node/1': SELLER }, pending: 1 })
      .mockResolvedValue({ verified: { 'node/1': SELLER, 'node/2': SELLER }, pending: 0 })
    api.findStock.mockResolvedValueOnce({ pending: 0 }).mockResolvedValueOnce({ pending: 1 }).mockResolvedValue({ pending: 0 })
    const progress = vi.fn()
    const result = await ask({ onProgress: progress })
    expect(progress.mock.calls.map((c) => c[0])).toEqual([2, 2, 0])
    expect(noWait).toHaveBeenCalledTimes(2)
    expect(noWait).toHaveBeenCalledWith(2000)
    expect(Object.keys(result.verified)).toEqual(['node/1', 'node/2'])
    expect(api.findStock).toHaveBeenCalledTimes(3) // each time: inventories begin downloading as shops are confirmed
  })

  test('gives up when the time limit is near, and says what is still pending', async () => {
    vi.useFakeTimers()
    try {
      api.findVerification.mockResolvedValue({ verified: {}, pending: 3 })
      api.findStock.mockResolvedValue({ pending: 1 })
      const result = await ask({ wait: async (ms) => vi.setSystemTime(Date.now() + ms) })
      expect(api.findVerification.mock.calls.length).toBeGreaterThan(15)
      expect(api.findVerification.mock.calls.length).toBeLessThan(22)
      expect(result).toMatchObject({ verifyPending: 3, stockPending: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  test('with no search to look up stock for, only the shops are checked', async () => {
    api.findVerification.mockResolvedValue({ verified: {}, pending: 0 })
    const result = await ask({ stockQuery: null })
    expect(api.findStock).not.toHaveBeenCalled()
    expect(result.report).toBeNull()
  })

  test('a failure ends the wait quietly, keeping what was found', async () => {
    api.findVerification.mockResolvedValueOnce({ verified: { 'node/1': SELLER }, pending: 1 }).mockRejectedValue(new Error('down'))
    api.findStock.mockResolvedValue({ pending: 0 })
    const result = await ask()
    expect(result.verified).toEqual({ 'node/1': SELLER })
    expect(result.verifyPending).toBe(1)
  })
})
