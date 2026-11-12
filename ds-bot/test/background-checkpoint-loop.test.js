// Background checkpoints on DSH's real agent loop, token meter and compaction engine,
// with DS Bot's own parts.js on top: the checkpoint of a Bot's own chat is written while
// the owner goes on, and goes in at the next step with no model call of its own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { install as installParts } from '../src/host/parts.js'
import { install as installAutoModel } from '../src/host/auto-model.js'
import { CHECKPOINT_PROMPT } from '../src/host/steward.js'

const P = 'bg'
// 20,000-token window, no reply reserve: check line 16,000, hard line 19,000.
const WINDOW = 20_000
const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('')
const tick = ms => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (check, ms = 6000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await tick(5)
  assert.ok(check(), 'condition not reached')
}
const isCheckpoint = options => textOf(options.messages?.at(-1)).startsWith(CHECKPOINT_PROMPT)
const isSteward = options => typeof options.system === 'string' && options.system.startsWith('You are the context steward')

// One Bot 'b' whose own chat is Session 'b', on the real loop. Every model call is
// recorded. `env.steward` is the steward's answer; `env.gate` holds checkpoint calls
// while set; `env.answerSize` sets the characters of each answer. `skills`: that many
// skills in the real skill tool's catalog (about 128 tokens each).
async function boot(t, { bot: botFields = {}, local = false, readOnly, room = false, skills = 0, models = { m: WINDOW, big: 2 * WINDOW, tiny: 2_000 } } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const env = { calls: [], steward: 'compact', gate: undefined, answerSize: 6_000, checkpointText: 'S'.repeat(400), checkpointFail: 0, warnings: [], usage: [] }
  class Recorder extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: models[id] ?? WINDOW } } }
    async listModels() { return Object.keys(models).map(id => ({ id, name: id })) }
    async *stream(options) {
      const kind = isSteward(options) ? 'steward' : isCheckpoint(options) ? 'checkpoint' : 'turn'
      // `phase`: 'idle' for a background draft, 'maintenance' for the idle condense that
      // holds input back, 'running' inside a turn.
      const call = { kind, model: options.model, options, at: env.calls.length, phase: env.agent?.phase.kind }
      env.calls.push(call)
      let text
      if (kind === 'steward') text = JSON.stringify({ action: env.steward, reason: 'test' })
      else if (kind === 'checkpoint') {
        if (env.gate !== undefined) await Promise.race([env.gate.promise, new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }))])
        if (env.checkpointFail > 0) {
          env.checkpointFail -= 1
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'checkpoint failed' } } }
          return
        }
        text = env.checkpointText
      } else {
        const asked = (options.messages ?? []).filter(message => message.role === 'user' && message.source?.kind === 'user').map(textOf).at(-1) ?? ''
        text = `answer to ${asked} ${'x'.repeat(env.answerSize)}`
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([P], new Recorder())
  ctx.provide('workspaceRegistry', { unarchiveSession: async () => {}, archiveSession: async () => {} })
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  if (skills > 0) {
    provideWorkingDirectoryFixture(ctx)
    const list = Array.from({ length: skills }, (_, n) => ({ name: `skill-${n}`, provider: 'test', description: `skill ${n} ${'d'.repeat(480)}`, content: 'do it', invocation: { modelInvocable: true, userInvocable: true } }))
    ctx.provide('skills', { snapshot: async () => ({ skills: list, complete: true }), list: async () => list, get: async name => list.find(skill => skill.name === name) })
    await ctx.plugin(ToolSkill)
  }
  const bot = { id: 'b', name: 'Writer', role: 'Writes', createdAt: 1, ...botFields }
  const bots = new Map([['b', bot]])
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-bgcp-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), '{}')
  let agent
  const rt = {
    ctx,
    config: {},
    home,
    state: { switching: {}, questions: {}, prefs: { jev: true, modelNotes: { [`${P}/m`]: 'quick', [`${P}/big`]: 'hard', [`${P}/tiny`]: 'tiny' } } },
    load: async () => {},
    save: async () => {},
    readOnly: () => readOnly,
    warn: (template, ...args) => env.warnings.push(format(template, ...args)),
    botOf: id => bots.get(id),
    roomOf: () => undefined,
    chatOwners: room ? new Map() : new Map([['b', 'b']]),
    groupOwners: room ? new Map([['b', { botId: 'b', roomId: 'r1' }]]) : new Map(),
    roomOwners: new Map(),
    pastOwners: new Map(),
    chatOf: id => (room ? undefined : bots.get(id)?.sessionId ?? (bots.has(id) ? 'b' : undefined)),
    selfOf: id => (id === 'b' && !room ? 'b' : undefined),
    isBotSession: id => id === 'b',
    sessionOfRoom: () => undefined,
    groupSessionsOf: () => [],
    resolveAgent: async () => agent,
    liveOf: id => rt.live.get(id) ?? rt.live.set(id, {}).get(id),
    live: new Map(),
    isLocalAgentRef: () => local,
    hasSubagents: () => env.subagentOut === true,
    renewMemory: () => {},
    tagUsage: (messages, tag) => { env.usage.push(['tag', tag.kind]); return messages },
    labelUsage: (messages, kind) => { env.usage.push(['label', kind]); return messages },
    ownRequest: () => false,
    workDirOf: () => undefined,
    teamFolder: () => undefined,
    ensureWorkspace: async () => {},
    isFolder: async () => true,
    eventsBackwards: async function* () {
      const events = agent.session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) yield events[index]
    },
    desiredModel: async () => `${P}/m`,
    desiredEffort: async () => undefined,
    selectSessionModel: async (_id, { provider, model }) => agent.model.select({ provider, model }),
    applyModel: async () => {},
    applyPermission: async () => {},
    catalog: async () => [{ ref: `${P}/m`, name: 'M' }, { ref: `${P}/big`, name: 'Big' }, { ref: `${P}/tiny`, name: 'Tiny' }],
    decide: async () => env.pick === undefined ? null : ({ model: { type: 'choice', choice: env.pick, confidence: 0.9, probabilities: { [env.pick]: 0.9 } } }),
  }
  // Order as in index.js: auto-model installs before parts, whose own prepend runs first.
  if (botFields.auto === true) installAutoModel(rt)
  installParts(rt)
  await mountAgentLoopTestHarness(ctx)
  agent = await ctx.agentLoop.create(SessionId('b'), { provider: P, model: 'm' })
  env.agent = agent
  t.after(() => ctx.fiber.dispose())
  const events = () => agent.session.snapshotEvents()
  const types = () => events().map(event => event.type)
  const quiet = async () => {
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
    await tick(40)
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
  }
  const say = async (text) => {
    agent.followup(userMessage(text))
    await quiet()
  }
  const kinds = kind => env.calls.filter(call => call.kind === kind)
  const owner = () => events().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').map(event => textOf(event.data))
  const tokens = () => ctx.tokenMeter.measure(agent.session).totalTokens
  // Every compaction/start has its compaction/end.
  const balanced = () => types().filter(type => type === 'compaction/start').length === types().filter(type => type === 'compaction/end').length
  env.gateOn = () => { env.gate = Promise.withResolvers() }
  env.gateOff = () => { env.gate?.resolve(); env.gate = undefined }
  t.after(() => env.gateOff())
  return { ctx, rt, env, bot, bots, get agent() { return agent }, events, types, quiet, say, kinds, owner, tokens, balanced }
}

