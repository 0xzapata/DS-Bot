// Group "Auto" reply mode on a fake team: rounds run as in rounds.test.js (member answers
// played back through session/event), and a fake TypeSafe answers each judgment.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The fake TypeSafe: `answer(body)` returns { p: { name: probability }, delayMs, status }.
// The questions name their member, so the fake answers by name.
async function fakeJev(t, answer) {
  const calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const reply = answer(parsed) ?? {}
      const send = () => {
        if (reply.status !== undefined) { response.writeHead(reply.status); response.end('{}'); return }
        const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => {
          const name = question.instructions.match(/^Should (\S+) /)[1]
          return [id, { type: 'noul', noul: reply.p?.[name] ?? 0 }]
        }))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 90, output_tokens: 5 } }))
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref()
      else send()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const saved = { url: process.env.TYPESAFE_BASE_URL, key: process.env.TYPESAFE_API_KEY }
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}`
  process.env.TYPESAFE_API_KEY = 'tsk-live-check-not-a-real-key'
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

function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-auto-reply-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextTurn: [], nextStep: [] }
      inbox.remove = (id) => {
        for (const list of ['nextTurn', 'nextStep']) {
          const at = inbox[list].findIndex(message => message.id === id)
          if (at !== -1) {
            inbox[list] = inbox[list].toSpliced(at, 1)
            return true
          }
        }
        return false
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  let sessions = 0
  const cancelled = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }), cancel: reason => cancelled.push({ sessionId, reason }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const compose = (sessionId, text) => ctx.sessionController.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  const relay = (roomId, callId, signal = new AbortController().signal) => rt.teamTools.find(d => d.name === 'group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal })
  let turn = 0
  const answer = async (entry, text) => {
    const { sessionId } = entry
    const { exchangeId } = entry.message.source
    turn += 1
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  // The member a turn prompt went to.
  const whoseTurn = entry => rt.groupOwners.get(entry.sessionId)?.botId
  const audit = () => {
    const path = join(home, 'reply-audit.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { call, emit, userMessage, compose, relay, inboxOf, answer, whoseTurn, audit, sent, ctx, home, rt, cancelled }
}

const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (check, tries = 150) => {
  for (let at = 0; at < tries; at += 1) {
    const value = check()
    if (value !== undefined && value !== false) return value
    await settle()
  }
  return undefined
}

// Chief (Main, admin), Writer, Coder, Tester; `mode` set on the group.
async function team(env, { mode = 'auto', jev = true } = {}) {
  const { call, sent, rt } = env
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer', role: 'Writes copy' })).value
  const coder = (await call('create-bot', { name: 'Coder', role: 'Writes code' })).value
  const tester = (await call('create-bot', { name: 'Tester', role: 'Tests' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id, coder.id, tester.id] })).value
  if (mode !== 'admin') await call('update-room', { id: room.id, mode })
  if (jev) await call('set-prefs', { jev: true })
  sent.length = 0
  const ids = { Chief: chief, Writer: writer.id, Coder: coder.id, Tester: tester.id }
  const name = id => Object.keys(ids).find(key => ids[key] === id)
  return { room: rt.roomOf(room.id), ids, name }
}

// The judgment alone, on a room set to auto by hand.
test('autoRepliers: owner picks by p, at most 3, the cap taken at pick time; audit without text', async (t) => {
  const jev = await fakeJev(t, () => ({ p: { Chief: 0.2, Writer: 0.9, Coder: 0.7, Tester: 0.6 } }))
  const env = start(t)
  const { room, ids } = await team(env, { mode: 'admin' })
  room.mode = 'auto'
  room.autoTurns = 6
  const applied = []
  const { ids: picked, reason } = await env.rt.autoRepliers(room, { text: 'owner-secret-words', apply: list => applied.push(list) })
  assert.equal(reason, 'jev')
  assert.deepEqual(picked, [ids.Writer, ids.Coder], 'two turns left under the cap')
  assert.deepEqual(applied, [picked])
  assert.equal(room.autoTurns, 8)
  assert.equal(jev.length, 1)
  assert.equal(Object.keys(jev[0].questions).length, 4)
  await waitFor(() => env.audit().length === 1)
  const raw = readFileSync(join(env.home, 'reply-audit.jsonl'), 'utf8')
  assert.ok(!raw.includes('owner-secret-words'))
})

test('autoRepliers: a Bot message needs the hop bar, skips busy members, and a private author asks nothing', async (t) => {
  const jev = await fakeJev(t, () => ({ p: { Chief: 0.75, Writer: 0.65, Coder: 0.95, Tester: 0.95 } }))
  const env = start(t)
  const { room, ids } = await team(env, { mode: 'admin' })
  room.mode = 'auto'
  room.autoEpoch = 1
  const first = await env.rt.autoRepliers(room, { text: 'a reply', fromBotId: ids.Writer, busy: id => id === ids.Coder })
  assert.deepEqual(first, { ids: [ids.Tester, ids.Chief], reason: 'jev' })
  assert.equal(room.autoHop, 1)
  env.rt.botOf(ids.Writer).private = true
  const second = await env.rt.autoRepliers(room, { text: 'private words', fromBotId: ids.Writer })
  assert.deepEqual(second, { ids: [], reason: 'private' })
  assert.equal(jev.length, 1)
})
