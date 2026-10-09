import { test } from 'node:test'
import assert from 'node:assert/strict'
import { json, html, mockFetch, loadApi, uuid } from './helpers.js'

const { api } = await loadApi()

const group = (n, title, artist, extra = {}) => ({
  id: uuid(n),
  title,
  score: 80,
  count: 1,
  'artist-credit': [{ name: artist }],
  ...extra,
})

test('ranks the canonical album above same-named and self-titled albums', async () => {
  mockFetch({
    'musicbrainz.org': () =>
      json({
        'release-groups': [
          group(1, 'Fleetwood Mac', 'Fleetwood Mac', { score: 100, count: 20 }),
          group(2, 'Fleetwood Mac Rumours: Solo Cello', 'Trevor Exter', { score: 86 }),
          group(3, 'Rumours', 'Fleetwood Mac', { score: 69, count: 300, 'first-release-date': '1977-02-04' }),
        ],
      }),
  })
  const [first] = await api.searchAlbums({ album: 'rumours fleetwood mac' })
  assert.equal(first.title, 'Rumours')
  assert.equal(first.artist, 'Fleetwood Mac')
  assert.equal(first.year, '1977')
  assert.equal(first.cover, `/api/cover/${uuid(3)}`, 'covers are served (and cached) by our own server')
  assert.equal('rank' in first, false, 'internal rank must not leak to clients')
})

test('prefers studio albums over compilations and joins multi-artist credits', async () => {
  mockFetch({
    'musicbrainz.org': () =>
      json({
        'release-groups': [
          group(1, 'Kind of Blue', 'Various', { score: 100, count: 5, 'secondary-types': ['Compilation'] }),
          {
            ...group(2, 'Kind of Blue', 'x', { score: 100, count: 5 }),
            'artist-credit': [
              { name: 'Miles Davis', joinphrase: ' & ' },
              { name: 'John Coltrane' },
            ],
          },
        ],
      }),
  })
  const albums = await api.searchAlbums({ album: 'kind of blue' })
  assert.equal(albums[0].artist, 'Miles Davis & John Coltrane')
  assert.equal(albums[0].kind, 'Album')
  assert.equal(albums[1].kind, 'Compilation')
})

test('escapes Lucene syntax in the query', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  await api.searchAlbums({ album: 'AC/DC: Back in Black!' })
  const q = calls[0].url.searchParams.get('query')
  assert.match(q, /AC\\\/DC\\: Back in Black\\!/)
})

test('rejects an empty query with 400', async () => {
  await assert.rejects(api.searchAlbums({ album: '   ' }), { status: 400 })
})

test('retries once when MusicBrainz is rate limiting', async () => {
  let n = 0
  mockFetch({ 'musicbrainz.org': () => (n++ === 0 ? html(503) : json({ 'release-groups': [group(1, 'Blue', 'Joni Mitchell')] })) })
  const albums = await api.searchAlbums({ album: 'blue joni retry' })
  assert.equal(n, 2)
  assert.equal(albums[0].title, 'Blue')
})

test('reports an upstream failure as 502 after the retry', async () => {
  mockFetch({ 'musicbrainz.org': () => html(503) })
  await assert.rejects(api.searchAlbums({ album: 'always down' }), { status: 502 })
})

test('caps very long queries', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  await api.searchAlbums({ album: 'x'.repeat(5000) })
  assert.ok(calls[0].url.href.length < 2000, `URL was ${calls[0].url.href.length} chars`)
})

test('concurrent identical searches share one upstream request', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  await Promise.all([api.searchAlbums({ album: 'dedupe me' }), api.searchAlbums({ album: 'dedupe me' }), api.searchAlbums({ album: 'Dedupe Me ' })])
  assert.equal(calls.length, 1)
})

test('a failed search is not cached', async () => {
  let fail = true
  mockFetch({ 'musicbrainz.org': () => (fail ? html(500) : json({ 'release-groups': [group(1, 'Ok', 'Ok')] })) })
  await assert.rejects(api.searchAlbums({ album: 'flaky' }))
  fail = false
  assert.equal((await api.searchAlbums({ album: 'flaky' })).length, 1)
})

// ---------- artist search ----------

const ARTIST_ID = '11111111-1111-4111-8111-111111111111'

test('album + artist: asks for both and drops albums by other artists', async () => {
  const calls = mockFetch({
    'musicbrainz.org': () =>
      json({
        'release-groups': [
          group(1, 'Blue', 'Weezer', { score: 100, count: 50 }),
          group(2, 'Blue', 'Joni Mitchell', { score: 90, count: 40 }),
          group(3, 'Blue Highlights', 'Joni Mitchell', { 'secondary-types': ['Compilation'] }),
        ],
      }),
  })
  const albums = await api.searchAlbums({ album: 'Blue', artist: 'Joni Mitchell' })
  const q = calls[0].url.searchParams.get('query')
  assert.match(q, /releasegroup:\(Blue\) AND artist:\(Joni Mitchell\)/)
  assert.deepEqual(
    albums.map((a) => `${a.title} / ${a.artist}`),
    ['Blue / Joni Mitchell', 'Blue Highlights / Joni Mitchell'],
  )
})