// Grows the chat past the check line (16,000) with turns of ~1,500 tokens.
async function grow(b, count = 11) {
  for (let index = 1; index <= count; index += 1) {
    b.agent.followup(userMessage(`m${index}`))
    await b.quiet()
  }
}

// 1-4. The steward says "compact": the checkpoint is written in the background, the
// next message runs at once, and the next step applies the held checkpoint.
test('stage 1: the checkpoint is written in the background and applied at the next step with no second call', async (t) => {
  const b = await boot(t)
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  assert.equal(b.kinds('steward').length, 1)
  // The draft writes nothing to the Session, and the Bot is idle, not in maintenance.
  const seq = b.agent.session.seq
  await tick(60)
  assert.equal(b.agent.session.seq, seq)
  assert.equal(b.agent.phase.kind, 'idle')
  assert.equal(b.types().includes('compaction/start'), false)
  // 4. Its request: the system head, the span, the last answer, then the prompt; the
  // Session's own route; labelled 'checkpoint'.
  const draft = b.kinds('checkpoint')[0].options
  assert.equal(draft.model, 'm')
  assert.equal(draft.provider, P)
  assert.equal(draft.purpose, 'compaction')
  assert.equal(draft.sessionId, 'b')
  assert.equal(b.kinds('checkpoint')[0].phase, 'idle', 'written outside maintenance')
  assert.deepEqual(b.env.usage.filter(([, kind]) => kind === 'checkpoint'), [['label', 'checkpoint']])
  // The turn just before the draft (the steward asks once the chat is near the check line).
  const turn = b.kinds('turn').filter(call => call.at < b.kinds('checkpoint')[0].at).at(-1).options
  const sent = draft.messages.slice(0, -1).map(message => [message.role, textOf(message)])
  const asked = turn.messages.map(message => [message.role, textOf(message)])
  assert.equal(draft.messages[0].role, 'system')
  assert.deepEqual(sent.slice(0, asked.length), asked, 'a prefix of the last request')
  assert.match(textOf(draft.messages.at(-1)), /stay right after your summary/)
  // 2. A message sent while the draft is written runs at once, once.
  const turnsBefore = b.kinds('turn').length
  b.agent.followup(userMessage('during the draft'))
  await b.quiet()
  assert.equal(b.kinds('turn').length, turnsBefore + 1)
  assert.equal(b.owner().filter(text => text === 'during the draft').length, 1)
  assert.equal(b.types().includes('compaction/start'), false)
  b.env.gateOff()
  await tick(50)
  // 3. The next step applies it: the bracket is there, no second checkpoint call.
  const checkpoints = b.kinds('checkpoint').length
  await b.say('after the draft')
  assert.equal(b.kinds('checkpoint').length, checkpoints)
  const start = b.types().indexOf('compaction/start')
  assert.ok(start !== -1)
  assert.deepEqual(b.types().slice(start, start + 4), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  assert.ok(b.balanced())
  // Every owner message is still there, in order, word for word.
  assert.deepEqual(b.owner().filter(text => !text.startsWith('m')), ['during the draft', 'after the draft'])
  assert.deepEqual(b.owner().filter(text => /^m\d+$/.test(text)), Array.from({ length: 11 }, (_, index) => `m${index + 1}`))
  assert.ok(b.tokens() < 16_000)
})

// Live check 3 #4: a message sent while the draft is written runs and is saved, after
// the span the draft condenses. It stays as its own node after the checkpoint, so the
// checkpoint's word-for-word list leaves it out; one sent before the draft is in it.
test('a message sent during the draft is in the next request once, and not in the checkpoint list', async (t) => {
  const b = await boot(t)
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await b.say('ZEBRA during the draft')
  b.env.gateOff()
  await tick(50)
  await b.say('after the draft')
  assert.equal(b.kinds('checkpoint').length, 1)
  // The user side of the request: the checkpoint and the messages after it.
  const sent = b.kinds('turn').at(-1).options.messages.filter(message => message.role === 'user').map(textOf)
  assert.equal(sent.join('\n').split('ZEBRA during the draft').length - 1, 1, 'once in the request')
  assert.ok(sent.includes('ZEBRA during the draft'), 'word for word, as its own message')
  const checkpoint = sent.find(text => text.includes('User: m11'))
  assert.ok(checkpoint !== undefined, 'a message from before the draft is kept')
  assert.equal(checkpoint.includes('ZEBRA'), false)
  assert.ok(b.balanced())
})

test('a message queued while the checkpoint applies goes on after it', async (t) => {
  const b = await boot(t)
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  let queued = false
  b.ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/start' && !queued) {
      queued = true
      queueMicrotask(() => b.agent.followup(userMessage('queued in the apply')))
    }
  })
  await b.say('next')
  await b.quiet()
  assert.ok(queued)
  assert.ok(b.types().includes('compaction/end'))
  assert.ok(b.balanced())
  assert.deepEqual(b.owner().slice(-2), ['next', 'queued in the apply'])
})

