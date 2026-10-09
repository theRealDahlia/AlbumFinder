import { useEffect, useRef } from 'react'
import { describeHours, openStatus, parseHours } from './hours.js'
import { formatMiles } from './distance.js'

const SOURCE = {
  discogs: 'On the shop’s Discogs page',
}

function price({ price, currency }) {
  if (price == null) return null
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(price)
  } catch {
    return `${price} ${currency || ''}`.trim()
  }
}

export default function StoreCard({ store, timezone, now, stock = [], verified, selected, onSelect }) {
  const card = useRef(null)
  // Stores are often picked on the map; bring the card into view ("nearest" leaves it alone if visible).
  useEffect(() => {
    if (!selected) return
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    card.current.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [selected])

  const hours = parseHours(store.hours)
  const status = openStatus(hours, now, timezone)
  const directions = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    store.address ? `${store.name}, ${store.address}` : `${store.lat},${store.lon}`,
  )}`

  return (
    <li ref={card} className={`store ${selected ? 'selected' : ''} ${stock.length ? 'has-stock' : ''}`} onClick={onSelect}>
      <div className="store-top">
        <h3>
          {/* Its click (mouse or keyboard) bubbles to the card's onClick, which selects the store. */}
          <button type="button" className="store-name" aria-pressed={selected}>
            {store.name}
          </button>
        </h3>
        <span className="distance">{formatMiles(store.distanceKm)}</span>
      </div>

      {status && (
        <p className={`open-status ${status.open ? 'open' : 'closed'}`}>
          {status.open
            ? `Open now${status.until ? ` · until ${status.until}` : ''}`
            : `Closed${status.opens ? ` · opens ${status.opens}` : ' now'}`}
        </p>
      )}

      {verified && (
        <p className="verified" onClick={(e) => e.stopPropagation()}>
          <a
            href={verified.url}
            target="_blank"
            rel="noreferrer"
            title="This shop has a Discogs seller account with vinyl for sale, matched to its OpenStreetMap listing."
          >
            Sells vinyl · Discogs
          </a>
        </p>
      )}

      {stock.length > 0 && (
        <div className="stock" onClick={(e) => e.stopPropagation()}>
          <p className="stock-title">In stock</p>
          <ul>
            {stock.map((item, i) => (
              <li key={`${item.source}-${i}`}>
                <span className="stock-what">
                  {item.title}
                  {item.format && <small> · {item.format}</small>}
                  {item.condition && <small> · {item.condition}</small>}
                </span>
                {price(item) && <span className="stock-price">{price(item)}</span>}
                <span className="stock-source">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {SOURCE[item.source]}
                    </a>
                  ) : (
                    SOURCE[item.source]
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="details">
        {store.address && (
          <>
            <dt>Address</dt>
            <dd>{store.address}</dd>
          </>
        )}
        {store.hours && (
          <>
            <dt>Hours</dt>
            <dd>{describeHours(hours) ?? store.hours}</dd>
          </>
        )}
      </dl>

      <div className="links" onClick={(e) => e.stopPropagation()}>
        {store.phone && <a href={`tel:${store.phone.split(';')[0].replace(/\s/g, '')}`}>Call</a>}
        {store.website && (
          <a href={store.website} target="_blank" rel="noreferrer">
            Website
          </a>
        )}
        <a href={directions} target="_blank" rel="noreferrer">
          Directions
        </a>
        <a
          className="fix"
          href={`https://www.openstreetmap.org/${store.id}`}
          target="_blank"
          rel="noreferrer"
          title="Wrong hours or address? This shop’s details come from OpenStreetMap, which anyone can correct."
        >
          Fix details
        </a>
      </div>
    </li>
  )
}
