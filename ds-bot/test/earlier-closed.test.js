import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// After /new (#122) the old chat is closed but must stay readable and searchable.
// Host: the closed parts are named in the roster and found by 'search-closed'.
// Client: the Bot's chat offers them (EarlierDock) and the palette lists the hits.
const said = (seq, text) => ({ seq, time: 1000 + seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const TEAM = (segments, exchangeTurns = {}) => ({
  version: 1, mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer-now', createdAt: 2, segments },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns, questions: {}, views: {}, prefs: {}, revision: 0,
})
const PAGES = { 'writer-old': [said(0, 'The zebrafinch draft is ready'), said(1, 'Zebrafinch chapter two')], 'writer-mid': [said(0, 'A plain part switch mentions zebrafinch too')] }

// `noIndex` makes the chat index unopenable (a folder where its file belongs), so the
// search reads the logs, as it does without SQLite.
async function start(t, segments, { exchangeTurns, noIndex } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-earlier-closed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM(segments, exchangeTurns)))
  if (noIndex) mkdirSync(join(home, 'chat-index.sqlite'))
  const ctx = fakeContext()
  const agentOf = sessionId => ({
    id: sessionId, status: 'idle',
    session: { id: sessionId, seq: 10, header: { cwd: home, config: { provider: 'deepseek', model: 'v4' } }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => [], snapshotEvents: () => [] },
    ctx: { tools: { register: () => () => {} } }, inbox: { nextStep: [], nextTurn: [], remove: () => false }, followup() {}, inject() {},
  })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), async* stream() { yield { type: 'finish', reason: { kind: 'stop' } } } },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, unarchiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {},
      page: async ({ address }) => ({ records: (PAGES[address.sessionId] ?? []).map(event => ({ event })), hasMore: false }),
      prompt: async () => {},
    },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
}

const CLOSED = [{ sessionId: 'writer-old', endedAt: 1, fallback: 'clean', closed: true }]

test('the roster names the parts a clean start closed, and only those', async (t) => {
  const call = await start(t, [{ sessionId: 'writer-mid', endedAt: 1 }, ...CLOSED.map(segment => ({ ...segment, endedAt: 2 }))])
  const writer = (await call('state', {})).value.bots.find(bot => bot.id === 'writer')
  assert.deepEqual(writer.parts, ['writer-mid', 'writer-old'])
  assert.deepEqual(writer.closed, ['writer-old'])
})

test('search-closed finds text that only a closed part holds, and not an ordinary earlier part', async (t) => {
  const call = await start(t, [{ sessionId: 'writer-mid', endedAt: 1 }, { sessionId: 'writer-old', endedAt: 2, fallback: 'clean', closed: true }])
  const hits = (await call('search-closed', { query: 'zebrafinch' })).value
  assert.deepEqual(hits.map(hit => [hit.botId, hit.sessionId]), [['writer', 'writer-old'], ['writer', 'writer-old']])
  assert.match(hits[0].text, /zebrafinch/i)
  assert.deepEqual((await call('search-closed', { query: 'nothing like it' })).value, [])
  assert.deepEqual((await call('search-closed', { query: 'z' })).value, [])
})

