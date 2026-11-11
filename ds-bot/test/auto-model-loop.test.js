// The Auto model pick on DSH's real agent loop: messages that arrive while Jev answers
// are each answered once, the first message first, on a recording model adapter.
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

// One Bot chat on the real loop. Every model call is recorded with its model and the
// user messages its request carries after the last answer. `judge` stands in for Jev:
// it resolves to the pick after `delayMs`.
async function boot(t, { delayMs = 100 } = {}) {
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
      calls.push({ model: options.model, asked })
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
      return { model: { type: 'choice', choice: `${PROVIDER}/pro`, confidence: 0.9, probabilities: { [`${PROVIDER}/flash`]: 0.1, [`${PROVIDER}/pro`]: 0.9 } } }
    },
    desiredEffort: async () => undefined,
    selectSessionModel: async (_sessionId, { provider, model }) => agent.model.select({ provider, model }),
    save: async () => {},
  }
  // DS Bot's own restore and wake (parts.js), as the picker uses them.
  const inboxTargetOf = message => (message.source?.kind === 'user' ? 'next-turn' : 'next-step')
  rt.restoreInput = (subject, messages) => {
    for (const message of [...messages].reverse()) {
      if ([...subject.inbox.nextStep, ...subject.inbox.nextTurn].some(queued => queued.id === message.id)) continue
      subject.inbox.prepend(inboxTargetOf(message), message)
    }
  }
  rt.wakeInput = (subject) => {
    const pending = [...subject.inbox.nextStep, ...subject.inbox.nextTurn]
    for (const message of pending) subject.inbox.remove(message.id)
    pending.forEach((message, index) => subject.send(message, inboxTargetOf(message), index === 0))
  }
  install(rt)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('b'), { provider: PROVIDER, model: 'flash' })
  t.after(() => ctx.fiber.dispose())
  const turnEnds = () => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length
  // Idle with nothing pending and no wake waiting.
  const quiet = async () => {
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
    await new Promise(resolve => setTimeout(resolve, 30))
    await settle(() => agent.status === 'idle' && !agent.inbox.hasPending)
  }
  t.after(() => t.diagnostic(`calls ${JSON.stringify(calls)} turns ${turnEnds()}`))
  return { agent, calls, judged, warnings, turnEnds, quiet }
}

test('a steer during the judgment: one turn on the current model, the first message first', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.steer(userMessage('steer-second'))
  await env.quiet()
  // The pick is dropped: one ordinary turn on the model in use, whose next step takes
  // the steer.
  assert.deepEqual(env.calls, [{ model: 'flash', asked: ['first'] }, { model: 'flash', asked: ['steer-second'] }])
  assert.equal(env.turnEnds(), 1)
})

test('a followup during the judgment: each answered once, in order, on the current model', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.followup(userMessage('second'))
  await env.quiet()
  assert.deepEqual(env.calls, [{ model: 'flash', asked: ['first'] }, { model: 'flash', asked: ['second'] }])
  assert.equal(env.turnEnds(), 2)
})

test('two quick followups during the judgment: each answered once, in order, on the current model', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await settle(() => env.judged.length === 1)
  env.agent.followup(userMessage('second'))
  env.agent.followup(userMessage('third'))
  await env.quiet()
  assert.deepEqual(env.calls, [{ model: 'flash', asked: ['first'] }, { model: 'flash', asked: ['second'] }, { model: 'flash', asked: ['third'] }])
})

test('nothing arrives during the judgment: the message is answered once, on the pick', async (t) => {
  const env = await boot(t)
  env.agent.followup(userMessage('first'))
  await env.quiet()
  assert.deepEqual(env.calls, [{ model: 'pro', asked: ['first'] }])
  assert.equal(env.turnEnds(), 2, 'the empty hold, then the answer')
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
  assert.deepEqual(env.calls, [{ model: 'pro', asked: ['first'] }, { model: 'pro', asked: ['second'] }])
})
