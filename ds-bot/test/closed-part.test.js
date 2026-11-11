import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// After /new (#122) the earlier part is closed. Nothing addressed to it may land in,
// or be answered from, the Bot's new Session.
const CHOICES = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer-now', createdAt: 2, segments: [{ sessionId: 'writer-old', endedAt: 1, fallback: 'clean', closed: true }] },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: { 'writer-now': { id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], askedAt: 1 } },
  views: { 'writer-now': { id: 'v1', title: 'Pick', view: CHOICES, askedAt: 1 } },
  prefs: {},
  revision: 0,
}

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-closed-part-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  const sent = []
  const agentOf = sessionId => ({
    id: sessionId,
    status: 'idle',
    session: { id: sessionId, header: { cwd: home, config: { provider: 'deepseek', model: 'v4' } }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => [], snapshotEvents: () => [] },
    ctx: { tools: { register: () => () => {} } },
    inbox: { nextStep: [], nextTurn: [], remove: () => false },
    followup(message) { sent.push({ sessionId, message }) },
    inject(message) { sent.push({ sessionId, message }) },
  })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), async* stream() { yield { type: 'finish', reason: { kind: 'stop' } } } },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, unarchiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      prompt: async request => { sent.push({ sessionId: request.sessionId, prompt: request }) },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await call('state', {})
  return { ctx, rt, call, sent, agentOf }
}

test('a closed part answers no card of the new Session and asks it nothing', async (t) => {
  const { call, sent } = await start(t)
  const codes = {}
  for (const [endpoint, payload] of [
    ['send', { sessionId: 'writer-old', text: 'hello' }],
    ['answer-question', { sessionId: 'writer-old', questionId: 'q1', answer: { selected: ['A'] } }],
    ['view-reply', { sessionId: 'writer-old', viewId: 'v1', action: 'pick', values: { selected: ['A'] } }],
    ['side-new', { sessionId: 'writer-old' }],
    ['side-ask', { sessionId: 'writer-old', text: 'what are you doing?' }],
  ]) {
    codes[endpoint] = (await call(endpoint, payload)).error?.code ?? 'ok'
  }
  assert.deepEqual(codes, { send: 'bot/closed', 'answer-question': 'bot/closed', 'view-reply': 'bot/closed', 'side-new': 'bot/closed', 'side-ask': 'bot/closed' })
  assert.deepEqual(sent, [])
  // The new Session's cards are still open, for its own chat to answer.
  const team = (await call('state', {})).value
  assert.equal(team.questions['writer-now'].id, 'q1')
  assert.equal(team.views['writer-now'].id, 'v1')
  assert.equal((await call('answer-question', { sessionId: 'writer-now', questionId: 'q1', answer: { selected: ['A'] } })).ok, true)
  assert.deepEqual(sent.map(item => item.sessionId), ['writer-now'])
})

test('input that wakes a closed part is not handed on to the new Session', async (t) => {
  const { ctx, sent, agentOf } = await start(t)
  const preStep = ctx.listeners.get('agent/pre-step').find(listener => listener.toString().includes('takeOverStep'))
  const message = createUserMessage({ content: [{ type: 'text', text: 'late input' }], source: { kind: 'user' } })
  await preStep({ agent: agentOf('writer-old'), messages: [message], step: 1, signal: AbortSignal.timeout(10_000) }, async () => ({ kind: 'enter', messages: [message] }))
  assert.deepEqual(sent.filter(item => item.sessionId === 'writer-now'), [])
})