// 5. A pruned node in the span: the draft is dropped; the next check uses compactNow.
test('a node rewritten in the span drops the draft, and the part condenses the way it did before', async (t) => {
  const b = await boot(t)
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  // Rewrite one node of the span in place, as the tool-result pruner does.
  const session = b.agent.session
  const target = session.surface.nodes.find(seq => session.eventAt(seq).type === 'user/message' && textOf(session.eventAt(seq).data) === 'm2')
  session.append('user/message', { ...session.eventAt(target).data, content: [{ type: 'text', text: 'm2 (pruned)' }] }, { surfaceOp: { op: 'replace', startSeq: target, endSeq: target }, sourceEventSeqs: [target] })
  const checkpoints = b.kinds('checkpoint').length
  await b.say('next')
  await b.quiet()
  // Not applied from the stale draft; the next check condenses with compactNow (one
  // more checkpoint call, inside maintenance).
  const applied = b.events().find(event => event.type === 'compaction/summary')
  assert.ok(applied === undefined || b.kinds('checkpoint').length > checkpoints)
  await settle(() => b.types().includes('compaction/end'))
  assert.ok(b.balanced())
  assert.equal(b.kinds('checkpoint').length, checkpoints + 1)
  assert.ok(b.tokens() < 16_000)
})

// 7. Stop during the draft and during the apply.
test('a Stop during the draft leaves it running; a Stop during the apply loses nothing', async (t) => {
  const b = await boot(t)
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  b.agent.followup(userMessage('stopped one'))
  await settle(() => b.owner().includes('stopped one'))
  b.agent.cancel({ kind: 'user' })
  await b.quiet()
  assert.equal(b.kinds('checkpoint')[0].options.signal.aborted, false, 'a Stop of a turn does not abort the draft')
  b.env.gateOff()
  await tick(50)
  // A Stop at the apply: abort as the engine opens its bracket.
  let stopped = false
  b.ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/start' && !stopped) {
      stopped = true
      queueMicrotask(() => b.agent.cancel({ kind: 'user' }, { keepInbox: true }))
    }
  })
  b.agent.followup(userMessage('stopped at the apply'))
  await b.quiet()
  assert.ok(b.balanced())
  assert.ok(b.owner().includes('stopped one'))
  assert.ok(b.owner().includes('stopped at the apply'))
  // Nothing half-done: the part still works and makes room later.
  await b.say('after')
  assert.ok(b.balanced())
  assert.equal(b.owner().at(-1), 'after')
})

// 8. A summary that would leave the part above 0.75 × check: the foreground path.
test('a checkpoint that leaves the part too large is not used', async (t) => {
  const b = await boot(t)
  // ~13,000 tokens of summary: over 0.75 × 16,000 once the tail is added.
  b.env.checkpointText = 'S'.repeat(52_000)
  await grow(b)
  await settle(() => b.kinds('checkpoint').length >= 1)
  await b.quiet()
  await tick(50)
  // Not held for a step: the same check condensed in the foreground (compactNow) or moved on.
  assert.equal(b.kinds('checkpoint').length, 2)
  assert.ok(b.balanced())
})

// Every checkpoint call, with its cycle (the checkpoints already in the Session) and
// whether it is a draft: written outside a compaction bracket.
function cycles(b) {
  const seen = []
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    if (call.kind === 'checkpoint') {
      const types = b.types()
      const open = types.filter(type => type === 'compaction/start').length > types.filter(type => type === 'compaction/end').length
      seen.push({ cycle: types.filter(type => type === 'compaction/summary').length, draft: !open })
    }
    return push(call)
  }
  return seen
}
const draftsPerCycle = seen => Object.values(Object.groupBy(seen.filter(call => call.draft), call => call.cycle)).map(calls => calls.length)

// 8b. The 0.75 rule fails at every check while the owner writes during it. The first
// draft is dropped as too large; no draft follows (the same summary does not fit the
// span "compact" would draft either), so every checkpoint is a foreground one; as many
// checkpoints go in as before drafts (4358f654: 4).
test('a draft dropped as too large is not written again in the same cycle', async (t) => {
  const b = await boot(t)
  const seen = cycles(b)
  b.env.checkpointText = 'S'.repeat(52_000)
  let busy = 0
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    if (call.kind === 'steward' && busy < 6) {
      busy += 1
      queueMicrotask(() => b.agent.followup(userMessage(`busy${busy}`)))
    }
    return push(call)
  }
  await grow(b)
  for (let index = 0; index < 6; index += 1) await b.say(`more${index}`)
  await b.quiet()
  await tick(80)
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 4)
  assert.ok(draftsPerCycle(seen).every(count => count === 1), JSON.stringify(seen))
  assert.equal(seen.length, 5, JSON.stringify(seen))
  assert.ok(b.balanced())
})

// 8c. The engine turns the apply down: the part's next checkpoint is made with compactNow,
// once, and no new draft starts at the idle checks after it.
test('a refused apply: the next checkpoint is made the way it was before drafts, and no draft starts again', async (t) => {
  const b = await boot(t)
  const seen = cycles(b)
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  const engine = b.ctx.get('compaction')
  const compactRegion = engine.compactRegion
  const compactNow = engine.compactNow
  let refused = 0
  let nows = 0
  engine.compactRegion = function () { refused += 1; return Promise.reject(new Error('refused')) }
  engine.compactNow = function (...args) { nows += 1; return compactNow.apply(this, args) }
  t.after(() => { engine.compactRegion = compactRegion; engine.compactNow = compactNow })
  // The step goes on without it; the idle check at the end of the turn condenses in the
  // foreground (the turn is still past the check line), with no new draft first.
  await b.say('refused')
  assert.equal(refused, 1)
  assert.equal(nows, 1)
  assert.deepEqual(seen, [{ cycle: 0, draft: true }, { cycle: 0, draft: false }])
  // Five idle checks after it, below the check line: nothing more is written.
  b.env.answerSize = 100
  for (let index = 0; index < 5; index += 1) await b.say(`idle${index}`)
  await tick(50)
  assert.equal(nows, 1)
  assert.equal(seen.length, 2, JSON.stringify(seen))
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 1)
  assert.ok(b.balanced())
})

// 8d. A draft cut off by /new is not a failure: the new part drafts as any part does.
test('a draft aborted by /new does not count against the next one', async (t) => {
  const b = await boot(t, { bot: { segments: [{ sessionId: 'old', endedAt: 1 }] } })
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await b.rt.newSession('b').catch(() => {})
  assert.equal(b.kinds('checkpoint')[0].options.signal.aborted, true)
  b.env.gateOff()
  assert.equal(b.env.warnings.some(line => /background checkpoint for b failed/.test(line)), false)
})