test('artist only: finds the artist, then their widely released official albums', async () => {
  const calls = mockFetch({
    'musicbrainz.org/ws/2/artist': () => json({ artists: [{ id: ARTIST_ID, name: 'Miles Davis', score: 100 }] }),
    'musicbrainz.org/ws/2/release-group': () =>
      json({
        'release-groups': Array.from({ length: 9 }, (_, i) =>
          group(10 + i, `Album ${i}`, 'Miles Davis', { count: i === 4 ? 136 : 10 + i }),
        ),
      }),
  })
  const albums = await api.searchAlbums({ artist: 'Miles Davis' })
  assert.equal(albums[0].title, 'Album 4', 'most widely released first')
  assert.equal(albums.length, 9)
  const rgQuery = calls[1].url.searchParams.get('query')
  assert.match(rgQuery, new RegExp(`arid:${ARTIST_ID}`))
  assert.match(rgQuery, /status:official/)
  assert.match(rgQuery, /releases:\[10 TO 100000\]/)
  assert.equal(calls.length, 2, 'enough popular albums: no second release-group query')
})

test('artist only: tops up with less released albums for smaller artists', async () => {
  const calls = mockFetch({
    'musicbrainz.org/ws/2/artist': () => json({ artists: [{ id: ARTIST_ID, name: 'Small Band', score: 100 }] }),
    'musicbrainz.org/ws/2/release-group': (url) =>
      url.searchParams.get('query').includes('releases:')
        ? json({ 'release-groups': [group(20, 'Hit', 'Small Band', { count: 12 })] })
        : json({ 'release-groups': [group(20, 'Hit', 'Small Band', { count: 12 }), group(21, 'Debut', 'Small Band', { count: 2 })] }),
  })
  const albums = await api.searchAlbums({ artist: 'Small Band' })
  assert.deepEqual(albums.map((a) => a.title), ['Hit', 'Debut'], 'merged without duplicates')
  assert.equal(calls.length, 3)
})

test('artist only: no confident artist match means no albums', async () => {
  const calls = mockFetch({
    'musicbrainz.org/ws/2/artist': () => json({ artists: [{ id: ARTIST_ID, name: 'Somebody Else', score: 41 }] }),
  })
  assert.deepEqual(await api.searchAlbums({ artist: 'zzzzqqqq' }), [])
  assert.equal(calls.length, 1)
})

test('needs an album or an artist', async () => {
  await assert.rejects(api.searchAlbums({}), { status: 400 })
  await assert.rejects(api.searchAlbums({ album: ' ', artist: ' ' }), { status: 400 })
})

test('album + artist: albums by other artists are not passed off as a match', async () => {
  mockFetch({
    'musicbrainz.org': () =>
      json({ 'release-groups': [group(1, 'Blue', 'Weezer', { count: 50 }), group(2, 'Blue', 'Some Band', { count: 9 })] }),
  })
  // (A different artist from the earlier test: results are cached per search.)
  assert.deepEqual(await api.searchAlbums({ album: 'Blue', artist: 'Nina Simone' }), [])
})

test('artist only: a misspelt name still lists the artist MusicBrainz found', async () => {
  mockFetch({
    'musicbrainz.org/ws/2/artist': () => json({ artists: [{ id: ARTIST_ID, name: 'Radiohead', score: 92 }] }),
    'musicbrainz.org/ws/2/release-group': () =>
      json({ 'release-groups': Array.from({ length: 8 }, (_, i) => group(30 + i, `Album ${i}`, 'Radiohead', { count: 20 })) }),
  })
  assert.equal((await api.searchAlbums({ artist: 'Radiohed' })).length, 8)
})

test('album + artist: "and", "&" and "+" in artist names are interchangeable', async () => {
  for (const [typed, credited, album] of [
    ['Simon and Garfunkel', 'Simon & Garfunkel', 'Bookends'],
    ['Florence and the Machine', 'Florence + the Machine', 'Lungs'],
    ['Guns and Roses', 'Guns N’ Roses', 'Appetite for Destruction'],
  ]) {
    mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [group(1, album, credited, { count: 30 })] }) })
    const albums = await api.searchAlbums({ album, artist: typed })
    assert.equal(albums.length, 1, `${typed} should match ${credited}`)
  }
})

test('AND, OR and NOT typed in capitals are searched as words, not search commands', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  await api.searchAlbums({ album: 'NOT' })
  await api.searchAlbums({ album: 'Rock AND Roll', artist: 'THIS OR THAT' })
  const [notQuery, bothQuery] = calls.map((c) => c.url.searchParams.get('query'))
  assert.match(notQuery, /releasegroup:\(not\)\^3 OR artist:\(not\)/)
  assert.match(bothQuery, /releasegroup:\(Rock and Roll\) AND artist:\(THIS or THAT\)/)
})

