import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const MARKER_COLOR = '#d9772b'
// The map moves itself (fitting to results, centering a chosen shop, re-measuring); for this
// long afterwards a "moveend" is the map's doing, not the visitor's.
const OWN_MOVE_MS = 1000

/**
 * The store map. It fits itself to the stores whenever `fitKey` changes (a new search),
 * and otherwise stays where the visitor put it. When the visitor drags or zooms it,
 * `onMove` gets the new view: { lat, lon, radiusKm, zoom }, radiusKm being the largest
 * circle around the center that's fully visible. `area` ({ lat, lon, radiusKm }) draws a
 * dashed outline of the area searched; `status` shows a note over the map.
 */
export default function StoreMap({ center, stores, selectedId, onSelect, fitKey, onMove, area, status }) {
  const el = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const circle = useRef(null)
  const markers = useRef(new Map())
  // The latest props, for the map's own event handlers (set up once) and for fitting.
  const latest = useRef({ stores, center, onMove })
  const ownMoveUntil = useRef(0)
  // Fitting needs the map's size. While it's hidden (the phone List view), remember to fit
  // and do it when it's shown.
  const pendingFit = useRef(false)

  const byCode = (move) => {
    ownMoveUntil.current = Date.now() + OWN_MOVE_MS
    move()
  }

  const fit = () => {
    if (!el.current.clientWidth || !el.current.clientHeight) {
      pendingFit.current = true
      return
    }
    pendingFit.current = false
    const { stores: shown, center: middle } = latest.current
    const points = shown.map((s) => [s.lat, s.lon])
    byCode(() =>
      points.length
        ? map.current.fitBounds(points, { padding: [30, 30], maxZoom: 15 })
        : map.current.setView([middle.lat, middle.lon], 12),
    )
  }

  // Declared first, so the effects below see this render's props.
  useEffect(() => {
    latest.current = { stores, center, onMove }
  })

  useEffect(() => {
    // Leaflet's fling speed is unlimited by default: a quick flick could throw the map (and
    // so the area searched) hundreds of kilometres. Capped, a fling glides at most about a
    // map's width.
    const m = L.map(el.current, { scrollWheelZoom: false, inertiaMaxSpeed: 800 })
    map.current = m
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m)
    layer.current = L.layerGroup().addTo(m)
    m.on('dragstart', () => {
      ownMoveUntil.current = 0 // the visitor took over
    })
    m.on('moveend', () => {
      if (Date.now() < ownMoveUntil.current) return
      const c = m.getCenter()
      const b = m.getBounds()
      const radiusKm = Math.min(c.distanceTo([b.getNorth(), c.lng]), c.distanceTo([c.lat, b.getEast()])) / 1000
      latest.current.onMove?.({ lat: c.lat, lon: c.lng, radiusKm, zoom: m.getZoom() })
    })
    // Leaflet measures its box once; when it's resized or shown again (the phone List/Map
    // toggle hides it), it has to re-measure or it draws grey tiles.
    const resized = new ResizeObserver(() => {
      byCode(() => m.invalidateSize())
      if (pendingFit.current) fit()
    })
    resized.observe(el.current)
    return () => {
      resized.disconnect()
      m.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once; reads the latest props via refs
  }, [])

  useEffect(() => {
    layer.current.clearLayers()
    markers.current.clear()
    for (const s of stores) {
      const marker = L.circleMarker([s.lat, s.lon], {
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: MARKER_COLOR,
        fillOpacity: 0.95,
      })
        // Leaflet renders string tooltips as HTML; store names come from OpenStreetMap, so pass text.
        .bindTooltip(Object.assign(document.createElement('span'), { textContent: s.name }))
        .on('click', () => onSelect(s.id))
        .addTo(layer.current)
      markers.current.set(s.id, marker)
    }
  }, [stores, onSelect])

  // Fit to the stores for each new search, not when the list changes as the map is moved.
  useEffect(() => {
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new search should move the map
  }, [fitKey])

  useEffect(() => {
    circle.current?.remove()
    circle.current = area
      ? L.circle([area.lat, area.lon], {
          radius: area.radiusKm * 1000,
          color: MARKER_COLOR,
          weight: 2,
          dashArray: '6 6',
          fill: false,
          interactive: false,
        }).addTo(map.current)
      : null
  }, [area?.lat, area?.lon, area?.radiusKm]) // eslint-disable-line react-hooks/exhaustive-deps -- the area's values, not its identity

  useEffect(() => {
    for (const [id, m] of markers.current) {
      m.setStyle({ color: id === selectedId ? '#111' : '#fff', weight: id === selectedId ? 3 : 2 })
      if (id === selectedId) {
        m.bringToFront()
        byCode(() => map.current.panTo(m.getLatLng()))
      }
    }
  }, [selectedId, stores])

  return (
    <div className="map" role="region" aria-label="Map of record stores">
      <div ref={el} className="map-canvas" />
      {status && (
        <p className={`map-status ${status.kind}`} role="status">
          {status.text}
        </p>
      )}
    </div>
  )
}
