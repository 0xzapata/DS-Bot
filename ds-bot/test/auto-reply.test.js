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
const roomTurns = sent => sent.filter(entry => entry.message.source.role === 'room')
const nextTurn = (sent, seen) => waitFor(() => roomTurns(sent).find(entry => !seen.includes(entry)))

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

// Runs a round: answers each turn with `reply(name, n)` until the relay ends; returns
// the names that spoke, in order.
async function playRound(env, roomId, reply, { signal, callId = 'relay' } = {}) {
  const spoke = []
  const seen = []
  let done = false
  const running = env.relay(roomId, callId, signal).then((value) => { done = true; return value })
  for (;;) {
    const entry = await waitFor(() => done || roomTurns(env.sent).find(each => !seen.includes(each)))
    if (entry === undefined || entry === true) break
    seen.push(entry)
    const who = env.rt.botOf(env.whoseTurn(entry))?.name
    spoke.push(who)
    await env.answer(entry, reply(who, spoke.length))
  }
  return { spoke, result: JSON.parse(await running) }
}

// The judgment alone, on a room set to auto by hand.
test('autoRepliers: owner picks by p, at most 3, never capped, and reset the turn count; audit without text', async (t) => {
  const jev = await fakeJev(t, () => ({ p: { Chief: 0.2, Writer: 0.9, Coder: 0.7, Tester: 0.6 } }))
  const env = start(t)
  const { room, ids } = await team(env, { mode: 'admin' })
  room.mode = 'auto'
  room.autoTurns = 6
  const applied = []
  const { ids: picked, reason } = await env.rt.autoRepliers(room, { text: 'owner-secret-words', apply: list => applied.push(list) })
  assert.equal(reason, 'jev')
  assert.deepEqual(picked, [ids.Writer, ids.Coder, ids.Tester], 'the cap is for Bot-to-Bot turns only')
  assert.deepEqual(applied, [picked])
  assert.equal(room.autoTurns, undefined)
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
  // A reply two calls from the owner needs 0.7: Chief at 0.75 only.
  assert.deepEqual(await env.rt.autoRepliers(room, { text: 'a reply', fromBotId: ids.Writer, hop: 2, busy: id => id !== ids.Chief }), { ids: [ids.Chief], reason: 'jev' })
  env.rt.botOf(ids.Writer).private = true
  const second = await env.rt.autoRepliers(room, { text: 'private words', fromBotId: ids.Writer })
  assert.deepEqual(second, { ids: [], reason: 'private' })
  assert.equal(jev.length, 2)
})

test('1. admin and everyone groups never call Jev; a new group defaults to admin', async (t) => {
  const jev = await fakeJev(t, () => ({ p: { Writer: 1, Coder: 1, Tester: 1, Chief: 1 } }))
  for (const mode of ['admin', 'everyone']) {
    const env = start(t)
    const { room } = await team(env, { mode })
    if (mode === 'admin') assert.equal(room.mode, 'admin')
    await env.emit(room.id, env.userMessage('Hello team'))
    const { spoke } = await playRound(env, room.id, name => `Hi from ${name}`)
    assert.deepEqual(spoke, mode === 'admin' ? ['Chief'] : ['Chief', 'Writer', 'Coder', 'Tester'])
  }
  assert.equal(jev.length, 0)
})

