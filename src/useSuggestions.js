import { useEffect, useState } from 'react'
import * as api from './api.js'

const DEBOUNCE_MS = 300

/**
 * Suggestions for a search field as the person types: waits for a pause, needs three
 * characters, and cancels requests that a newer keystroke has made pointless.
 * `field` is 'album', 'artist' or 'city'; `artist` narrows album suggestions.
 */
export function useSuggestions(field, text, { artist = '', enabled = true } = {}) {
  const [suggestions, setSuggestions] = useState([])
  const q = text.trim()
  const active = enabled && q.length >= 3

  useEffect(() => {
    if (!active) return
    const request = new AbortController()
    const timer = setTimeout(() => {
      api
        .suggest(field, q, artist.trim(), request.signal)
        .then(setSuggestions)
        .catch(() => {}) // suggestions are optional; an aborted or failed request just shows none
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      request.abort()
    }
  }, [field, q, artist, active])

  return active ? suggestions : []
}