// 9. A failed draft: the same check falls back to the idle condense, as before (the
// count of failures in a row is in the unit test below).
test('a failed draft falls back to the idle condense', async (t) => {
  const b = await boot(t)
  b.env.checkpointFail = 1
  await grow(b)
  await settle(() => b.types().includes('compaction/end'))
  await b.quiet()
  // The background attempt failed; the same check condensed in maintenance.
  assert.deepEqual(b.kinds('checkpoint').map(call => call.phase), ['idle', 'maintenance'])
  assert.ok(b.balanced())
  assert.equal(b.env.warnings.filter(line => /background checkpoint for b failed/.test(line)).length, 1)
})

// 10. A model change between the draft and the apply: lines for the new route.
test('a model chosen after the draft: applied once, with the lines of the new model', async (t) => {
  const b = await boot(t)
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  b.agent.model.select({ provider: P, model: 'big' })
  await b.say('on the big model')
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 1)
  assert.equal(b.kinds('checkpoint').length, 1)
  assert.equal(b.kinds('turn').at(-1).model, 'big')
})

test('a model whose window the checkpoint does not fit under drops it', async (t) => {
  const b = await boot(t)
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  // 2,000 window: check 1,600; what stays after the checkpoint is more than 0.75 of it.
  b.agent.model.select({ provider: P, model: 'tiny' })
  await b.say('on the tiny model')
  await b.quiet()
  // The held one was not applied: the one checkpoint in the Session was written again, in
  // the foreground, for the new model.
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 1)
  assert.deepEqual(b.kinds('checkpoint').map(call => `${call.model}:${call.phase}`), ['m:idle', 'tiny:maintenance'])
  assert.ok(b.balanced())
})

test('an Auto pick that holds the step: the checkpoint goes in once, at the step the pick wakes', async (t) => {
  const b = await boot(t, { bot: { auto: true, appliedModel: `${P}/m` } })
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  b.env.pick = `${P}/big`
  await b.say('pick a model')
  await b.quiet()
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 1)
  assert.equal(b.kinds('checkpoint').length, 1)
  assert.equal(b.kinds('turn').at(-1).model, 'big')
  assert.equal(b.owner().filter(text => text === 'pick a model').length, 1)
  assert.ok(b.balanced())
})

test('an Auto pick to a model the checkpoint does not fit: the held one is not used', async (t) => {
  const b = await boot(t, { bot: { auto: true, appliedModel: `${P}/m` } })
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  b.env.pick = `${P}/tiny`
  await b.say('pick the tiny model')
  await b.quiet()
  // Not applied at the step on the tiny model: any checkpoint in the Session was written again.
  const summaries = b.types().filter(type => type === 'compaction/summary').length
  assert.equal(summaries, b.kinds('checkpoint').filter(call => call.phase !== 'idle').length)
  assert.equal(b.kinds('turn').at(-1).model, 'tiny')
  assert.equal(b.owner().filter(text => text === 'pick the tiny model').length, 1)
  assert.ok(b.balanced())
})

// A Stop as the checkpoint goes in, at the step an Auto pick woke: the message is kept
// once (the picker and the apply each keep a stopped message).
test('a Stop during the apply on the turn an Auto pick woke keeps the message once', async (t) => {
  const b = await boot(t, { bot: { auto: true, appliedModel: `${P}/m` } })
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  await tick(30)
  b.env.pick = `${P}/big`
  let stopped = false
  b.ctx.on('session/event', (_session, event) => {
    if (event.type === 'compaction/start' && !stopped) {
      stopped = true
      queueMicrotask(() => b.agent.cancel({ kind: 'user' }, { keepInbox: true }))
    }
  })
  b.agent.followup(userMessage('picked then stopped'))
  await b.quiet()
  await tick(50)
  await b.quiet()
  assert.ok(stopped)
  assert.equal(b.owner().filter(text => text === 'picked then stopped').length, 1)
  assert.equal(b.agent.session.deriveMessages().filter(message => message.role === 'user' && textOf(message) === 'picked then stopped').length, 1)
  assert.ok(b.balanced())
})

test('a Stop at the step an Auto pick woke, with no checkpoint held, keeps the message once', async (t) => {
  const b = await boot(t, { bot: { auto: true, appliedModel: `${P}/m` } })
  await b.say('m1')
  b.env.pick = `${P}/big`
  // Runs inside the picker's held step, after parts.js, as the apply does.
  let stopped = false
  b.ctx.on('agent/pre-step', (payload, next) => {
    if (!stopped && payload.messages.some(message => textOf(message) === 'picked then stopped')) {
      stopped = true
      b.agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    return next()
  })
  b.agent.followup(userMessage('picked then stopped'))
  await b.quiet()
  await tick(50)
  await b.quiet()
  assert.ok(stopped)
  assert.equal(b.kinds('checkpoint').length, 0)
  assert.equal(b.owner().filter(text => text === 'picked then stopped').length, 1)
  assert.equal(b.agent.session.deriveMessages().filter(message => message.role === 'user' && textOf(message) === 'picked then stopped').length, 1)
  assert.equal(b.kinds('turn').at(-1).model, 'm', 'the stopped pick is undone')
})

// 11. Dispose while a draft runs: aborted, nothing written.
test('the plugin stops while a draft runs: it is aborted and writes nothing', async (t) => {
  const b = await boot(t)
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  const seq = b.agent.session.seq
  const signal = b.kinds('checkpoint')[0].options.signal
  // The fork's effects end with the plugin: here the whole context goes.
  await b.ctx.fiber.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(b.agent.session.seq, seq)
  assert.equal(b.types().includes('compaction/start'), false)
})

test('a deleted Bot: its stopped Session drops the draft, and nothing is written', async (t) => {
  const b = await boot(t)
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  const signal = b.kinds('checkpoint')[0].options.signal
  b.bots.delete('b')
  await b.ctx.parallel('workspace/session-stop', { sessionId: 'b' })
  await tick(50)
  assert.equal(b.types().includes('compaction/start'), false)
  assert.equal(b.kinds('checkpoint').length, 1)
  assert.equal(signal.aborted, true)
})

// 12. The steward says "switch": no draft; the switch goes on as before.
test('the steward says switch: no summary request', async (t) => {
  const b = await boot(t)
  b.env.steward = 'switch'
  await grow(b)
  await settle(() => b.kinds('steward').length === 1)
  await b.say('next')
  assert.equal(b.types().includes('compaction/start'), false)
  assert.equal(b.kinds('checkpoint').length, 0)
})

// 13. No draft for a group Session, a local agent, or read-only mode.
for (const [name, options] of [['a group Session', { room: true }], ['a local agent', { local: true }], ['read-only mode', { readOnly: 'test' }]]) {
  test(`no background checkpoint for ${name}`, async (t) => {
    const b = await boot(t, options)
    await grow(b)
    await b.quiet()
    await tick(80)
    // No summary request while the Bot is idle: whatever condensing ran, ran in the
    // foreground as before.
    const summaries = b.env.calls.filter(call => call.options.purpose === 'compaction' && call.kind !== 'steward')
    assert.equal(summaries.some(call => call.phase === 'idle'), false)
    if (options.room === true) assert.ok(summaries.length > 0, 'the group Session still condenses')
    else assert.equal(summaries.length, 0)
  })
}

// 14. Hard line reached in a turn with no ready draft: the in-turn condense runs.
test('past the hard line in a turn with no draft ready, the turn condenses as before', async (t) => {
  const b = await boot(t)
  b.env.answerSize = 2_000
  b.env.steward = 'compact'
  // Below the check line at idle (no draft), then one big message over the hard line.
  await grow(b, 3)
  const big = 'y'.repeat(70_000)
  await b.say(big)
  await b.quiet()
  assert.ok(b.types().includes('compaction/end'))
  assert.ok(b.balanced())
  assert.ok(b.owner().includes(big))
})

// 6. Part switch while the draft runs: never applied to the new part.
test('a part switch while the draft runs throws it away', async (t) => {
  const b = await boot(t)
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('checkpoint').length === 1)
  const signal = b.kinds('checkpoint')[0].options.signal
  // switchPart, /new and a switch drop the draft first; here the part is not the Bot's
  // current chat when the draft returns, so it is not kept, even once the part is
  // current again (opened again from the earlier parts).
  b.bot.sessionId = 'other'
  b.env.gateOff()
  await tick(50)
  delete b.bot.sessionId
  await b.say('after the switch')
  assert.equal(signal.aborted, false)
  const applied = b.events().findIndex(event => event.type === 'compaction/summary')
  // The draft is gone: the part checks again and writes a fresh one, held for the next step.
  assert.equal(applied, -1)
  assert.equal(b.kinds('checkpoint').length, 2)
  await b.say('next')
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 1)
  assert.equal(b.kinds('checkpoint').length, 2)
})