test('2. owner message: one judgment with a noul per member; p >= 0.5 answer by p, at most 3', async (t) => {
  const jev = await fakeJev(t, body => (body.state.from === 'user' ? { p: { Chief: 0.55, Writer: 0.9, Coder: 0.7, Tester: 0.6 } } : { p: {} }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Write the launch post'))
  const { spoke } = await playRound(env, room.id, name => `Done, ${name} here with a draft of the launch post.`)
  assert.deepEqual(spoke, ['Writer', 'Coder', 'Tester'])
  const first = jev[0]
  assert.deepEqual(Object.keys(first.questions), ['m0', 'm1', 'm2', 'm3'])
  assert.ok(Object.values(first.questions).every(question => question.type === 'noul'))
  assert.deepEqual(first.state, { message: 'Write the launch post', from: 'user', group: 'R1' })
  assert.match(first.questions.m0.instructions, /^Should Chief \(Chief of Staff, the group's admin\) reply to `message` in this group chat\? Yes only if the message asks for it or it needs this member's role\.$/)
  const line = env.audit()[0]
  assert.equal(line.reason, 'jev')
  assert.equal(line.from, 'user')
  assert.equal(line.picked.length, 3)
})

test('3. an @mention in auto mode: no judgment, only the named member answers', async (t) => {
  const jev = await fakeJev(t, () => ({ p: { Chief: 1, Writer: 1, Coder: 1, Tester: 1 } }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('@Coder fix the build'))
  // A status reply is not judged either.
  const { spoke } = await playRound(env, room.id, () => 'standby')
  assert.deepEqual(spoke, ['Coder'])
  assert.equal(jev.length, 0)
})

for (const [what, answer, jevOn] of [
  ['HTTP 500', () => ({ status: 500 }), true],
  ['Jev switch off', () => ({ p: { Writer: 1 } }), false],
  ['timeout', () => ({ p: { Writer: 1 }, delayMs: 2500 }), true],
]) {
  test(`4. judgment null (${what}): the admin alone answers; audit null`, async (t) => {
    const jev = await fakeJev(t, answer)
    const env = start(t)
    const { room } = await team(env, { jev: jevOn })
    await env.emit(room.id, env.userMessage('Plan the week'))
    const { spoke } = await playRound(env, room.id, () => 'Here is the plan for the week, in three steps.')
    assert.deepEqual(spoke, ['Chief'])
    if (!jevOn) assert.equal(jev.length, 0)
    assert.equal(env.audit()[0].reason, 'null')
    assert.deepEqual(env.audit()[0].picked, [env.rt.roomOf(room.id).admin])
  })
}

test('5. every p below 0.5: the admin answers; audit below', async (t) => {
  await fakeJev(t, () => ({ p: { Chief: 0.2, Writer: 0.4, Coder: 0.1, Tester: 0.3 } }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Any thoughts?'))
  const { spoke } = await playRound(env, room.id, () => 'A few thoughts on the plan from me.')
  assert.deepEqual(spoke, ['Chief'])
  assert.equal(env.audit()[0].reason, 'below')
  assert.deepEqual(env.audit()[1].reason, 'below', 'the reply judged with p 0.4 under the hop-1 bar')
})

test('6. hop 1 at p 0.65 calls the member; hop 2 at p 0.65 does not (bar 0.7)', async (t) => {
  // The owner's message picks Writer; Writer's reply picks Coder at 0.65 (hop 1);
  // Coder's reply would pick Tester at 0.65 (hop 2, bar 0.7): nobody.
  await fakeJev(t, (body) => {
    if (body.state.from === 'user') return { p: { Writer: 0.9 } }
    if (body.state.from === 'Writer') return { p: { Coder: 0.65 } }
    return { p: { Tester: 0.65 } }
  })
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Draft the release notes'))
  const { spoke } = await playRound(env, room.id, name => `${name}: my part of the release notes is ready to read.`)
  assert.deepEqual(spoke, ['Writer', 'Coder'])
  const audit = env.audit()
  assert.deepEqual(audit.map(line => [line.from === 'user' ? 'user' : env.rt.botOf(line.from)?.name, line.hop, line.reason]), [['user', 0, 'jev'], ['Writer', 1, 'jev'], ['Coder', 2, 'below']])
})

test('7. Jev always yes: 3 owner picks, then Bot-to-Bot turns stop at 8 (cap); the next owner message resets; an @mention chain is not capped', async (t) => {
  await fakeJev(t, () => ({ p: { Chief: 0.95, Writer: 0.95, Coder: 0.95, Tester: 0.95 } }))
  const env = start(t)
  const { room } = await team(env)
  let n = 0
  const reply = () => `Update number ${++n}: here is a new finding about the task.`
  await env.emit(room.id, env.userMessage('Go'))
  const first = await playRound(env, room.id, reply)
  assert.equal(first.spoke.length, 3 + 8)
  assert.ok(env.audit().some(line => line.reason === 'cap'))
  assert.equal(env.rt.roomOf(room.id).autoTurns, 8)
  // A new owner message resets the count.
  env.sent.length = 0
  await env.emit(room.id, env.userMessage('Again'))
  const second = await playRound(env, room.id, reply, { callId: 'relay-2' })
  assert.equal(second.spoke.length, 3 + 8)
  // An @mention chain between Bots is not capped: 10 hops by name.
  env.sent.length = 0
  const order = ['Writer', 'Coder', 'Tester', 'Chief']
  let hop = 0
  await env.emit(room.id, env.userMessage('@Writer start the relay'))
  const chain = await playRound(env, room.id, () => (++hop < 12 ? `@${order[hop % 4]} your go, step ${hop}` : 'All steps finished here.'), { callId: 'relay-3' })
  assert.ok(chain.spoke.length >= 12, `spoke ${chain.spoke.length}`)
})

test('8. a Bot message with a null judgment: no reply, the round ends', async (t) => {
  await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9 } } : { status: 500 }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Write a haiku'))
  const { spoke } = await playRound(env, room.id, () => 'An old silent pond, a frog jumps into the pond.')
  assert.deepEqual(spoke, ['Writer'])
  assert.deepEqual(env.audit().map(line => line.reason), ['jev', 'null'])
})

test('9. a private member never reaches Jev: not in the questions, its reply makes no request, its text never sent', async (t) => {
  const jev = await fakeJev(t, () => ({ p: { Chief: 0.9, Writer: 0.9, Coder: 0.9, Tester: 0.9 } }))
  const env = start(t)
  const { room, ids } = await team(env)
  // A group cannot take a private Bot in; one that was a member before is still possible
  // in saved data, so the record is set directly.
  env.rt.botOf(ids.Tester).private = true
  await env.emit(room.id, env.userMessage('@Tester share your notes'))
  const secret = 'PRIVATE-DIARY-LINE about my secret plans'
  const { spoke } = await playRound(env, room.id, name => (name === 'Tester' ? secret : 'Thanks for the notes, all good.'))
  assert.deepEqual(spoke, ['Tester'])
  assert.equal(jev.length, 0, 'a private Bot\'s reply makes no request')
  assert.equal(env.audit().at(-1).reason, 'private')
  // A plain owner message: Tester is not asked about.
  env.sent.length = 0
  await env.emit(room.id, env.userMessage('Who can help with copy?'))
  await playRound(env, room.id, () => 'I can help with that.', { callId: 'relay-2' })
  assert.ok(jev.length > 0)
  for (const body of jev) {
    assert.ok(Object.values(body.questions).every(question => !question.instructions.startsWith('Should Tester ')))
    assert.ok(!JSON.stringify(body).includes(secret))
  }
})

test('10. Stop during a pending judgment: nobody is called, the round ends, audit stopped', async (t) => {
  await fakeJev(t, () => ({ p: { Writer: 0.9 }, delayMs: 1000 }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Think about this'))
  const controller = new AbortController()
  const running = env.relay(room.id, 'relay', controller.signal)
  await settle(100)
  // The relay judges before its round exists; the group's Stop still reaches it.
  assert.equal(await env.rt.stopRoomWork(room.id), true)
  assert.equal(env.cancelled.length, 1)
  controller.abort()
  await running
  await settle(1100)
  assert.equal(roomTurns(env.sent).length, 0)
  assert.equal(env.audit()[0].reason, 'stopped')
})

test('10b. Stop during a judgment of a Bot reply inside the round: nobody is called, audit stopped', async (t) => {
  await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9 } } : { p: { Coder: 0.9 }, delayMs: 1000 }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Draft it'))
  const controller = new AbortController()
  const running = env.relay(room.id, 'relay', controller.signal)
  const first = await nextTurn(env.sent, [])
  await env.answer(first, 'Here is the draft of the text you asked for.')
  await settle(100)
  controller.abort()
  await running
  await settle(1100)
  assert.equal(roomTurns(env.sent).length, 1)
  assert.equal(env.audit().at(-1).reason, 'stopped')
})

test('11. two owner messages whose judgments resolve in reverse order: replies in message order', async (t) => {
  await fakeJev(t, (body) => {
    if (body.state.message === 'first question') return { p: { Writer: 0.9 }, delayMs: 400 }
    if (body.state.message === 'second question') return { p: { Coder: 0.9 }, delayMs: 50 }
    return { p: {} }
  })
  const env = start(t)
  const { room } = await team(env, { mode: 'admin' })
  // A round is running (admin mode) when the two messages arrive; then the mode is auto.
  await env.emit(room.id, env.userMessage('@Tester hold the floor'))
  const running = env.relay(room.id, 'relay')
  const holder = await nextTurn(env.sent, [])
  await env.call('update-room', { id: room.id, mode: 'auto' })
  await env.compose(room.id, 'first question')
  await env.compose(room.id, 'second question')
  await env.answer(holder, 'Holding the floor while you write.')
  const seen = [holder]
  const spoke = []
  for (let i = 0; i < 2; i += 1) {
    const entry = await nextTurn(env.sent, seen)
    assert.ok(entry, `turn ${i}`)
    seen.push(entry)
    spoke.push(env.rt.botOf(env.whoseTurn(entry)).name)
    await env.answer(entry, 'Answer to the question.')
  }
  await running
  assert.deepEqual(spoke, ['Writer', 'Coder'])
})

test('12. a new owner message during a chain: the older Bot judgment is stale', async (t) => {
  await fakeJev(t, (body) => {
    if (body.state.from === 'Writer') return { p: { Coder: 0.95 }, delayMs: 400 }
    if (body.state.message === 'new topic') return { p: { Tester: 0.9 } }
    if (body.state.from === 'user') return { p: { Writer: 0.9 } }
    return { p: {} }
  })
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('start the chain'))
  const running = env.relay(room.id, 'relay')
  const first = await nextTurn(env.sent, [])
  await env.answer(first, 'Writer has a long answer for the chain here.')
  await settle(50)
  await env.compose(room.id, 'new topic')
  env.rt.nudgeRoom(room.id)
  const second = await nextTurn(env.sent, [first])
  assert.equal(env.rt.botOf(env.whoseTurn(second)).name, 'Tester')
  await env.answer(second, 'Tester answers the new topic now.')
  await running
  assert.ok(env.audit().some(line => line.reason === 'stale' && env.rt.botOf(line.from)?.name === 'Writer'))
  assert.ok(!roomTurns(env.sent).some(entry => env.rt.botOf(env.whoseTurn(entry)).name === 'Coder'))
})

test('13. the round waits for a pending judgment: the picked member answers in the same round', async (t) => {
  await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9 } } : body.state.from === 'Writer' ? { p: { Coder: 0.9 }, delayMs: 600 } : { p: {} }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Plan it'))
  const { spoke } = await playRound(env, room.id, name => `${name} has a detailed plan for the next step.`)
  assert.deepEqual(spoke, ['Writer', 'Coder'])
})

test('14. mode changed from auto to admin during a pending judgment: the pick is not applied', async (t) => {
  await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9 } } : { p: { Coder: 0.9 }, delayMs: 500 }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Begin'))
  const running = env.relay(room.id, 'relay')
  const first = await nextTurn(env.sent, [])
  await env.answer(first, 'Writer replies with a full answer here.')
  await settle(50)
  await env.call('update-room', { id: room.id, mode: 'admin' })
  // Past the judgment: a wrong pick would have called Coder by now.
  await settle(700)
  assert.equal(roomTurns(env.sent).length, 1)
  assert.equal(env.audit().at(-1).reason, 'stopped')
  await running
})

