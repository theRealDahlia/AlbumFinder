import { describe, expect, test } from 'vitest'
import { describeHours, openStatus, parseHours } from './hours.js'

// 2026-10-07 is a Wednesday.
const at = (iso) => new Date(iso)

describe('parseHours', () => {
  test.each([
    'Mo-Sa 10:00-18:00',
    'Mo-We 10:00-22:00;Th-Sa 10:00-23:00;Su 12:00-18:00',
    'Mo,We,Fr 09:00-12:00,13:00-17:00',
    'Mo-Fr 10:00-18:00; Sa 10:00-16:00; Su off',
    '24/7',
    'Fr-Sa 22:00-02:00',
    '10:00-18:00',
    'Mo-Su 11:00-19:00; PH off',
    'Tu-Sa 11:00-19:00; Su,Mo closed',
    // Common in real data, though not strictly by the book:
    'Mo-Sa 10:00-19:00, Su 11:00-17:00', // comma between rules
    'Tu 12:00-19:00; Fr-Sa 12:00-27:00', // past midnight written as 27:00
    'Mo-Su 11:00-19:00 open', // redundant "open"
  ])('understands %s', (text) => {
    expect(parseHours(text)).not.toBeNull()
  })

  test.each([
    'Jan-Mar Mo-Fr 10:00-16:00', // months
    'Mo-Fr 10:00+', // open end
    'Mo-Fr sunrise-sunset',
    'by appointment',
    'Mo-Fr 10:00-18:00 || "call ahead"',
    'Mo 10:00-40:00', // longer than a day
    '',
    null,
  ])('gives up on %s rather than guess', (text) => {
    expect(parseHours(text)).toBeNull()
  })
})

describe('describeHours', () => {
  test.each([
    ['Mo-Sa 10:00-18:00', 'Mon–Sat 10:00am–6:00pm · Sun closed'],
    ['Mo-We 10:00-22:00;Th-Sa 10:00-23:00;Su 12:00-18:00', 'Mon–Wed 10:00am–10:00pm · Thu–Sat 10:00am–11:00pm · Sun 12:00pm–6:00pm'],
    ['Mo,We,Fr 09:00-12:00,13:00-17:00', 'Mon 9:00am–12:00pm, 1:00pm–5:00pm · Tue closed · Wed 9:00am–12:00pm, 1:00pm–5:00pm · Thu closed · Fri 9:00am–12:00pm, 1:00pm–5:00pm · Sat–Sun closed'],
    ['24/7', 'Open 24/7'],
    ['10:00-18:00', 'Daily 10:00am–6:00pm'],
    ['Mo-Su 11:00-19:00; Tu off', 'Mon 11:00am–7:00pm · Tue closed · Wed–Sun 11:00am–7:00pm'],
    ['Mo-Sa 10:30-19:30, Su 14:00-19:30', 'Mon–Sat 10:30am–7:30pm · Sun 2:00pm–7:30pm'],
    ['Mo,We 10:00-12:00,13:00-17:00', 'Mon 10:00am–12:00pm, 1:00pm–5:00pm · Tue closed · Wed 10:00am–12:00pm, 1:00pm–5:00pm · Thu–Sun closed'],
    ['Fr-Sa 12:00-27:00', 'Mon–Thu closed · Fri–Sat 12:00pm–3:00am · Sun closed'],
    // 12-hour edge cases: noon, midnight, and the hour after midnight.
    ['Mo-Su 00:00-24:00', 'Open 24 hours'],
    ['Mo-Fr 00:00-24:00; Sa 10:00-14:00', 'Mon–Fri open 24 hours · Sat 10:00am–2:00pm · Sun closed'],
    ['Mo-Su 00:30-12:15', 'Daily 12:30am–12:15pm'],
    ['Fr 20:00-01:00', 'Mon–Thu closed · Fri 8:00pm–1:00am · Sat–Sun closed'],
  ])('%s → %s', (text, readable) => {
    expect(describeHours(parseHours(text))).toBe(readable)
  })
})

describe('openStatus', () => {
  const rules = parseHours('Mo-Fr 10:00-18:00; Sa 11:00-17:00; Su off')

  test('open, with the closing time, in the store’s own timezone', () => {
    // 17:30 UTC on Wednesday is 10:30 in Portland (UTC-7).
    expect(openStatus(rules, at('2026-10-07T17:30:00Z'), 'America/Los_Angeles')).toEqual({ open: true, until: '6:00pm' })
  })

  test('closed, with the next opening today if there is one', () => {
    // 15:00 UTC is 08:00 in Portland: before opening.
    expect(openStatus(rules, at('2026-10-07T15:00:00Z'), 'America/Los_Angeles')).toEqual({ open: false, opens: '10:00am' })
    // 02:00 UTC Thursday is 19:00 Wednesday in Portland: done for the day.
    expect(openStatus(rules, at('2026-10-08T02:00:00Z'), 'America/Los_Angeles')).toEqual({ open: false, opens: null })
  })

  test('the same moment can be open in one city and closed in another', () => {
    const moment = at('2026-10-07T17:30:00Z') // 10:30 Portland, 02:30 Thursday Tokyo
    expect(openStatus(rules, moment, 'America/Los_Angeles').open).toBe(true)
    expect(openStatus(rules, moment, 'Asia/Tokyo').open).toBe(false)
  })

  test('overnight hours run past midnight into the next day', () => {
    const late = parseHours('Fr-Sa 22:00-02:00')
    // 01:00 Saturday in London (BST, UTC+1) = 00:00 UTC Saturday.
    expect(openStatus(late, at('2026-10-10T00:00:00Z'), 'Europe/London')).toEqual({ open: true, until: '2:00am' })
    // 01:00 Friday is still Thursday night: closed.
    expect(openStatus(late, at('2026-10-09T00:00:00Z'), 'Europe/London').open).toBe(false)
  })

  test('hours written past 24:00 run into the next morning', () => {
    const late = parseHours('Fr-Sa 12:00-27:00')
    // 02:00 Sunday in Berlin (CEST, UTC+2) = 00:00 UTC Sunday: still Saturday night's opening.
    expect(openStatus(late, at('2026-10-11T00:00:00Z'), 'Europe/Berlin')).toEqual({ open: true, until: '3:00am' })
  })

  test('24/7 is always open; unknown hours give no status', () => {
    expect(openStatus(parseHours('24/7'), at('2026-10-07T03:00:00Z'), 'UTC')).toEqual({ open: true, until: null })
    expect(openStatus(null, at('2026-10-07T03:00:00Z'), 'UTC')).toBeNull()
  })

  test('falls back to the visitor’s timezone when the store’s is unknown', () => {
    expect(openStatus(rules, at('2026-10-07T17:30:00Z'), null)).not.toBeNull()
  })
})
