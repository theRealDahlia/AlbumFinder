import { Component } from 'react'

/** Shows a message with a way out, instead of a blank page, when something in the app fails while drawing. */
export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('[app]', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="crash">
        <div className="notice error" role="alert">
          <p>
            <strong>Something went wrong showing this page.</strong>
          </p>
          <p>
            <button type="button" className="link" onClick={() => location.reload()}>
              Reload the page
            </button>{' '}
            or <a href="/">start a new search</a>.
          </p>
        </div>
      </main>
    )
  }
}
