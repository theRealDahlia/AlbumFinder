// MusicBrainz and Nominatim ask apps to include a contact (website or email) in their User-Agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { json, mockFetch, loadApi } from './helpers.js'

process.env.CONTACT = 'https://records.example'
const { api } = await loadApi()

test('upstream requests identify the app and include the CONTACT setting', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  await api.searchAlbums({ album: 'Blue' })
  assert.equal(calls[0].init.headers['User-Agent'], 'AlbumFinder/0.1 ( https://records.example )')
})