test('15. the audit never holds message text', async (t) => {
  await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9, Coder: 0.6 } } : { p: { Tester: 0.8 } }))
  const env = start(t)
  const { room } = await team(env)
  const words = ['zebra-owner-text', 'quokka-writer-text', 'axolotl-coder-text', 'narwhal-tester-text']
  await env.emit(room.id, env.userMessage(`Please answer ${words[0]}`))
  await playRound(env, room.id, name => `Answer with ${{ Writer: words[1], Coder: words[2], Tester: words[3] }[name] ?? 'nothing'} from me`)
  await settle(50)
  const raw = readFileSync(join(env.home, 'reply-audit.jsonl'), 'utf8')
  assert.ok(raw.length > 0)
  for (const word of words) assert.ok(!raw.includes(word), word)
  for (const line of env.audit()) assert.deepEqual(Object.keys(line).sort(), ['from', 'hop', 'p', 'picked', 'reason', 'room', 'time'])
})

// A Bot's plain post into the group's own Session, as post_to_group sends it.
const postEvent = (ids, name, text) => ({ type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: ids[name], senderName: name, exchangeId: randomUUID() }, content: [{ type: 'text', text: `[Group post from ${name}]\n${text}` }] } })
// Answers every turn of a running relay until it ends; `onTurn(entry, name, n)` may act first.
async function drive(env, running, reply, onTurn = async () => {}) {
  let done = false
  running.then(() => { done = true }, () => { done = true })
  const seen = []
  const spoke = []
  for (;;) {
    const entry = await waitFor(() => done || roomTurns(env.sent).find(each => !seen.includes(each)))
    if (entry === undefined || entry === true) break
    seen.push(entry)
    const who = env.rt.botOf(env.whoseTurn(entry))?.name
    spoke.push(who)
    await onTurn(entry, who, spoke.length)
    await env.answer(entry, reply(who, spoke.length))
  }
  return spoke
}
const nameOf = (env, line) => (line.from === 'user' ? 'user' : env.rt.botOf(line.from)?.name)

