import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { AUTO_MIN_CONFIDENCE } from '../src/host/auto-model.js'
import { fakeContext } from './fake-ctx.js'

const FLASH = 'ds/flash'
const PRO = 'ds/pro'
const SEE = 'ds/see'
const NOTES = { [FLASH]: 'Quick replies, small talk and short answers', [PRO]: 'Hard work: code, debugging, long analysis' }

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, what = 'the condition') => {
  const end = Date.now() + 4000
  while (!await check()) {
    if (Date.now() > end) throw new Error(`until: ${what} did not hold within 4 s`)
    await settle()
  }
}

const team = ({ bot = {}, prefs = { jev: true, modelNotes: NOTES } } = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, model: FLASH, appliedModel: FLASH },
    b: { id: 'b', name: 'Coder', role: 'Writes code', sessionId: 'b', createdAt: 2, model: FLASH, appliedModel: FLASH, auto: true, ...bot },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs,
  revision: 0,
})

// One user message, as DSH builds it from a prompt.
let serial = 0
const userMessage = (text, { image = false, kind = 'user' } = {}) => ({
  id: `m${++serial}`,
  role: 'user',
  content: [{ type: 'text', text }, ...(image ? [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] : [])],
  source: kind === 'user' ? { kind: 'user', rpcId: `r${serial}` } : { kind },
})