for (const [name, act] of [
  ['switchPart', b => b.rt.switchPart('b', 'old')],
  ['/new', b => b.rt.newSession('b').catch(() => {})],
]) {
  test(`${name} while the draft runs drops it`, async (t) => {
    const b = await boot(t, { bot: { segments: [{ sessionId: 'old', endedAt: 1 }] } })
    b.env.gateOn()
    await grow(b)
    await settle(() => b.kinds('checkpoint').length === 1)
    const signal = b.kinds('checkpoint')[0].options.signal
    await act(b)
    assert.equal(signal.aborted, true)
    b.env.gateOff()
    await tick(30)
    assert.equal(b.types().includes('compaction/start'), false)
  })
}

// The checkpoint and steward calls in order, as `s<n>` and `cD<n>`/`cF<n>` (a draft, or
// one written inside a compaction bracket), `n` being the checkpoints already made.
function calls(b) {
  const seen = []
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    const types = b.types()
    const n = types.filter(type => type === 'compaction/summary').length
    const open = types.filter(type => type === 'compaction/start').length > types.filter(type => type === 'compaction/end').length
    if (call.kind === 'steward') seen.push(`s${n}`)
    if (call.kind === 'checkpoint') seen.push(`c${open ? 'F' : 'D'}${n}`)
    return push(call)
  }
  return seen
}
const summaries = b => b.types().filter(type => type === 'compaction/summary').length

// Review 2 C1: a summary over the 0.75 share in every cycle. One draft is wasted, then
// every checkpoint is made with compactNow and no draft before it.
test('drafts that never fit are paid for once, not in every cycle', async (t) => {
  const b = await boot(t)
  const seen = calls(b)
  b.env.checkpointText = 'S'.repeat(52_000)
  for (let index = 1; index <= 60; index += 1) await b.say(`m${index}`)
  await tick(50)
  const made = summaries(b)
  assert.ok(made >= 10, `checkpoints ${made}`)
  assert.ok(seen.filter(call => call[0] === 'c').length <= made + 1, seen.join(' '))
  assert.ok(b.balanced())
})

// Review 2 C2, 6,000-character answers: every draft fits; one call per checkpoint.
test('drafts that fit: one draft per checkpoint, written after the steward call', async (t) => {
  const b = await boot(t)
  const seen = calls(b)
  for (let index = 1; index <= 50; index += 1) await b.say(`m${index}`)
  await tick(50)
  const checkpoints = seen.filter(call => call[0] === 'c')
  const made = summaries(b)
  assert.ok(made >= 4, seen.join(' '))
  // Each draft is written at "compact", after its cycle's steward call, and applied.
  assert.equal(seen.join(' '), Array.from({ length: made }, (_, n) => `s${n} cD${n}`).join(' '))
  assert.ok(checkpoints.length === made)
})

// A required runtime-context snapshot: each checkpoint condenses it, and DSH puts it back
// at the next step, so it is never freed. `words` sets its size in tokens (about 1 each).
const snapshot = (b, words) => b.ctx.systemPrompt.context({ name: 'zz-ctx', order: 10, required: true, interpolate: false, text: 'ctx '.repeat(words) })
// The context size at each turn request, read when the request is sent.
const requestSizes = (b) => {
  const sizes = []
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    if (call.kind === 'turn') sizes.push(b.tokens())
    return push(call)
  }
  return sizes
}

// Review L1: a snapshot that keeps the part at about 80% of its check line after each
// checkpoint. No checkpoint can fit under 0.75 x check, so the part makes one summary per
// checkpoint, as before drafts, and not two; the steward is not asked again at the next
// turn after a checkpoint.
test('a large runtime context that comes back is not counted as freed', async (t) => {
  const b = await boot(t)
  const seen = calls(b)
  // The turn requests sent before each steward call.
  const turns = []
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    if (call.kind === 'steward') turns.push(b.kinds('turn').length)
    return push(call)
  }
  b.env.answerSize = 2_000
  snapshot(b, 11_500)
  // About 8 cycles of 7 turns each.
  const index = 58
  for (let n = 1; n <= index; n += 1) await b.say(`m${n}`)
  await tick(50)
  const made = summaries(b)
  assert.ok(made >= 7 && made <= 9, `checkpoints ${made}: ${seen.join(' ')}`)
  assert.ok(seen.filter(call => call[0] === 'c').length <= made + 2, seen.join(' '))
  assert.ok(seen.filter(call => call[0] === 's').length <= made + 2, seen.join(' '))
  // A checkpoint that frees nothing that stays freed has the steward asked again at the
  // next turn.
  for (let n = 1; n < turns.length; n += 1) assert.ok(turns[n] - turns[n - 1] >= 2, `steward at turns ${turns.join(',')}`)
  const said = b.owner()
  assert.deepEqual(said, Array.from({ length: index }, (_, n) => `m${n + 1}`))
  assert.ok(b.balanced())
})

