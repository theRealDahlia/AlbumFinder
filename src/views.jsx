// Presentational pieces of the page: album/artist headers, covers, the loading view.

import { useState } from 'react'

export function AlbumHeader({ album, albums, onChoose, onBack, backLabel }) {
  // Coming from an artist's albums, "back" replaces the alternatives list.
  const others = onBack ? [] : albums.filter((a) => a.id !== album.id)
  return (
    <section className="album">
      <Cover album={album} size="lg" />
      <div className="album-info">
        {onBack && (
          <button type="button" className="link back" onClick={onBack}>
            ← {backLabel}
          </button>
        )}
        <p className="eyebrow">Looking for</p>
        <h2>{album.title}</h2>
        <p className="artist">
          {album.artist}
          {album.year && ` · ${album.year}`}
          {album.kind !== 'Album' && ` · ${album.kind}`}
        </p>
        {others.length > 0 && (
          <details className="others">
            <summary>Not the right album?</summary>
            <ul>
              {others.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => onChoose(a)}>
                    <Cover album={a} size="sm" />
                    <span>
                      <strong>{a.title}</strong>
                      <small>
                        {a.artist}
                        {a.year && ` · ${a.year}`}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  )
}

export function ArtistHeader({ artist, albums, onChoose }) {
  return (
    <section className="artist-results">
      <p className="eyebrow">Looking for records by</p>
      <h2>{artist}</h2>
      <p className="artist">Popular albums. Pick one to look for it specifically.</p>
      <ul>
        {albums.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onChoose(a)} aria-label={`${a.title}${a.year ? `, ${a.year}` : ''}`}>
              <Cover album={a} size="grid" />
              <strong>{a.title}</strong>
              <small>
                {a.year}
                {a.kind !== 'Album' && ` · ${a.kind}`}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The front page's fanned stack of example covers, with a record peeking out.
 * Clicking a cover runs that example; the "Try" chips do the same for keyboards
 * and screen readers, so the stack itself is hidden from them.
 */
export function CoverStack({ examples, onPick }) {
  return (
    <div className="stack" aria-hidden="true">
      <div className="stack-record" />
      {examples.map((e, i) => (
        <button
          key={e.id}
          type="button"
          tabIndex={-1}
          className={`stack-cover stack-cover-${i}`}
          onClick={() => onPick(e)}
        >
          <Cover album={e} size="stacked" />
          <span className="stack-sticker">
            {e.title}
            <small>{e.place}</small>
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * Shown while a search loads: a turntable, the two lookups with a tick as each one
 * actually finishes, and a shimmering outline of the results to come.
 */
export function LoadingResults({ query, albumsDone, storesDone, discogsLeft }) {
  const what =
    query.album && query.artist
      ? `${query.album} by ${query.artist}`
      : query.album || `albums by ${query.artist}`
  const where = query.near
    ? query.radius
      ? 'around the map area'
      : 'near you'
    : `in ${query.state ? `${query.city}, ${query.state}` : query.city}`
  const steps = [
    { label: `Looking up ${what}`, done: albumsDone },
    { label: `Finding record stores ${where}`, done: storesDone },
  ]
  // Once the shops are known, Discogs is asked which sell vinyl and what they have; only shown when
  // that isn't already answered.
  if (albumsDone && storesDone && discogsLeft > 0) {
    steps.push({ label: `Checking ${discogsLeft} ${discogsLeft === 1 ? 'shop' : 'shops'} on Discogs`, done: false })
  }
  return (
    <section className="loading" aria-busy="true" aria-label="Loading results">
      <div className="loading-status">
        <Turntable />
        <ol className="loading-steps" aria-live="polite">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? 'done' : ''}>
              <span className="step-icon" aria-hidden="true">
                {s.done ? '✓' : ''}
              </span>
              {s.label}
              <span className="visually-hidden">{s.done ? ' – done' : ' – in progress'}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="skeleton" aria-hidden="true">
        <div className="sk-album">
          <div className="sk-block sk-cover" />
          <div className="sk-lines">
            <div className="sk-block sk-line" style={{ width: '22%' }} />
            <div className="sk-block sk-line sk-title" style={{ width: '48%' }} />
            <div className="sk-block sk-line" style={{ width: '30%' }} />
          </div>
        </div>
        <div className="sk-block sk-line sk-heading" />
        <div className="layout">
          <div className="sk-block sk-map" />
          <div className="sk-stores">
            {[0, 1, 2].map((i) => (
              <div key={i} className="sk-card">
                <div className="sk-block sk-line" style={{ width: `${55 - i * 8}%` }} />
                <div className="sk-block sk-line" style={{ width: '80%' }} />
                <div className="sk-block sk-line" style={{ width: '35%' }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function Turntable() {
  return (
    <div className="turntable" aria-hidden="true">
      <div className="tt-platter">
        <div className="tt-record" />
      </div>
      <div className="tt-arm" />
    </div>
  )
}

export function Cover({ album, size }) {
  return (
    <div className={`cover ${size}`}>
      {/* Keyed by URL: a different album starts fresh instead of inheriting "failed" or "loaded". */}
      <CoverImage key={album.cover} src={album.cover} />
    </div>
  )
}

function CoverImage({ src }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (failed) return <Vinyl />
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={loaded ? 'loaded' : ''}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  )
}

export function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 1a5 5 0 0 0-5 5c0 3.5 5 9 5 9s5-5.5 5-9a5 5 0 0 0-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
      />
    </svg>
  )
}

/** A pile of three records seen at an angle, for the logo. Each disc is a top ellipse over a short side. */
export function StackIcon() {
  const disc = (cy) => (
    <g key={cy} fill="currentColor" stroke="var(--bg)" strokeWidth="1.2">
      <path d={`M3 ${cy} v3 a13 4.5 0 0 0 26 0 v-3 z`} />
      <ellipse cx="16" cy={cy} rx="13" ry="4.5" />
    </g>
  )
  return (
    <svg className="stack-icon" viewBox="0 0 32 32" aria-hidden="true">
      {[23, 16, 9].map(disc)}
      <ellipse cx="16" cy="9" rx="4.6" ry="1.7" fill="var(--accent)" />
      <ellipse cx="16" cy="9" rx="0.9" ry="0.35" fill="var(--bg)" />
    </svg>
  )
}

export function Vinyl() {
  return (
    <svg className="vinyl" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="currentColor" />
      <circle cx="16" cy="16" r="11" fill="none" stroke="var(--groove)" strokeWidth="0.6" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="var(--groove)" strokeWidth="0.6" />
      <circle cx="16" cy="16" r="5" fill="var(--accent)" />
      <circle cx="16" cy="16" r="1.2" fill="var(--bg)" />
    </svg>
  )
}
