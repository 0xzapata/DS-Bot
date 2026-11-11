// The Auto model pick on DSH's real agent loop, on a recording model adapter: input that
// arrives, and a Stop, at any moment of the pick. Every message is answered once, the
// first one first; a stopped message stays in the chat as it does with Auto off; and a
// model changes only for a message answered on it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { install } from '../src/host/auto-model.js'

const PROVIDER = 'auto-loop'
const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const textOf = message => (message.content ?? []).map(block => block.text ?? '').join('')
const settle = async (check, ms = 4000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), 'condition not reached')
}

// One Bot chat on the real loop. Every model call is recorded with its model, the user
// messages its request carries after the last answer, and how many "[model changed]"
// notices the request holds. `decide` stands in for Jev: it resolves to `env.pick`
// after `delayMs`. `at(name)` runs at the start of every call the picker makes into
// DS Bot or the model registry, as DSH claims the first message, and as the Session's
// model changes: every await in the pick is on one of those, so a test can act at each.
async function boot(t, { delayMs = 100, at } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const calls = []
  class Recorder extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } } }
    async listModels() { return [{ id: 'flash', name: 'Flash' }, { id: 'pro', name: 'Pro' }] }
    async *stream(options) {
      const messages = options.messages ?? []
      const lastAnswer = messages.findLastIndex(message => message.role === 'assistant')
      const asked = messages.slice(lastAnswer + 1).filter(message => message.role === 'user' && message.source?.kind === 'user').map(textOf)
      calls.push({ model: options.model, asked, notices: messages.filter(message => message.source?.kind === 'model-selection').length })
      const text = `answer to ${asked.join(' + ')}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([PROVIDER], new Recorder())
  const warnings = []
  const judged = []
  let pick = `${PROVIDER}/pro`
  const bot = { id: 'b', name: 'Writer', role: 'Writes', auto: true, appliedModel: `${PROVIDER}/flash` }
  const rt = {
    ctx,
    home: '/nonexistent/auto-model-loop',
    state: { prefs: { jev: true, modelNotes: { [`${PROVIDER}/flash`]: 'quick', [`${PROVIDER}/pro`]: 'hard' } } },
    readOnly: () => 'test',
    warn: (template, ...args) => warnings.push(format(template, ...args)),
    chatOwners: new Map([['b', 'b']]),
    botOf: id => (id === 'b' ? bot : undefined),
    live: new Map(),
    liveOf: id => rt.live.get(id) ?? rt.live.set(id, {}).get(id),
    catalog: async () => [{ ref: `${PROVIDER}/flash`, name: 'Flash' }, { ref: `${PROVIDER}/pro`, name: 'Pro' }],
    decide: async (state) => {
      judged.push(state.message)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      if (pick.endsWith('/none')) return null
      const other = pick.endsWith('/pro') ? `${PROVIDER}/flash` : `${PROVIDER}/pro`
      return { model: { type: 'choice', choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9, [other]: 0.1 } } }
    },
    desiredEffort: async () => undefined,
    selectSessionModel: async (_sessionId, { provider, model }) => agent.model.select({ provider, model }),
    save: async () => {},
  }
  // DS Bot's own restore (parts.js), as the picker uses it.
  const inboxTargetOf = message => (message.source?.kind === 'user' ? 'next-turn' : 'next-step')
  rt.restoreInput = (subject, messages) => {
    for (const message of [...messages].reverse()) {
      if ([...subject.inbox.nextStep, ...subject.inbox.nextTurn].some(queued => queued.id === message.id)) continue
      subject.inbox.prepend(inboxTargetOf(message), message)
    }
  }
  install(rt)
  let agent
  if (at !== undefined) {
    for (const [name, value] of Object.entries(rt)) {
      if (typeof value === 'function') rt[name] = (...args) => { at(name, agent); return value(...args) }
    }
    const resolve = ctx.llm.resolveModelInfo
    ctx.llm.resolveModelInfo = (...args) => { at('resolveModelInfo', agent); return resolve.apply(ctx.llm, args) }
    ctx.on('agent/inbox/claimed', ({ message }) => { if (textOf(message) === 'first') at('claimed', agent) })
    ctx.on('session/event', (_session, event) => { if (event.type === 'model/selection') at('model/selection', agent) })
  }
  await mountAgentLoopTestHarness(ctx)
  // Outside the picker's listener: the moment pre-step listeners start.
  if (at !== undefined) ctx.on('agent/pre-step', (_payload, next) => { at('pre-step', agent); return next() }, { prepend: true })
  agent = await ctx.agentLoop.create(SessionId('b'), { provider: PROVIDER, model: 'flash' })
  t.after(() => ctx.fiber.dispose())
  const turnEnds = () => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length
  // Idle with nothing pending and no wake waiting.
  const quiet = async () => {
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
    await new Promise(resolve => setTimeout(resolve, 30))
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
  }
  // The owner's messages in the chat's history, in order.
  const history = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').map(event => textOf(event.data))
  const model = () => agent.model.current().model
  t.after(() => t.diagnostic(`calls ${JSON.stringify(calls)} turns ${turnEnds()} model ${model()} applied ${bot.appliedModel}`))
  return { agent, bot, calls, judged, warnings, turnEnds, quiet, history, model, setPick: (value) => { pick = `${PROVIDER}/${value}` } }
}
const asked = env => env.calls.flatMap(call => call.asked)
// A notice only where the model of a request differs from the one before it.
const noticesMatch = env => env.calls.every((call, index) => call.notices === env.calls.slice(0, index + 1).filter((each, at) => at > 0 && each.model !== env.calls[at - 1].model).length)
// The points of one undisturbed pick, in order: [name, nth call of that name].
async function pointsOf(t) {
  const seen = []
  const env = await boot(t, { at: name => seen.push(name) })
  env.agent.followup(userMessage('first'))
  await env.quiet()
  return seen.map((name, index) => [name, seen.slice(0, index + 1).filter(each => each === name).length])
}
// A boot that runs `act` once, at the nth call of `name`.
const bootAt = (t, [name, nth], act) => {
  let count = 0
  return boot(t, { at: (called, agent) => { if (called === name && ++count === nth) act(agent) } })
}

test('a steer during the judgment: one turn on the current model, the first message first', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.steer(userMessage('steer-second'))
  await env.quiet()
  // The pick is dropped: one ordinary turn on the model in use, whose next step takes
  // the steer.
  assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['flash', ['first']], ['flash', ['steer-second']]])
  assert.equal(env.turnEnds(), 1)
})

test('a followup during the judgment: each answered once, in order, on the current model', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.followup(userMessage('second'))
  await env.quiet()
  // A followup queues behind the held message in next-turn, so the pick stands.
  assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['pro', ['first']], ['pro', ['second']]])
  assert.equal(env.turnEnds(), 3, 'the empty hold, then one turn each')
})

test('two quick followups during the judgment: each answered once, in order, on the current model', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.followup(userMessage('second'))
  env.agent.followup(userMessage('third'))
  await env.quiet()
  assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['pro', ['first']], ['pro', ['second']], ['pro', ['third']]])
})

test('nothing arrives during the judgment: the message is answered once, on the pick', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await env.quiet()
  // The first request of a Session has no earlier one to differ from: no notice.
  assert.deepEqual(env.calls, [{ model: 'pro', asked: ['first'], notices: 0 }])
  assert.equal(env.turnEnds(), 2, 'the empty hold, then the answer')
  assert.equal(env.bot.appliedModel, `${PROVIDER}/pro`)
})

test('a followup between the empty turn and the wake: each answered once, the first first', async (t) => {
  const env = await boot(t)
  // As soon as the hold ends its turn, before the wake on idle runs.
  let sent = false
  env.agent.ctx.on('agent/status', ({ status }) => {
    if (status !== 'idle' || sent || env.turnEnds() !== 1) return
    sent = true
    env.agent.followup(userMessage('second'))
  })
  env.agent.followup(userMessage('first'))
  await env.quiet()
  assert.equal(sent, true)
  assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['pro', ['first']], ['pro', ['second']]])
})

// R1: a steer at a moment outside the Jev wait.
for (const [what, point] of [
  ['as DSH claims the first message, before the picker runs', ['claimed', 1]],
  ['while the thinking level for the pick is read', ['desiredEffort', 1]],
]) {
  test(`a steer ${what}: the first message first, each once, on one model`, async (t) => {
    const env = await bootAt(t, point, agent => agent.steer(userMessage('steer-second')))
    env.agent.followup(userMessage('first'))
    await env.quiet()
    assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['flash', ['first']], ['flash', ['steer-second']]])
    assert.equal(env.turnEnds(), 1)
    assert.equal(env.model(), 'flash')
    assert.equal(env.bot.appliedModel, `${PROVIDER}/flash`)
  })
}

test('two steers during the judgment: one turn on the current model, in order', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.steer(userMessage('s2'))
  env.agent.steer(userMessage('s3'))
  await env.quiet()
  assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['flash', ['first']], ['flash', ['s2', 's3']]])
})

test('a steer and a followup during the judgment: in order, on the current model', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.steer(userMessage('s2'))
  env.agent.followup(userMessage('f3'))
  await env.quiet()
  assert.deepEqual(env.calls.map(call => [call.model, call.asked]), [['flash', ['first']], ['flash', ['s2']], ['flash', ['f3']]])
})

// Once the hold is in place, input that comes is ordered behind the held message.
test('a steer while the hold is saved: the held message first, each once, on the pick', async (t) => {
  const env = await bootAt(t, ['save', 1], agent => agent.steer(userMessage('steer-second')))
  env.agent.followup(userMessage('first'))
  await env.quiet()
  assert.deepEqual(asked(env), ['first', 'steer-second'])
  assert.ok(env.calls.every(call => call.model === 'pro'))
})

// R3.
test('a steer between the empty turn and the wake: the held message first, on the pick', async (t) => {
  const env = await boot(t)
  let sent = false
  env.agent.ctx.on('agent/status', ({ status }) => {
    if (status !== 'idle' || sent || env.turnEnds() !== 1) return
    sent = true
    env.agent.steer(userMessage('second'))
  })
  env.agent.followup(userMessage('first'))
  await env.quiet()
  assert.equal(sent, true)
  assert.deepEqual(asked(env), ['first', 'second'])
  assert.ok(env.calls.every(call => call.model === 'pro'))
  assert.equal(env.model(), 'pro')
})

// R2, A and B: a Stop during the pick ends where a Stop during the model call ends with
// Auto off: no answer, the message kept in the chat, the model and appliedModel as they
// were. The next message's request carries it, with no notice for a model never used.
for (const [what, point, stop] of [
  ['during the judgment (DSH\'s Stop)', ['decide', 1], agent => setTimeout(() => agent.cancel({ kind: 'user' }, { keepInbox: true }), 30)],
  ['during the judgment (DS Bot\'s Stop)', ['decide', 1], agent => setTimeout(() => agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' }), 30)],
  ['while the thinking level for the pick is read', ['desiredEffort', 1], agent => agent.cancel({ kind: 'user' }, { keepInbox: true })],
  ['as the pick is selected', ['model/selection', 1], agent => agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })],
  ['while the hold is saved', ['save', 1], agent => agent.cancel({ kind: 'user' }, { keepInbox: true })],
]) {
  test(`a Stop ${what}: no model change, and the message stays in the chat`, async (t) => {
    const env = await bootAt(t, point, stop)
    env.agent.followup(userMessage('first'))
    await env.quiet()
    assert.deepEqual(env.calls, [])
    assert.equal(env.model(), 'flash')
    assert.equal(env.bot.appliedModel, `${PROVIDER}/flash`)
    assert.deepEqual(env.history(), ['first'])
    assert.equal(env.agent.inbox.hasPending, false)
    assert.equal(env.warnings.filter(line => /stopped|no judgment/.test(line)).length, 0)
    env.setPick('flash')
    env.agent.followup(userMessage('next'))
    await env.quiet()
    assert.deepEqual(env.calls, [{ model: 'flash', asked: ['first', 'next'], notices: 0 }])
  })
}

test('a Stop during a judgment that brings no answer: no model change, and the message stays', async (t) => {
  const env = await boot(t, { delayMs: 200 })
  env.setPick('none')
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await env.quiet()
  assert.deepEqual(env.calls, [])
  assert.equal(env.model(), 'flash')
  assert.deepEqual(env.history(), ['first'])
})

// Every point of the pick in turn, so an await added to it later is covered too.
test('a steer, a followup or a Stop at each point of the pick keeps every message once and in order', async (t) => {
  const points = await pointsOf(t)
  t.diagnostic(`points ${JSON.stringify(points)}`)
  assert.ok(points.length >= 8, 'the pick was instrumented')
  for (const point of points) {
    const where = point.join('#')
    // DSH refuses any inbox write while it publishes a Session event, so no input can
    // arrive as the model changes; a Stop can.
    for (const [kind, act] of point[0] === 'model/selection' ? [] : [
      ['steer', agent => agent.steer(userMessage('second'))],
      ['followup', agent => agent.followup(userMessage('second'))],
    ]) {
      const env = await bootAt(t, point, act)
      env.agent.followup(userMessage('first'))
      await env.quiet()
      assert.deepEqual(asked(env), ['first', 'second'], `${kind} at ${where}`)
      assert.ok(noticesMatch(env), `${kind} at ${where}: notices ${JSON.stringify(env.calls)}`)
      assert.equal(env.bot.appliedModel, `${PROVIDER}/${env.model()}`, `${kind} at ${where}`)
    }
    for (const [kind, stop] of [
      ['DSH Stop', agent => agent.cancel({ kind: 'user' }, { keepInbox: true })],
      // DS Bot's Stop (stopChat) cancels only a turn that is running.
      ['DS Bot Stop', agent => { if (agent.status === 'running') agent.cancel({ kind: 'user' }) }],
    ]) {
      let before
      const env = await bootAt(t, point, (agent) => { before = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length; stop(agent) })
      env.agent.followup(userMessage('first'))
      await env.quiet()
      const label = `${kind} at ${where}: ${JSON.stringify(env.calls)} history ${JSON.stringify(env.history())}`
      // Stopped in the first turn before the picker's listener ran, DSH drops the step
      // itself, as it does with Auto off (dsh-agent-loop, preStep).
      const unpicked = before === 0 && (point.join('#') === 'claimed#1' || point.join('#') === 'pre-step#1')
      assert.deepEqual(env.history(), unpicked ? [] : ['first'], label)
      assert.equal(env.agent.inbox.hasPending, false, label)
      assert.equal(env.bot.appliedModel, `${PROVIDER}/${env.model()}`, label)
      // A Stop before the held turn ended changes no model.
      if (before === 0) assert.deepEqual([env.calls, env.model()], [[], 'flash'], label)
      assert.ok(noticesMatch(env), label)
    }
  }
})