// A moderate snapshot (about 20% of check): every checkpoint still goes in in the
// background with one request per cycle, and the part's base counts the snapshot.
test('a moderate runtime context: background checkpoints in every cycle, sized with it', async (t) => {
  const b = await boot(t)
  const seen = calls(b)
  const sizes = requestSizes(b)
  const applied = []
  const info = b.ctx.logger.info.bind(b.ctx.logger)
  b.ctx.logger.info = (template, ...args) => {
    if (String(template).includes('applied its background checkpoint')) applied.push({ after: args[2], turn: sizes.length })
    return info(template, ...args)
  }
  b.env.answerSize = 2_000
  snapshot(b, 3_200)
  let index = 0
  while (summaries(b) < 6 && index < 200) { index += 1; await b.say(`m${index}`) }
  await tick(50)
  const checkpoints = seen.filter(call => call[0] === 'c')
  assert.equal(summaries(b), 6)
  assert.ok(checkpoints.every(call => call.startsWith('cD')), seen.join(' '))
  assert.ok(checkpoints.length <= 7, seen.join(' '))
  assert.equal(applied.length, 6)
  // The apply runs before the step that sends the request at `turn`.
  for (const { after, turn } of applied) assert.ok(Math.abs(after - sizes[turn]) <= 0.05 * sizes[turn], `${after} vs ${sizes[turn]}`)
})

// Review 3 M1: one summary too large in the first cycle, normal ones after. The size mark
// follows the checkpoints made without a draft, so background checkpoints come back.
test('after one summary too large, background checkpoints come back', async (t) => {
  const b = await boot(t)
  const seen = calls(b)
  b.env.checkpointText = 'S'.repeat(52_000)
  let index = 0
  while (summaries(b) === 0 && index < 40) { index += 1; await b.say(`m${index}`) }
  b.env.checkpointText = 'S'.repeat(400)
  for (let n = 1; n <= 50; n += 1) await b.say(`n${n}`)
  await tick(50)
  const later = seen.slice(seen.indexOf('s1'))
  assert.ok(later.filter(call => call.startsWith('cD')).length >= 3, seen.join(' '))
  assert.ok(seen.filter(call => call[0] === 'c').length <= summaries(b) + 2, seen.join(' '))
  assert.ok(b.balanced())
})

// Review 4 I3: runtime-context snapshots that put the floor (the size right after a
// checkpoint) at about 30%, 60% and 72% of the check line.
async function floorRun(t, words, cycles = 8) {
  const b = await boot(t)
  const seen = calls(b)
  let applied = 0
  const info = b.ctx.logger.info.bind(b.ctx.logger)
  b.ctx.logger.info = (template, ...args) => {
    if (String(template).includes('applied its background checkpoint')) applied += 1
    return info(template, ...args)
  }
  b.env.answerSize = 2_000
  b.ctx.systemPrompt.context({ name: 'zz-ctx', order: 10, required: true, interpolate: false, text: 'zz-ctx '.repeat(words) })
  let index = 0
  while (summaries(b) < cycles && index < 200) { index += 1; await b.say(`m${index}`) }
  await tick(50)
  const made = summaries(b)
  const drafts = seen.filter(call => call.startsWith('cD')).length
  const blocking = seen.filter(call => call.startsWith('cF')).length
  assert.equal(made, cycles)
  assert.ok(b.balanced())
  console.log(`floor ${words}: calls ${drafts + blocking} checkpoints ${made} background ${applied} blocking ${blocking}: ${seen.join(' ')}`)
  return { seen, made, drafts, blocking, applied }
}
for (const [words, pct] of [[4700, 60], [5910, 72]]) {
  test(`floor at about ${pct}% of check: at most one summary request per checkpoint, at most one blocking`, async (t) => {
    const { seen, made, drafts, blocking } = await floorRun(t, words)
    assert.ok(drafts + blocking <= made + 1, `calls ${drafts + blocking}: ${seen.join(' ')}`)
    assert.ok(blocking <= 1, seen.join(' '))
  })
}
test('floor at about 30% of check: every draft is applied, none blocks', async (t) => {
  const { seen, made, drafts, blocking, applied } = await floorRun(t, 1_600)
  assert.equal(blocking, 0, seen.join(' '))
  assert.equal(applied, made, seen.join(' '))
  assert.ok(drafts <= made, seen.join(' '))
})