test('only whole keywords are changed, and the query’s own operators are kept', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => json({ 'release-groups': [] }) })
  await api.searchAlbums({ album: 'ORANGE NOTHING BAND' })
  const q = calls[0].url.searchParams.get('query')
  assert.match(q, /releasegroup:\(ORANGE NOTHING BAND\)\^3 OR artist:\(ORANGE NOTHING BAND\)\) AND primarytype:album/)
})

// ---------- suggestions ----------

test('artist suggestions: names that matched well, deduplicated, with a hint', async () => {
  const calls = mockFetch({
    'musicbrainz.org/ws/2/artist': () =>
      json({
        artists: [
          { name: 'Radiohead', score: 100, country: 'GB' },
          { name: 'Radiohead', score: 90, disambiguation: 'tribute band' },
          { name: 'Radio Birdman', score: 70, country: 'AU' },
          { name: 'Unrelated', score: 20 },
        ],
      }),
  })
  assert.deepEqual(await api.suggest('artist', 'radioh'), [
    { value: 'Radiohead', detail: 'GB' },
    { value: 'Radio Birdman', detail: 'AU' },
  ])
  assert.equal(calls[0].url.searchParams.get('query'), 'artist:(radioh*)')
})

test('typingQuery: every word required, the last one unfinished, lowercased', async () => {
  const { typingQuery } = await import('../server/musicbrainz.js')
  assert.equal(typingQuery('The Dark Side Of'), 'the AND dark AND side AND of*')
  assert.equal(typingQuery('Simon & Garf'), 'simon AND garf*', 'a lone "&" is dropped')
  assert.equal(typingQuery('AC/DC'), 'ac\\/dc*')
  assert.equal(typingQuery('  '), null)
})

test('album suggestions: widely released albums first, most popular on top', async () => {
  const calls = mockFetch({
    'musicbrainz.org/ws/2/release-group': (url) =>
      json({
        'release-groups': url.searchParams.get('query').includes('releases:')
          ? [
              group(1, 'Rumours Live', 'Fleetwood Mac', { score: 100, count: 6 }),
              group(2, 'Rumours', 'Fleetwood Mac', { score: 100, count: 300 }),
            ]
          : [group(3, 'Rumours Outtakes', 'Fleetwood Mac', { score: 100, count: 2 })],
      }),
  })
  const suggestions = await api.suggest('album', 'rumou', { artist: 'Fleetwood Mac' })
  assert.deepEqual(suggestions.map((s) => s.value), ['Rumours', 'Rumours Live', 'Rumours Outtakes'])
  assert.equal(suggestions[0].detail, 'Fleetwood Mac')
  const first = calls[0].url.searchParams.get('query')
  assert.equal(first, '(releasegroup:(rumou*)) AND (artist:(Fleetwood Mac)) AND primarytype:album AND releases:[5 TO 100000]')
  assert.equal(calls.length, 2, 'few popular matches: everything was searched too')
})

test('album suggestions: keep the first results if the second search fails', async () => {
  mockFetch({
    'musicbrainz.org/ws/2/release-group': (url) =>
      url.searchParams.get('query').includes('releases:')
        ? json({ 'release-groups': [group(1, 'Kind of Blue', 'Miles Davis', { score: 100, count: 136 })] })
        : new Response('busy', { status: 503 }),
  })
  assert.deepEqual((await api.suggest('album', 'kind of b')).map((s) => s.value), ['Kind of Blue'])
})

test('album suggestions: only the artist asked for, ignoring "The"', async () => {
  mockFetch({
    'musicbrainz.org/ws/2/release-group': () =>
      json({
        'release-groups': [
          group(1, 'Abbey Road', 'The Beatles', { score: 100, count: 400 }),
          group(2, 'At Abbey Road', 'The Shadows', { score: 100, count: 30 }),
          group(3, 'Abbey Road Remix', 'Beatles', { score: 100, count: 5 }),
          group(4, 'A', 'B', { score: 100 }),
          group(5, 'C', 'D', { score: 100 }),
          group(6, 'E', 'F', { score: 100 }),
        ],
      }),
  })
  const suggestions = await api.suggest('album', 'abbey ro', { artist: 'The Beatles' })
  assert.deepEqual(suggestions.map((s) => `${s.value} / ${s.detail}`), ['Abbey Road / The Beatles', 'Abbey Road Remix / Beatles'])
})

test('suggestions: under three characters, an unknown field, or a failure give none', async () => {
  const calls = mockFetch({ 'musicbrainz.org': () => new Response('down', { status: 503 }) })
  assert.deepEqual(await api.suggest('artist', 'ra'), [])
  assert.deepEqual(await api.suggest('label', 'radio'), [])
  assert.equal(calls.length, 0)
  assert.deepEqual(await api.suggest('artist', 'failing'), [])
})
