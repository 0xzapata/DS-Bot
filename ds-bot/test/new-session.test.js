import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format } from 'node:util'
import { install as partsInstall } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

// #122: "/new" gives a Bot a fresh root Session with an empty context. The Bot keeps its
// settings; the earlier chat stays readable but closed.

const MESSAGES = [
  { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Remember the word PELICAN' }], source: { kind: 'user' } },
  { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Noted: PELICAN.' }] },
]

function setup({ status = 'idle', queued = [], question, approval = false } = {}) {
  const warnings = []
  const llmCalls = []
  const followed = { s1: [], s2: [] }
  const archived = []
  const ctx = fakeContext()
  ctx.logger = { warn: (...args) => warnings.push(format(...args)), info: () => {} }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async id => { archived.push(id) }, unarchiveSession: async () => {} }
  ctx.llm = { resolveModelInfo: async () => ({}), stream: (options) => { llmCalls.push(options); throw new Error('no model call expected') } }
  const bot = { id: 'b1', name: 'Kai', sessionId: 's1', model: 'deepseek/v4', instructions: 'Be brief.', folder: '/tmp/team', segments: [] }
  const settings = JSON.stringify({ ...bot, sessionId: undefined, segments: undefined })
  const agentOf = (id, messages) => ({
    id,
    status: id === 's1' ? status : 'idle',
    session: { id, header: { cwd: '/tmp/team' }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => messages, toolHistory: () => [] },
    whenIdle: async () => {},
    runMaintenance: async job => job(new AbortController().signal),
    inbox: { nextStep: [], nextTurn: id === 's1' ? [...queued] : [], remove: () => {} },
    followup: message => followed[id].push(message),
    send: async () => {},
  })
  const agents = { s1: agentOf('s1', MESSAGES), s2: agentOf('s2', []) }
  const rt = {
    ctx,
    config: {},
    state: { bots: { b1: bot }, rooms: {}, prefs: {}, exchanges: [], capabilities: { items: {} }, switching: {}, questions: question ? { s1: question } : {}, views: {} },
    warn: (...args) => warnings.push(format(...args)),
    async save() {},
    async load() {},
    readOnly: () => undefined,
    botOf: id => rt.state.bots[id],
    roomOf: () => undefined,
    chatOf: () => bot.sessionId,
    sessionOfRoom: () => undefined,
    isBotSession: id => ['s1', 's2'].includes(id),
    isLocalAgentRef: () => false,
    chatOwners: new Map([['s1', 'b1']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    roomOwners: new Map(),
    live: new Map(),
    waitsForApproval: () => approval,
    eventsBackwards: async function* () {},
    resolveAgent: async id => agents[id],
    createSession: async () => 's2',
    desiredModel: async subject => subject.model,
    desiredEffort: async () => undefined,
    selectSessionModel: async () => {},
    applyModel: async () => {},
    applyPermission: async () => {},
    ensureCapabilities: async () => {},
    renewMemory: () => {},
    moveSchedules: async () => {},
    closeLocalAgentSession: async () => {},
    teamFolder: () => '/tmp/team',
    workDirOf: () => '/tmp/team',
    isFolder: async () => true,
    uiLanguage: () => 'en',
    roomProgress: new Map(),
  }
  partsInstall(rt)
  return { rt, bot, settings, followed, llmCalls, archived, warnings }
}

test('/new moves the Bot to a fresh, empty Session and keeps its settings', async () => {
  const { rt, bot, settings, followed, llmCalls, archived, warnings } = setup()
  const result = await rt.newSession('b1', 's1')
  assert.deepEqual(result, { sessionId: 's2', previous: 's1' }, warnings.join(' | '))
  // The mapping points at the fresh Session; the old one is an earlier part, archived.
  assert.equal(bot.sessionId, 's2')
  assert.deepEqual(bot.segments.map(segment => [segment.sessionId, segment.fallback, segment.closed]), [['s1', 'clean', true]])
  assert.deepEqual(archived, ['s1'])
  // The first turn starts from nothing: no note, no handoff, no model call.
  assert.equal(followed.s2.length, 0)
  assert.equal(llmCalls.length, 0)
  assert.doesNotMatch(rt.noteText(bot.segments[0]), /PELICAN/)
  assert.match(rt.noteText(bot.segments[0]), /nothing from this part was carried over/)
  // Identity, model, instructions and folder are untouched.
  assert.equal(JSON.stringify({ ...bot, sessionId: undefined, segments: undefined }), settings)
  // The old chat is still listed as part 1 of the Bot's own chat.
  assert.deepEqual(rt.partsOf('b1').map(part => [part.sessionId, part.number]), [['s1', 1], ['s2', 2]])
})

test('a closed part stays readable but takes no input and cannot become current again', async () => {
  const { rt } = setup()
  await rt.newSession('b1')
  rt.pastOwners.set('s1', { botId: 'b1' })
  assert.equal(rt.closedPart('s1'), true)
  assert.equal(rt.closedPart('s2'), false)
  await assert.rejects(rt.switchPart('b1', 's1'), { code: 'bot/closed' })
})

test('/new refuses rather than drop anything waiting', async () => {
  await assert.rejects(setup({ status: 'working' }).rt.newSession('b1'), { code: 'bot/busy' })
  await assert.rejects(setup({ queued: [{ id: 'q1', role: 'user', content: [] }] }).rt.newSession('b1'), { code: 'bot/busy' })
  await assert.rejects(setup({ question: { id: 'x' } }).rt.newSession('b1'), { code: 'bot/busy' })
  await assert.rejects(setup({ approval: true }).rt.newSession('b1'), { code: 'bot/busy' })
  await assert.rejects(setup().rt.newSession('b1', 's0'), { code: 'bot/stale' })
  await assert.rejects(setup().rt.newSession('nobody'), { code: 'bot/not-found' })
})