// Live check 3 (80,000-token window): a node that a checkpoint condenses and DSH puts
// back at the next step. `skills`: the real skill tool's catalog with that many skills
// (about 128 tokens each); `summary`: the characters of each summary. Both set the floor,
// the size at the first turn after a checkpoint. The calls are listed in order (`t` a
// turn). A cycle is one steward episode: steward calls with at most one turn between
// them, as the app's log counts them (one swap each).
async function floorCycles(t, { skills = 0, summary = 400, cycles = 6 } = {}) {
  const b = await boot(t, { skills })
  const seen = calls(b)
  let applied = 0
  const info = b.ctx.logger.info.bind(b.ctx.logger)
  b.ctx.logger.info = (template, ...args) => {
    if (String(template).includes('applied its background checkpoint')) applied += 1
    return info(template, ...args)
  }
  const push = b.env.calls.push.bind(b.env.calls)
  const sizes = []
  b.env.calls.push = (call) => {
    if (call.kind === 'turn') {
      seen.push('t')
      sizes.push({ tokens: b.tokens(), made: summaries(b) })
    }
    return push(call)
  }
  // Steward calls with at most one turn since the one before: asked again at once.
  const again = () => seen.filter(call => call[0] === 's' || call === 't').filter((call, n, order) => call[0] === 's' && n >= 1 && (order[n - 1][0] === 's' || (n >= 2 && order[n - 2][0] === 's'))).length
  const episodes = () => seen.filter(call => call[0] === 's').length - again()
  b.env.answerSize = 2_000
  b.env.checkpointText = 'S'.repeat(summary)
  let index = 0
  // Until the cycle after the last one starts: its steward call ends the count.
  while (episodes() <= cycles && index < 250) { index += 1; await b.say(`m${index}`) }
  // The calls of the cycles counted: up to the first steward call of the next one.
  const cut = seen.findLastIndex(call => call[0] === 's')
  const counted = seen.slice(0, cut)
  const made = summaries(b)
  const requests = counted.filter(call => call[0] === 'c').length
  const stewards = counted.filter(call => call[0] === 's').length
  const turns = counted.filter(call => call === 't').length
  const floors = Array.from({ length: made }, (_, n) => sizes.find(size => size.made === n + 1)?.tokens).filter(size => size !== undefined)
  const floor = Math.round(100 * floors.reduce((total, size) => total + size, 0) / floors.length / 16_000)
  assert.deepEqual(b.owner(), Array.from({ length: index }, (_, n) => `m${n + 1}`))
  assert.ok(b.balanced())
  const result = { cycles, requests, stewards, again: again(), floor, turns, made, applied }
  const line = `skills ${skills} summary ${summary}: floor ${floor}% cycles ${cycles} turns ${turns} summary requests ${requests} steward ${stewards} steward-again ${result.again} applied ${applied} of ${made}: ${counted.join(' ')}`
  console.log(line)
  return { ...result, b, seen, line }
}
// About 80% and 30% floors, with the skill catalog and with no node put back (a summary
// of that size instead).
const floorCases = [
  ['the skill catalog, floor about 62% (the app at a 160,000 window)', { skills: 67 }],
  ['the skill catalog, floor about 80%', { skills: 90 }],
  ['the skill catalog, floor about 86%', { skills: 99 }],
  ['the skill catalog, floor about 97%', { skills: 113 }],
  ['the skill catalog, floor about 30%', { skills: 30 }],
  ['no node put back, floor about 80%', { summary: 48_000 }],
  ['no node put back, floor about 30%', { summary: 14_000 }],
]
for (const [name, options] of floorCases) {
  test(`${name}: at most one summary request and one steward call per cycle`, async (t) => {
    const { cycles, requests, stewards, again, made, applied, floor, line } = await floorCycles(t, options)
    assert.ok(requests <= cycles + 1, line)
    assert.ok(stewards <= cycles + 1, line)
    assert.equal(again, 0, line)
    // Under 75% every checkpoint goes in in the background. At or above it none fits
    // under 0.75 x check: one draft is dropped, then the idle condense runs once a cycle.
    if (floor < 75) assert.equal(applied, made, line)
    else assert.equal(applied, 0, line)
  })
}

// The floor at about 30% with the skill catalog: a message sent while the summary is
// written is answered before it ends.
test('the skill catalog, floor about 30%: a message during the summary is answered at once', async (t) => {
  const b = await boot(t, { skills: 30 })
  b.env.answerSize = 2_000
  let index = 0
  // Through the first checkpoint, then gate the next one.
  while (summaries(b) < 1 && index < 100) { index += 1; await b.say(`m${index}`) }
  b.env.gateOn()
  const before = b.kinds('checkpoint').length
  while (b.kinds('checkpoint').length === before && index < 200) { index += 1; await b.say(`m${index}`) }
  const turns = b.kinds('turn').length
  b.agent.followup(userMessage('during the summary'))
  await b.quiet()
  assert.equal(b.kinds('turn').length, turns + 1)
  const answer = b.events().findLast(event => event.type === 'assistant/message').data
  assert.ok(textOf(answer.message ?? answer).startsWith('answer to during the summary'))
  assert.equal(summaries(b), 1, 'the summary has not ended')
  b.env.gateOff()
  await tick(30)
  await b.say('after')
  assert.equal(summaries(b), 2)
  assert.equal(b.kinds('checkpoint').length, before + 1)
  assert.ok(b.balanced())
})

// The steward calls between the turns: one count for each turn (the calls before it
// since the turn before).
const stewardsPerTurn = seen => seen.join(' ').split(/\bt\b/).map(part => part.split(' ').filter(call => call[0] === 's').length)

// A floor at about 97% of the check line (the real skill catalog is put back after every
// checkpoint): the blocking checkpoint's base counts what DSH puts back, so the next turn
// does not ask the steward and condense again.
test('a floor near the check line: no steward call on two turns in a row', async (t) => {
  const b = await boot(t, { skills: 117 })
  const seen = calls(b)
  const push = b.env.calls.push.bind(b.env.calls)
  const sizes = []
  b.env.calls.push = (call) => {
    if (call.kind === 'turn') { seen.push('t'); sizes.push(b.tokens()) }
    return push(call)
  }
  b.env.answerSize = 2_000
  for (let index = 1; index <= 8; index += 1) await b.say(`m${index}`)
  const perTurn = stewardsPerTurn(seen)
  console.log(`floor-97 steward per turn ${perTurn.join(',')} sizes ${sizes.join(',')} ${seen.join(' ')}`)
  for (let n = 1; n < perTurn.length; n += 1) assert.ok(perTurn[n - 1] === 0 || perTurn[n] === 0, `steward on turns ${n} and ${n + 1}: ${seen.join(' ')}`)
  assert.ok(summaries(b) >= 1)
  assert.ok(b.balanced())
})

