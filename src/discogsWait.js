import * as api from './api.js'

/** Fill in what a stock answer leaves out, so a server running older code can't break the page. */
export function normalizeStock(report) {
  const { stock = {}, others = {}, checked = [], pending = 0 } = report ?? {}
  return { stock, others, checked, pending }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Hold on for the Discogs checks (which shops sell vinyl, and what they have for the search), so
 * results appear already sorted out instead of changing in front of the visitor. Asks every
 * `pollMs` until nothing is left to check or `budgetMs` has passed; whatever isn't done by then
 * is reported as still pending, and the page carries on asking in the background.
 *
 * `onProgress(left)` is told how many checks remain. A failing request ends the wait quietly:
 * this is a bonus, never a reason for a search to fail.
 */
export async function settleDiscogs({ ids, stockQuery, signal, budgetMs, pollMs, onProgress, wait = sleep }) {
  const deadline = Date.now() + budgetMs
  let verified = {}
  let report = null
  let verifyPending = 0
  try {
    for (;;) {
      const answer = await api.findVerification(ids, signal)
      verified = { ...verified, ...answer.verified }
      verifyPending = answer.pending ?? 0
      // Stock waits on verification (its shops are the verified ones), but is asked for each time so
      // inventories begin downloading as soon as shops are confirmed.
      if (stockQuery) report = normalizeStock(await api.findStock(...stockQuery, signal))
      const left = verifyPending + (report?.pending ?? 0)
      onProgress?.(left)
      if (!left || Date.now() + pollMs >= deadline) break
      await wait(pollMs)
    }
  } catch {
    // Keep what was found. A cancelled search is noticed by the caller.
  }
  return { verified, report, verifyPending, stockPending: report?.pending ?? 0 }
}