// A request from a teammate is a hidden exchange turn: the chat shows none of it, nor the
// Bot's answer to it. Search must offer only what the earlier feed shows.
const turnStart = (seq, turn) => ({ seq, time: 1000 + seq, type: 'turn/start', data: { turn } })
const request = (seq, text) => ({ seq, time: 1000 + seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'bot', role: 'request', senderName: 'Chief' } } })
const answer = (seq, turn, text) => ({ seq, time: 1000 + seq, type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
PAGES['writer-hid'] = [
  turnStart(0, 0), request(1, 'Chief asks: secretkumquat budget'), answer(2, 0, 'The secretkumquat budget is 40'),
  turnStart(3, 1), said(4, 'A plain secretkumquat note'), answer(5, 1, 'Noted the secretkumquat note'),
]
for (const noIndex of [false, true]) {
  test(`search-closed offers only what the earlier feed shows (${noIndex ? 'reading the logs' : 'chat index'})`, async (t) => {
    const call = await start(t, [{ sessionId: 'writer-hid', endedAt: 1, fallback: 'clean', closed: true }], { exchangeTurns: { 'writer-hid': [0] }, noIndex })
    const feed = (await call('earlier', { sessionId: 'writer-now' })).value.items.flatMap(item => (item.kind === 'user' || item.kind === 'bot' ? [item.text] : []))
    assert.deepEqual(feed, ['A plain secretkumquat note', 'Noted the secretkumquat note'])
    const hits = (await call('search-closed', { query: 'secretkumquat' })).value.map(hit => hit.text)
    assert.deepEqual(hits.sort(), [...feed].sort())
  })
}

// ---- client -------------------------------------------------------------
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/client/cells.js'\nexport * from './src/client/palette.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createContext: initial => ({ value: initial }), useContext: ctx => ctx.value, useCallback: fn => fn, createElement: h, Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}], useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, MutationObserver: class { observe() {} disconnect() {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null, writeClipboard: () => Promise.resolve(true) }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { EarlierDock, closedMessages } = module.exports
const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
const find = (node, match) => {
  if (Array.isArray(node)) return node.map(child => find(child, match)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  return match(node) ? node : find(node.props.children, match)
}
const bot = (over = {}) => ({ id: 'writer', name: 'Writer', color: 'blue', sessionId: 'writer-now', parts: ['writer-old'], closed: ['writer-old'], ...over })
const roster = value => ({ ready: true, bots: [value], byId: { [value.id]: value, 'writer-old': value, 'writer-now': value }, roomsById: {}, exchangeTurns: {} })
const dock = (value, { sessionId = 'writer-now', open = null, toggled = [] } = {}) => expand(EarlierDock({
  sessionId, useRoster: select => select(roster(value)), useUi: select => select({ earlier: open }), actions: { toggleEarlier: id => toggled.push(id), earlier: () => new Promise(() => {}) },
}))

test('the chat of a Bot that was started over offers the closed chat, and opens it as the earlier feed', () => {
  const toggled = []
  const closed = dock(bot(), { toggled })
  const button = find(closed, node => node.type === 'button')
  assert.equal(text(button), 'Earlier messages')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(find(closed, node => node.props?.role === 'feed'), undefined)
  button.props.onClick()
  assert.deepEqual(toggled, ['writer'])
  const open = dock(bot(), { open: 'writer' })
  assert.equal(find(open, node => node.type === 'button').props['aria-expanded'], true)
  assert.ok(find(open, node => node.props?.role === 'feed') !== undefined)
})

test('the dock stays away after an ordinary part switch, in an older part, and with several /new in a row it still opens the chain', () => {
  assert.equal(dock(bot({ closed: [] })), null)
  assert.equal(dock(bot({ closed: undefined })), null)
  assert.equal(dock(bot({ parts: ['writer-old', 'writer-mid'], closed: ['writer-old'] })), null)
  assert.equal(dock(bot(), { sessionId: 'writer-old' }), null)
  const twice = bot({ parts: ['writer-old', 'writer-mid'], closed: ['writer-old', 'writer-mid'] })
  assert.ok(find(dock(twice, { open: 'writer' }), node => node.props?.role === 'feed') !== undefined)
})

test('a palette hit in a closed chat shows the Bot and the words, and opens that chat\'s earlier feed', () => {
  const opened = []
  const rows = closedMessages(roster(bot()), [{ botId: 'writer', sessionId: 'writer-old', text: '…the zebrafinch draft…' }, { botId: 'gone', sessionId: 'x', text: 'lost' }], { openSession: id => opened.push(['open', id]), openEarlier: id => opened.push(['earlier', id]) })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'Writer')
  assert.equal(rows[0].subtitle, '…the zebrafinch draft…')
  rows[0].run()
  assert.deepEqual(opened, [['open', 'writer'], ['earlier', 'writer']])
})