// Fixed content above the check line (128 skills, about 107%): a move cannot bring the
// part under the line, so the fresh part's opening turn does not ask the steward and move
// on again by itself. Every model call follows an owner message.
// Fresh parts on `b`: the move to a fresh part makes 'b-fresh<n>' (at most `cap`), and
// the handoff note is written with no model call. `enforce`: a turn request over the
// window fails with CONTEXT_WINDOW_EXCEEDED, as a real route does. Each turn is `t` in
// `seen`, a failed one `X`.
function freshParts(b, seen, { cap = 5, enforce = false } = {}) {
  Object.assign(b.rt, { ensureCapabilities: async () => {}, moveSchedules: async () => {}, keepTeamFolder: () => {}, own: () => true })
  const fresh = new Map()
  const isPart = id => id === 'b' || /^b-fresh/.test(id)
  b.rt.isBotSession = isPart
  b.rt.selfOf = id => (isPart(id) ? 'b' : undefined)
  b.rt.resolveAgent = async id => (id === 'b' || id === undefined ? b.agent : fresh.get(id) ?? fresh.set(id, await b.ctx.agentLoop.create(SessionId(id), { provider: P, model: 'm' })).get(id))
  let made = 0
  b.rt.createSession = async () => {
    if (made >= cap) throw new Error(`${cap} fresh parts`)
    made += 1
    seen.push('NEW')
    b.rt.chatOwners.set(`b-fresh${made}`, 'b')
    return `b-fresh${made}`
  }
  const note = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look'].map(name => `## ${name}\n- (none)`).join('\n\n')
  const stream = b.ctx.llm.stream.bind(b.ctx.llm)
  b.ctx.llm.stream = (options) => {
    if (!textOf(options.messages?.at(-1)).startsWith('You are now writing a handoff note')) return stream(options)
    seen.push('H')
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: note }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: note } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  const adapter = b.ctx.llm.adapters.get(P).adapter
  const inner = adapter.stream.bind(adapter)
  adapter.stream = (options) => {
    const session = options.sessionId === 'b' ? b.agent.session : fresh.get(options.sessionId)?.session
    if (!enforce || isSteward(options) || isCheckpoint(options) || session === undefined || b.ctx.tokenMeter.measure(session).totalTokens <= WINDOW) return inner(options)
    seen.push('X')
    if (seen.filter(call => call === 'X').length > 60) throw new Error('60 failed requests')
    return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context window exceeded' } } } })()
  }
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    if (call.kind === 'turn') seen.push('t')
    return push(call)
  }
  const current = () => b.rt.resolveAgent(b.bot.sessionId)
  const say = async (text) => {
    const agent = await current()
    agent.followup(userMessage(text))
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
    await tick(60)
    const now = await current()
    await settle(() => now.status === 'idle' && !now.inbox.hasPending)
  }
  return { say, current, made: () => made }
}

// Fixed content above the check line (128 skills, about 107%): a move cannot bring the
// part under the line, so the fresh part's opening turn does not ask the steward and move
// on again by itself. Every model call follows an owner message.
test('a base above the check line: a fresh part does not move on again by itself', async (t) => {
  const b = await boot(t, { skills: 128 })
  const seen = calls(b)
  const parts = freshParts(b, seen)
  b.env.answerSize = 2_000
  for (let index = 1; index <= 8; index += 1) await parts.say(`m${index}`)
  await tick(100)
  const order = seen.join(' ')
  const perTurn = stewardsPerTurn(seen)
  assert.equal(seen.filter(call => call === 't').length, 8, order)
  assert.ok(order.split(/\bt\b/).every(part => part.split(' ').filter(call => call === 'NEW').length <= 1), order)
  for (let n = 1; n < perTurn.length; n += 1) assert.ok(perTurn[n] <= 1 && (perTurn[n - 1] === 0 || perTurn[n] === 0), `steward on turns ${n} and ${n + 1}: ${order}`)
  assert.equal(b.env.warnings.length, 0, b.env.warnings.join('\n'))
})

// Fixed content above the window (150 skills) and a route that refuses a request over
// it: what DSH puts back in a fresh part is not freed by the move, so an overflow does
// not move on from one fresh part to the next.
test('fixed content above the window: an overflow does not move on to fresh part after fresh part', async (t) => {
  const b = await boot(t, { skills: 150 })
  const seen = calls(b)
  const parts = freshParts(b, seen, { cap: 40, enforce: true })
  b.env.answerSize = 2_000
  for (let index = 1; index <= 4; index += 1) {
    await parts.say(`m${index}`)
    seen.push('|')
  }
  await tick(100)
  const order = seen.join(' ')
  console.log(`window-150: fresh ${parts.made()} failed ${seen.filter(call => call === 'X').length}: ${order}`)
  assert.ok(order.split('|').every(part => part.split(' ').filter(call => call === 'NEW').length <= 1), order)
  assert.ok(seen.filter(call => call === 'X').length <= 4, order)
})

// Live check 4 (80,000 window): blocking checkpoints leave the part at about 98% of the
// check line (113 skills), and each owner turn adds about 6% of it (3,700-character
// answers). The steward runs by the hard line, so the part never reaches the window and
// never moves on.
test('a base just under the check line: the steward runs by the hard line, not past the window', async (t) => {
  const b = await boot(t, { skills: 113 })
  const seen = calls(b)
  const parts = freshParts(b, seen, { enforce: true })
  // The chat's size at each steward call: the summary request after it carries as much.
  const at = []
  const push = b.env.calls.push.bind(b.env.calls)
  b.env.calls.push = (call) => {
    if (call.kind === 'steward') at.push(b.tokens())
    return push(call)
  }
  b.env.answerSize = 3_700
  for (let index = 1; index <= 24; index += 1) await parts.say(`m${index}`)
  await tick(100)
  const order = `${seen.join(' ')} steward at ${at.join(',')}`
  assert.ok(at.every(size => size < WINDOW), order)
  assert.ok(summaries(b) >= 5, order)
  assert.equal(parts.made(), 0, order)
  assert.ok(!seen.includes('X'), order)
  assert.ok(seen.filter(call => call[0] === 's').length <= summaries(b) + 1, order)
  assert.deepEqual(b.owner(), Array.from({ length: 24 }, (_, n) => `m${n + 1}`))
})

// Review 6 F3 (a3-big): owner message 3 overflows once, so the part moves on with the
// latest messages, and the fresh part's opening answer ends at about 16,800 of 20,000.
// Its base is its size at the opening turn's first request, so that turn's end asks the
// steward; the part does not grow on to the window and move again with no note.
test('a fresh part whose opening answer is large asks the steward at that turn\'s end', async (t) => {
  const b = await boot(t)
  const seen = calls(b)
  const parts = freshParts(b, seen, { enforce: true })
  const adapter = b.ctx.llm.adapters.get(P).adapter
  const stream = adapter.stream.bind(adapter)
  let fail = false
  adapter.stream = (options) => {
    if (!fail || isSteward(options) || isCheckpoint(options)) return stream(options)
    fail = false
    seen.push('X')
    return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context window exceeded' } } } })()
  }
  for (let index = 1; index <= 10; index += 1) {
    fail = index === 3
    b.env.answerSize = index === 3 ? 62_000 : 2_000
    await parts.say(`m${index}`)
    seen.push('|')
  }
  await tick(100)
  const order = seen.join(' ')
  // Owner message 3: the overflow, the move, the opening turn, then the steward.
  const opening = order.split('|')[2].trim().split(' ')
  assert.deepEqual(opening.slice(0, 4), ['X', 'NEW', 't', 's0'], order)
  assert.equal(parts.made(), 1, order)
  assert.equal(seen.filter(call => call === 'X').length, 1, order)
})