test('16. an owner message and a Main Bot post in one relay, Jev null: the owner message still gets the default', async (t) => {
  await fakeJev(t, () => ({ status: 500 }))
  const env = start(t)
  const { room, ids } = await team(env)
  await env.emit(room.id, env.userMessage('Please plan the launch for Friday'))
  await env.emit(room.id, postEvent(ids, 'Chief', 'I pushed the new build to staging for everyone.'))
  const { spoke } = await playRound(env, room.id, name => `${name} replies with the launch plan details.`)
  assert.ok(spoke.length > 0, 'somebody answers the owner')
  const owner = env.audit().filter(line => line.from === 'user')
  assert.equal(owner.length, 1)
  assert.deepEqual(owner[0].picked, [ids.Chief])
})

test('17. an owner message and a Bot post in one relay, Jev answering: the owner message is judged as the owner\'s', async (t) => {
  const jev = await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9 } } : { p: {} }))
  const env = start(t)
  const { room, ids } = await team(env)
  await env.emit(room.id, env.userMessage('Please plan the launch for Friday'))
  await env.emit(room.id, postEvent(ids, 'Chief', 'I pushed the new build to staging for everyone.'))
  const { spoke } = await playRound(env, room.id, name => `${name} replies with the launch plan details.`)
  assert.ok(jev.some(body => body.state.from === 'user' && body.state.message === 'Please plan the launch for Friday'))
  assert.equal(spoke[0], 'Writer')
})

