import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary.jsx'

afterEach(cleanup)

function Boom() {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  test('shows its children when nothing goes wrong', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('fine')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('replaces a page that fails with a message, a reload button and a way home', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {}) // React and the boundary both log it
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong showing this page/)
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'start a new search' }).getAttribute('href')).toBe('/')
    expect(logged).toHaveBeenCalledWith('[app]', expect.objectContaining({ message: 'kaboom' }))
    logged.mockRestore()
  })
})
