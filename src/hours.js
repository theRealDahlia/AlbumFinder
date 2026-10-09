// Opening hours in OpenStreetMap's format ("Mo-Fr 10:00-18:00; Sa 11:00-17:00; Su off"):
// readable text, and whether a shop is open right now in its own timezone.
//
// Only the common patterns are understood. Anything else (months, "sunrise", open-ended
// times, comments…) makes parseHours return null, so the raw text is shown instead of
// a possibly wrong "Open now".

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)'
const DAY_SPEC = new RegExp(`^${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*$`)
// Ends may be written past 24:00 ("12:00-27:00" is noon to 3am), as the format allows.
const TIME_RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([0-4]\d):([0-5]\d)$/

/** "Mo-We,Fr" → [0, 1, 2, 4]. Public and school holidays (PH, SH) aren't known, so they're skipped. */
function daysOf(spec) {
  const days = []
  for (const part of spec.split(',')) {
    const [from, to] = part.split('-')
    if (from === 'PH' || from === 'SH') continue
    const start = DAYS.indexOf(from)
    const end = to ? DAYS.indexOf(to) : start
    if (start < 0 || end < 0) return null
    for (let d = start; ; d = (d + 1) % 7) {
      days.push(d)
      if (d === end) break
    }
  }
  return days
}

/** "09:00-12:00,13:00-17:00" → [[540, 720], [780, 1020]] in minutes; overnight ends run past 1440. */
function timesOf(spec) {
  const intervals = []
  for (const range of spec.split(',')) {
    const m = range.match(TIME_RANGE)
    if (!m) return null
    const start = Number(m[1]) * 60 + Number(m[2])
    let end = Number(m[3]) * 60 + Number(m[4])
    if (start >= 1440) return null
    if (end <= start) end += 1440 // e.g. 22:00-02:00
    if (end - start > 1440) return null // longer than a day: a typo, not opening hours
    intervals.push([start, end])
  }
  return intervals
}

/**
 * The weekly schedule: { week: [[intervals for Monday], …, [Sunday]] }, or { always: true }
 * for "24/7", or null when the text isn't understood.
 */
export function parseHours(text) {
  if (!text || typeof text !== 'string') return null
  const clean = text
    .trim()
    .replace(/\s*-\s*/g, '-')
    .replace(/\s*,\s*/g, ',')
    // Commas between whole rules ("Mo-Sa 10:00-19:00, Su 11:00-17:00") are common in real
    // data; treat them like ";". (A comma between days or times, as in "Mo,We" or
    // "09:00-12:00,13:00-17:00", isn't preceded by a time or "off", so it's left alone.)
    .replace(/(\d|off|closed),(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)/g, '$1;')
  if (clean === '24/7') return { always: true }
  const week = Array.from({ length: 7 }, () => [])
  const rules = clean.split(';').map((r) => r.trim()).filter(Boolean)
  if (!rules.length) return null
  for (const rule of rules) {
    const parts = rule.split(/\s+/).filter((p) => p !== 'open') // "11:00-19:00 open" says nothing more
    if (parts.length > 2) return null
    const [first, second] = parts
    const hasDays = parts.length === 2 || DAY_SPEC.test(first)
    const daySpec = hasDays ? first : null
    const timeSpec = hasDays ? second : first
    if (hasDays && !DAY_SPEC.test(daySpec)) return null
    if (!timeSpec) return null // "Mo-Fr" alone: open, but when?
    const days = daySpec ? daysOf(daySpec) : [0, 1, 2, 3, 4, 5, 6]
    if (!days) return null
    const intervals = timeSpec === 'off' || timeSpec === 'closed' ? [] : timesOf(timeSpec)
    if (!intervals) return null
    // A later rule replaces earlier ones for the days it names ("Mo-Su 11:00-19:00; Tu off").
    for (const d of days) week[d] = intervals
  }
  return { week }
}

/** Minutes past midnight as a 12-hour time: 780 → "1:00pm", 0 → "12:00am", 720 → "12:00pm". */
const clock = (minutes) => {
  const m = minutes % 1440 // overnight times run past 24:00
  const hour = Math.floor(m / 60)
  return `${hour % 12 || 12}:${String(m % 60).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`
}
const range = ([start, end]) => (start === 0 && end === 1440 ? 'open 24 hours' : `${clock(start)}–${clock(end)}`)
const dayText = (intervals) => (intervals.length ? intervals.map(range).join(', ') : 'closed')

/** "Mon–Sat 10:00–18:00 · Sun closed" */
export function describeHours(parsed) {
  if (!parsed) return null
  if (parsed.always) return 'Open 24/7'
  const texts = parsed.week.map(dayText)
  if (texts.every((t) => t === texts[0]) && texts[0] !== 'closed') {
    return texts[0] === 'open 24 hours' ? 'Open 24 hours' : `Daily ${texts[0]}`
  }
  const groups = []
  texts.forEach((text, d) => {
    const last = groups.at(-1)
    if (last && last.text === text) last.to = d
    else groups.push({ from: d, to: d, text })
  })
  return groups
    .map((g) => `${DAY_NAMES[g.from]}${g.to > g.from ? `–${DAY_NAMES[g.to]}` : ''} ${g.text}`)
    .join(' · ')
}

/** The weekday (Monday = 0) and minutes past midnight at `now` in `timeZone`. */
function localTime(now, timeZone) {
  const options = { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timeZone || undefined }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(now) // unknown zone: the visitor's
  }
  const get = (type) => parts.find((p) => p.type === type)?.value
  return { day: DAY_NAMES.indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

/**
 * Whether the shop is open at `now`, in the shop's own timezone:
 * { open: true, until: '18:00' } or { open: false, opens: '10:00' | null }; null if unknown.
 */
export function openStatus(parsed, now, timeZone) {
  if (!parsed) return null
  if (parsed.always) return { open: true, until: null }
  const { day, minutes } = localTime(now, timeZone)
  if (day < 0) return null
  for (const [start, end] of parsed.week[day]) {
    if (start <= minutes && minutes < end) return { open: true, until: clock(end) }
  }
  // Still open from last night?
  for (const [, end] of parsed.week[(day + 6) % 7]) {
    if (end > 1440 && minutes < end - 1440) return { open: true, until: clock(end) }
  }
  const later = parsed.week[day].find(([start]) => start > minutes)
  return { open: false, opens: later ? clock(later[0]) : null }
}