// A fake TypeSafe that answers every call with `answer()`, or holds it `delayMs`.
async function fakeJev(t, answer) {
  const calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const reply = answer(parsed)
      const send = () => {
        if (reply.status !== undefined) { response.writeHead(reply.status); response.end('{}'); return }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ model: 'jev-1.14.0', answers: { model: { type: 'choice', ...reply } }, usage: { input_tokens: 90, output_tokens: 5 } }))
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref()
      else send()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const saved = { url: process.env.TYPESAFE_BASE_URL, key: process.env.TYPESAFE_API_KEY }
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}`
  process.env.TYPESAFE_API_KEY = 'ts-auto-test-key-123456'
  t.after(() => {
    server.closeAllConnections()
    server.close()
    for (const [name, value] of [['TYPESAFE_BASE_URL', saved.url], ['TYPESAFE_API_KEY', saved.key]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  return calls
}
// A choice of `pick` among the criteria Jev was sent, with `confidence`.
const choose = (pick, confidence) => (body) => {
  const options = Object.keys(body.questions.model.criteria)
  const rest = (1 - confidence) / Math.max(1, options.length - 1)
  return { choice: pick, confidence, probabilities: Object.fromEntries(options.map(option => [option, option === pick ? confidence : rest])) }
}

async function start(t, { saved = team(), windows = {} } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-auto-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh
  const models = [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }, { id: 'see', name: 'See', inputModalities: ['text', 'image'] }]
  const ctx = fakeContext({})
  const selected = []
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        id: sessionId,
        status: 'idle',
        sent: [],
        session: { id: sessionId, header: { cwd: workspace }, requestHeader: () => undefined, deriveMessages: () => [] },
        followup() {}, steer() {}, inject() {}, cancel() {},
        send(message, target, wakeup) { this.sent.push({ id: message.id, target, wakeup }) },
        async whenIdle() {},
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) { for (const list of [this.nextStep, this.nextTurn]) { const at = list.findIndex(queued => queued.id === id); if (at !== -1) list.splice(at, 1) } },
          prepend(target, queued) { (target === 'next-turn' ? this.nextTurn : this.nextStep).unshift(queued) },
        },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: workspace, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'ds', name: 'DS' }],
      listModels: async () => models,
      resolveModelInfo: async (provider, model) => ({
        context: { contextWindow: windows[`${provider}/${model}`] ?? 100_000 },
        ...(model === 'see' ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] }),
      }),
      registerAdapter: () => { const handle = () => {}; handle.replace = () => {}; return handle },
    },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(entry => entry.path === path),
      create: async path => ({ id: 'w-new', path, title: 'DS Bot' }),
      archiveSession: async () => {},
      unarchiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 'new' }),
      prompt: async () => ({ accepted: true }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
        selected.push([sessionId, `${provider}/${model}`, ...(reasoningEffort ? [reasoningEffort] : [])])
      },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  // As cordis orders them: a prepended listener runs outside the ones added before it.
  const on = ctx.on
  ctx.on = (name, listener, options) => {
    const off = on(name, listener, options)
    if (options?.prepend) { const list = ctx.listeners.get(name); list.unshift(list.pop()) }
    return off
  }
  const warnings = []
  ctx.logger.warn = (template, ...args) => warnings.push([template, ...args].join(' '))
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await call('state', {})
  await rt.catalog({ fresh: true })
  await until(async () => (await rt.catalog()).length === 3, 'the catalog')
  // What the start's own model sync selected, before each test watches its own.
  const startup = selected.splice(0)
  const status = (sessionId, value) => {
    agentOf(sessionId).status = value
    ctx.emit('agent/status', { agent: agentOf(sessionId), status: value })
  }
  // A message reaches an idle Session: the driver wakes and DSH proposes the turn's
  // first step on the Session's model, through every pre-step listener in order.
  const firstStep = async (sessionId, messages, { model = FLASH, step = 1, wake = true, signal = AbortSignal.timeout(60_000) } = {}) => {
    if (wake) status(sessionId, 'running')
    const [provider, id] = model.split('/')
    const chain = ctx.listeners.get('agent/pre-step')
    const payload = { agent: agentOf(sessionId), messages, step, turn: 1, signal, modelSelection: { provider, model: id } }
    const run = index => (index >= chain.length ? Promise.resolve({ kind: 'enter', messages }) : chain[index](payload, () => run(index + 1)))
    return run(0)
  }
  // The user's own messages a step carries; the clock and memory listeners add theirs.
  const own = decision => decision.messages.filter(item => item.source?.kind === 'user').map(item => item.id)
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const audit = () => (existsSync(join(home, 'model-audit.jsonl')) ? readFileSync(join(home, 'model-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  return { rt, ctx, call, firstStep, own, status, agentOf, selected, startup, state, audit, warnings, home }
}

test('a confident pick of another model moves the chat before the turn reads its message', async (t) => {
  const jev = await fakeJev(t, choose(PRO, 0.8))
  const env = await start(t)
  const message = userMessage('Debug this race in the scheduler')
  const decision = await env.firstStep('b', [message])
  // The step on the old model takes no message: nothing is answered there.
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.deepEqual(env.selected, [['b', PRO]])
  assert.deepEqual(env.agentOf('b').inbox.nextTurn.map(queued => queued.id), [message.id])
  // When that turn has ended, the held message wakes the chat on the pick.
  env.status('b', 'idle')
  await until(() => env.agentOf('b').sent.length === 1, 'the wake')
  assert.deepEqual(env.agentOf('b').sent, [{ id: message.id, target: 'next-turn', wakeup: true }])
  // That turn is not asked about again.
  const next = await env.firstStep('b', [message], { model: PRO })
  assert.deepEqual(env.own(next), [message.id])
  assert.equal(jev.length, 1)
  assert.equal(env.state().bots.b.model, FLASH, 'the Bot keeps its own model')
  assert.equal(env.state().bots.b.appliedModel, PRO)
  // Jev saw the message, the role and the model in use, with staying on it as an option.
  assert.equal(jev[0].state.message, 'Debug this race in the scheduler')
  assert.equal(jev[0].state.current_model, FLASH)
  assert.equal(jev[0].state.bot_role, 'Writes code')
  assert.deepEqual(Object.keys(jev[0].questions.model.criteria).sort(), [FLASH, PRO])
  await until(() => env.audit().length === 1, 'the audit line')
  const [line] = env.audit()
  assert.deepEqual({ ...line, time: 0 }, { time: 0, bot: 'b', name: 'Coder', before: FLASH, pick: PRO, confidence: 0.8, applied: true, reason: 'picked' })
  assert.doesNotMatch(readFileSync(join(env.home, 'model-audit.jsonl'), 'utf8'), /scheduler/)
})

test('low confidence, the same model, a failed judgment and a late one all leave the model alone', async (t) => {
  let reply = choose(PRO, AUTO_MIN_CONFIDENCE - 0.01)
  const jev = await fakeJev(t, body => reply(body))
  const env = await start(t)
  const cases = [
    ['low confidence', choose(PRO, AUTO_MIN_CONFIDENCE - 0.01)],
    ['stays', choose(FLASH, 0.95)],
    ['no judgment', () => ({ status: 500 })],
    ['no judgment', () => ({ ...choose(PRO, 0.99)({ questions: { model: { criteria: { [FLASH]: '', [PRO]: '' } } } }), delayMs: 3000 })],
  ]
  for (const [reason, answer] of cases) {
    reply = answer
    const message = userMessage(`message for ${reason}`)
    const started = Date.now()
    const decision = await env.firstStep('b', [message])
    assert.ok(Date.now() - started < 2500, `${reason}: the turn waited ${Date.now() - started} ms`)
    assert.deepEqual(env.own(decision), [message.id], reason)
    env.status('b', 'idle')
    await until(() => env.audit().length === jev.length, 'the audit line')
    assert.equal(env.audit().at(-1).reason, reason)
    assert.equal(env.audit().at(-1).applied, false)
  }
  assert.deepEqual(env.selected, [])
  assert.equal(jev.length, 4, 'a failed judgment is not remembered: every message asks again')
})

test('Stop during the judgment changes no model', async (t) => {
  const jev = await fakeJev(t, body => ({ ...choose(PRO, 0.9)(body), delayMs: 200 }))
  const env = await start(t)
  const stop = new AbortController()
  setTimeout(() => stop.abort({ kind: 'user' }), 50)
  await env.firstStep('b', [userMessage('Debug this race')], { signal: stop.signal })
  env.status('b', 'idle')
  assert.equal(jev.length, 1)
  assert.deepEqual(env.selected, [])
  assert.equal(env.state().bots.b.appliedModel, FLASH)
  assert.deepEqual(env.agentOf('b').inbox.nextTurn, [])
  await until(() => env.audit().length === 1, 'the audit line')
  assert.equal(env.audit()[0].applied, false)
  assert.equal(env.audit()[0].reason, 'stopped')
})

test('input that arrives during the judgment keeps the model, and the audit says why', async (t) => {
  await fakeJev(t, body => ({ ...choose(PRO, 0.9)(body), delayMs: 150 }))
  const env = await start(t)
  const first = userMessage('first')
  const second = userMessage('second')
  setTimeout(() => env.agentOf('b').inbox.nextStep.push(second), 40)
  const decision = await env.firstStep('b', [first])
  assert.deepEqual(env.own(decision), [first.id])
  assert.deepEqual(env.selected, [])
  assert.deepEqual(env.agentOf('b').inbox.nextStep.map(queued => queued.id), [second.id])
  await until(() => env.audit().length === 1, 'the audit line')
  assert.deepEqual({ applied: env.audit()[0].applied, reason: env.audit()[0].reason }, { applied: false, reason: 'input arrived' })
})

test('a queued message, a group message, a Bot\'s message and Auto off ask nothing', async (t) => {
  const jev = await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t, { saved: team({ bot: {} }) })
  // Queued behind a running turn: the driver did not wake for it.
  env.status('b', 'running')
  await env.firstStep('b', [userMessage('first')])
  env.status('b', 'idle')
  jev.length = 0
  env.selected.length = 0
  env.status('b', 'running')
  await env.firstStep('b', [userMessage('still on it')], { step: 2, wake: false })
  // The next turn of the same run, opened for a message that queued meanwhile.
  await env.firstStep('b', [userMessage('queued')], { wake: false })
  // The Bot's group Session, and a message another Bot sent to its own chat.
  env.status('b', 'idle')
  await env.firstStep('gb', [userMessage('in the group')])
  await env.firstStep('b', [userMessage('from Chief', { kind: 'bot' })])
  env.status('b', 'idle')
  // Auto off on Chief.
  await env.firstStep('a', [userMessage('hello')])
  assert.equal(jev.length, 0)
  assert.deepEqual(env.selected, [])
})

test('an image keeps only vision models, and a window too small for the chat is dropped', async (t) => {
  const jev = await fakeJev(t, choose(FLASH, 0.9))
  const env = await start(t, { saved: team({ prefs: { jev: true, modelNotes: { ...NOTES, [SEE]: 'Reads images and screenshots' } } }) })
  await env.firstStep('b', [userMessage('what is in this picture?', { image: true })])
  env.status('b', 'idle')
  // One vision candidate is fewer than two: no call.
  assert.equal(jev.length, 0)
  await env.firstStep('b', [userMessage('plain text')])
  env.status('b', 'idle')
  assert.deepEqual(Object.keys(jev[0].questions.model.criteria).sort(), [FLASH, PRO, SEE])
  assert.equal(jev[0].state.has_image, false)
})

test('a candidate whose window cannot hold the conversation is never offered', async (t) => {
  const jev = await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t, { windows: { [PRO]: 1_000 } })
  await env.firstStep('b', [userMessage('x'.repeat(8_000))])
  env.status('b', 'idle')
  assert.equal(jev.length, 0, 'one candidate left: nothing to choose')
  assert.deepEqual(env.selected, [])
})

test('fewer than two noted models, or the switch off, ask nothing', async (t) => {
  const jev = await fakeJev(t, choose(PRO, 0.9))
  const one = await start(t, { saved: team({ prefs: { jev: true, modelNotes: { [PRO]: NOTES[PRO] } } }) })
  await one.firstStep('b', [userMessage('hi')])
  const off = await start(t, { saved: team({ prefs: { modelNotes: NOTES } }) })
  await off.firstStep('b', [userMessage('hi')])
  assert.equal(jev.length, 0)
  assert.deepEqual([...one.selected, ...off.selected], [])
})

test('a private Bot with Auto on sends nothing to TypeSafe', async (t) => {
  const jev = await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t, { saved: team({ bot: { private: true, workDir: '/nonexistent/private-coder' } }) })
  await env.firstStep('b', [userMessage('my secret plan')])
  assert.equal(jev.length, 0)
})

test('a manual model change turns Auto off and puts the chat on that model', async (t) => {
  await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t)
  await env.firstStep('b', [userMessage('hard work')])
  env.status('b', 'idle')
  assert.equal(env.state().bots.b.appliedModel, PRO)
  env.selected.length = 0
  assert.equal((await env.call('update-bot', { id: 'b', model: FLASH })).ok, true)
  assert.equal(env.state().bots.b.auto, undefined)
  assert.deepEqual(env.selected.filter(([id]) => id === 'b'), [['b', FLASH]])
  // Back on: the chat stays where it is until the next message.
  env.selected.length = 0
  assert.equal((await env.call('update-bot', { id: 'b', auto: true })).ok, true)
  assert.equal(env.state().bots.b.auto, true)
  // Off again by the switch: back on the Bot's own model.
  assert.equal((await env.call('update-bot', { id: 'b', auto: false })).ok, true)
  assert.equal(env.state().bots.b.auto, undefined)
})

test('a sync keeps the pick on the chat and the Bot\'s own model in its groups', async (t) => {
  await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t)
  await env.firstStep('b', [userMessage('hard work')])
  env.status('b', 'idle')
  env.selected.length = 0
  await env.rt.applyModel(env.rt.botOf('b'))
  assert.deepEqual(env.selected.filter(([id]) => id === 'b'), [])
  assert.equal(env.state().bots.b.appliedModel, PRO)
})

test('a team saved with Auto on loads in a build without it as an ordinary Bot on its own model', async (t) => {
  await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t)
  await env.firstStep('b', [userMessage('hard work')])
  env.status('b', 'idle')
  // The older build: the same file without the fields it does not know.
  const saved = env.state()
  delete saved.bots.b.auto
  delete saved.prefs.jev
  delete saved.prefs.modelNotes
  const older = await start(t, { saved })
  // Its start moves the chat back to the Bot's own model.
  assert.deepEqual(older.startup.filter(([id]) => id === 'b'), [['b', FLASH]])
  await until(() => older.state().bots.b.appliedModel === FLASH, 'the saved model')
  assert.equal(older.state().bots.b.model, FLASH)
})

test('notes and the switch are team preferences; the key never reaches the client', async (t) => {
  await fakeJev(t, choose(PRO, 0.9))
  const env = await start(t, { saved: team({ prefs: {} }) })
  assert.equal((await env.call('set-prefs', { jev: true, modelNotes: { [PRO]: '  Hard   work  ' } })).ok, true)
  assert.deepEqual(env.state().prefs, { jev: true, modelNotes: { [PRO]: 'Hard work' } })
  assert.equal((await env.call('set-prefs', { modelNotes: { [PRO]: '' } })).ok, true)
  assert.equal(env.state().prefs.modelNotes, undefined)
  assert.equal((await env.call('set-prefs', { modelNotes: { 'local-acp-x/default': 'cli' } })).ok, false)
  // A note is only for a model DSH serves, so the number of notes stays bounded by the
  // catalog; a note left for a model that is gone can still be cleared.
  const unknown = await env.call('set-prefs', { modelNotes: { 'ds/nope': 'Never served' } })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error.message, /Unknown model ds\/nope/)
  assert.equal(env.state().prefs.modelNotes, undefined)
  assert.equal((await env.call('set-prefs', { modelNotes: { 'ds/gone': null } })).ok, true)
  const view = await env.call('state', {})
  const text = JSON.stringify(view)
  assert.doesNotMatch(text, /ts-auto-test-key/)
  assert.deepEqual(view.value.jevKey, { set: true, writable: false })
  assert.doesNotMatch(env.warnings.join('\n'), /ts-auto-test-key/)
})

test('the key is in no file of the data folder, no view and no log after a pick and a failure', async (t) => {
  let fail = false
  await fakeJev(t, body => (fail ? { status: 500 } : choose(PRO, 0.9)(body)))
  const env = await start(t)
  await env.firstStep('b', [userMessage('hard work')])
  env.status('b', 'idle')
  // The turn the pick holds back runs on the pick, unasked.
  await env.firstStep('b', [userMessage('hard work')], { model: PRO })
  env.status('b', 'idle')
  fail = true
  await env.firstStep('b', [userMessage('again')], { model: PRO })
  env.status('b', 'idle')
  await until(() => env.audit().length === 2, 'both audit lines')
  await env.call('usage', { timeZone: 'UTC' })
  const { readdirSync, statSync } = await import('node:fs')
  const files = []
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else files.push(path) } }
  walk(env.home)
  assert.ok(files.some(path => path.endsWith('model-audit.jsonl')) && files.some(path => path.endsWith('usage.sqlite')))
  for (const path of files) assert.doesNotMatch(readFileSync(path).toString('latin1'), /ts-auto-test-key/, path)
  assert.doesNotMatch(JSON.stringify(await env.call('state', {})), /ts-auto-test-key/)
  assert.doesNotMatch(env.warnings.join('\n'), /ts-auto-test-key/)
  assert.ok(env.warnings.some(line => /judgment \(judgment\) not used: HTTP 500/.test(line)))
})