for (const count of [4, 5]) {
  test(`18. ${count} owner messages drained in one pass, Jev always yes: each gets a member; autoTurns counts only Bot-to-Bot picks`, async (t) => {
    await fakeJev(t, () => ({ p: { Writer: 0.95, Coder: 0.9, Tester: 0.85, Chief: 0.8 } }))
    const env = start(t)
    const { room } = await team(env, { mode: 'admin' })
    await env.emit(room.id, env.userMessage('@Tester hold the floor'))
    const running = env.relay(room.id, 'relay')
    const holder = await nextTurn(env.sent, [])
    await env.call('update-room', { id: room.id, mode: 'auto' })
    for (let n = 1; n <= count; n += 1) await env.compose(room.id, `question number ${n}`)
    await env.answer(holder, 'Holding the floor while you write.')
    await drive(env, running, (name, n) => `${name} answers part ${n} of the questions in full.`)
    const audit = env.audit()
    const owner = audit.filter(line => line.from === 'user')
    assert.equal(owner.length, count)
    assert.ok(owner.every(line => line.picked.length > 0 && line.reason !== 'cap'), JSON.stringify(owner.map(line => line.reason)))
    const last = audit.findLastIndex(line => line.from === 'user')
    const botPicks = audit.slice(last + 1).filter(line => line.reason === 'jev').reduce((sum, line) => sum + line.picked.length, 0)
    assert.equal(env.rt.roomOf(room.id).autoTurns ?? 0, botPicks)
  })
}

