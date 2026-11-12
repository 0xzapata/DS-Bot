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
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
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
// while set; `env.answerSize` sets the characters of each answer.
async function boot(t, { bot: botFields = {}, local = false, readOnly, room = false, models = { m: WINDOW, big: 2 * WINDOW, tiny: 2_000 } } = {}) {
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
  // The turn just before the draft (from the draft line on, that is before the check line).
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

// 9. A failed draft: the same check falls back to the idle condense, as before (the
// count of failures in a row is in the unit test below).
test('failed drafts fall back to the idle condense', async (t) => {
  const b = await boot(t)
  b.env.checkpointFail = 2
  await grow(b)
  await settle(() => b.types().includes('compaction/end'))
  await b.quiet()
  // Two background attempts failed; no third started; the check condensed in maintenance.
  assert.deepEqual(b.kinds('checkpoint').map(call => call.phase), ['idle', 'idle', 'maintenance'])
  assert.ok(b.balanced())
  assert.equal(b.env.warnings.filter(line => /background checkpoint for b failed/.test(line)).length, 2)
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
test('the steward says switch: the early draft is dropped and never applied', async (t) => {
  const b = await boot(t)
  b.env.steward = 'switch'
  b.env.gateOn()
  await grow(b)
  await settle(() => b.kinds('steward').length === 1)
  // Made ahead from the draft line, before the steward was asked.
  assert.equal(b.kinds('checkpoint').length, 1)
  assert.ok(b.kinds('checkpoint')[0].at < b.kinds('steward')[0].at)
  await settle(() => b.kinds('checkpoint')[0].options.signal.aborted)
  b.env.gateOff()
  await b.say('next')
  assert.equal(b.types().includes('compaction/start'), false)
  assert.equal(b.kinds('checkpoint').length, 1)
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

// Stage 2: from the draft line on, after a turn that ended well, the checkpoint is made
// ahead; the steward's "compact" at the check line uses it.
test('stage 2: the draft starts at the draft line, not below it, and "compact" uses it', async (t) => {
  const b = await boot(t)
  // Check line 16,000, part base 0: draft line 16,000 - min(60,000, 8,000) = 8,000.
  const before = []
  for (let index = 1; index <= 11 && b.kinds('steward').length === 0; index += 1) {
    await b.say(`m${index}`)
    await tick(20)
    before.push({ tokens: b.tokens(), drafted: b.kinds('checkpoint').length })
  }
  const first = before.findIndex(step => step.drafted > 0)
  assert.ok(first > 0, 'not at the first turn')
  assert.ok(before[first].tokens >= 8_000)
  assert.ok(before.slice(0, first).every(step => step.tokens < 8_000), 'none below the draft line')
  assert.ok(before[first - 1].tokens < 8_000)
  await settle(() => b.kinds('steward').length === 1)
  await b.quiet()
  // The steward came after the draft; the draft was used, with no second call.
  assert.equal(b.kinds('checkpoint').length, 1)
  await b.say('after')
  assert.equal(b.types().filter(type => type === 'compaction/summary').length, 1)
  assert.equal(b.kinds('checkpoint').length, 1)
  assert.ok(b.balanced())
})

test('stage 2: no early draft after a stopped turn', async (t) => {
  const b = await boot(t)
  // Four turns: about 6,000 tokens, below the draft line (8,000).
  for (let index = 1; index <= 4; index += 1) await b.say(`m${index}`)
  assert.equal(b.kinds('checkpoint').length, 0)
  // A turn stopped after its answer lands past the draft line: no draft.
  b.env.answerSize = 12_000
  let stopped = false
  b.ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/message' && !stopped) {
      stopped = true
      queueMicrotask(() => b.agent.cancel({ kind: 'user' }))
    }
  })
  await b.say('long one')
  await tick(50)
  assert.ok(b.tokens() >= 8_000 && b.tokens() < 16_000, `tokens ${b.tokens()}`)
  assert.notEqual(b.events().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(b.kinds('checkpoint').length, 0)
  // The next turn that ends well starts it.
  b.env.answerSize = 100
  await b.say('short one')
  await settle(() => b.kinds('checkpoint').length === 1)
})

test('the draft line examples', async () => {
  const { draftLine, linesFor } = await import('../src/host/steward.js')
  const big = linesFor({ window: 1_048_576, reserve: 256_000 })
  assert.equal(big.check, 634_060)
  assert.equal(draftLine(big.check, 20_000), 574_060)
  const small = linesFor({ window: 128_000, reserve: 8_000 })
  assert.equal(small.check, 96_000)
  assert.equal(draftLine(small.check, 10_000), 53_000)
})