test('19. two members answer the owner: both replies are judged at hop 1', async (t) => {
  await fakeJev(t, (body) => {
    if (body.state.from === 'user') return { p: { Writer: 0.9, Coder: 0.9 } }
    if (body.state.from === 'Writer') return { p: { Tester: 0.65 } }
    if (body.state.from === 'Coder') return { p: { Chief: 0.65 } }
    return { p: {} }
  })
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Both of you, draft it'))
  await playRound(env, room.id, name => `${name} posts a full draft section number one.`)
  const bot = env.audit().filter(line => ['Writer', 'Coder'].includes(nameOf(env, line)))
  assert.deepEqual(bot.map(line => [nameOf(env, line), line.hop, line.reason]).sort(), [['Coder', 1, 'jev'], ['Writer', 1, 'jev']])
})

test('20. two parallel replies at hop 1, then a hop-2 reply: bars 0.6, 0.6, 0.7', async (t) => {
  await fakeJev(t, (body) => {
    if (body.state.from === 'user') return { p: { Writer: 0.9, Coder: 0.9 } }
    if (body.state.from === 'Writer') return { p: { Tester: 0.62 } }
    if (body.state.from === 'Coder') return { p: { Chief: 0.62 } }
    return { p: { Writer: 0.65 } }
  })
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('Both of you, draft it'))
  const { spoke } = await playRound(env, room.id, name => `${name} posts a full draft section number one.`)
  const lines = env.audit().filter(line => line.from !== 'user').map(line => [nameOf(env, line), line.hop, line.reason])
  // Writer and Coder reply in parallel at hop 1 (bar 0.6): their 0.62 picks are called.
  // Tester and Chief reply at hop 2 (bar 0.7): Writer at 0.65 is not.
  assert.deepEqual(lines.sort(), [['Chief', 2, 'below'], ['Coder', 1, 'jev'], ['Tester', 2, 'below'], ['Writer', 1, 'jev']])
  assert.deepEqual(spoke.toSorted(), ['Chief', 'Coder', 'Tester', 'Writer'])
})

for (const mode of ['admin', 'auto']) {
  test(`21. [${mode}] a Main Bot's report_back post into a running round gets its report`, async (t) => {
    await fakeJev(t, body => (body.state.from === 'Chief' ? { p: { Writer: 0.95 } } : { p: {} }))
    const env = start(t)
    const { room, ids } = await team(env, { mode })
    await env.emit(room.id, env.userMessage('@Tester hold the floor'))
    const running = env.relay(room.id, 'relay')
    let posted = false
    const spoke = await drive(env, running, name => `${name} reviewed the plan and it looks right.`, async () => {
      if (posted) return
      posted = true
      await env.rt.postToRoom(env.rt.roomOf(room.id), env.rt.botOf(ids.Chief), 'Please review the release plan.', { reportBack: true })
      await settle(100)
    })
    await settle(100)
    assert.ok(spoke.length > 1, 'somebody answered the post')
    const reports = env.sent.filter(entry => entry.message.source.role === 'report')
    assert.equal(reports.length, 1, 'the poster gets its report')
    assert.match(reports[0].message.content[0].text, /Writer: Writer reviewed the plan/)
  })
}
