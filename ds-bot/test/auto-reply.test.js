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
test('autoRepliers: owner picks by p, at most 3, never capped, and leave the turn count alone; audit without text', async (t) => {
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
  assert.equal(room.autoTurns, 6, 'reset when the message arrives, not after the judgment')
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
    // The count was reset when the messages arrived, before any judgment.
    const botPicks = audit.filter(line => line.from !== 'user' && line.reason === 'jev').reduce((sum, line) => sum + line.picked.length, 0)
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

test('22. a judgment that throws counts as null: the owner default answers, the relay does not fail', async (t) => {
  await fakeJev(t, () => ({ p: {} }))
  const env = start(t)
  const { room } = await team(env)
  env.rt.decide = async () => { throw new Error('boom') }
  await env.emit(room.id, env.userMessage('anyone?'))
  const { spoke } = await playRound(env, room.id, () => 'Chief answers the question in full here.')
  assert.deepEqual(spoke, ['Chief'])
  assert.deepEqual(env.audit().map(line => [nameOf(env, line), line.reason]), [['user', 'null'], ['Chief', 'null']])
})

// R1: in an auto relay that holds an owner post, the owner's newest post alone decides.
for (const jevBot of ['null', 'none']) {
  test(`23. [Jev for the Bot post ${jevBot}] owner "@Writer ..." and a Chief post in one relay: Writer answers the owner`, async (t) => {
    await fakeJev(t, () => (jevBot === 'null' ? { status: 500 } : { p: {} }))
    const env = start(t)
    const { room, ids } = await team(env)
    await env.emit(room.id, env.userMessage('@Writer please rewrite the launch copy today'))
    await env.emit(room.id, postEvent(ids, 'Chief', 'I pushed the new build to staging for everyone.'))
    const { spoke } = await playRound(env, room.id, name => `${name} replies with the launch copy details.`)
    assert.equal(spoke[0], 'Writer')
  })
}

test('24. an owner message and a Bot post that would pick the same member: it answers once, as the owner\'s', async (t) => {
  const jev = await fakeJev(t, body => (body.state.from === 'user' ? { p: { Writer: 0.9 }, delayMs: 100 } : body.state.from === 'Coder' ? { p: { Writer: 0.95 } } : { p: {} }))
  const env = start(t)
  const { room, ids } = await team(env)
  await env.emit(room.id, env.userMessage('Please plan the launch for Friday'))
  await env.emit(room.id, postEvent(ids, 'Coder', 'I merged the parser fix into main.'))
  const running = env.relay(room.id, 'relay')
  const progress = await waitFor(() => [...env.rt.roomProgress.values()].find(round => round.roomId === room.id))
  const slot = progress.slots.find(each => each.id === ids.Writer)
  const fromBot = slot?.fromBot
  const spoke = await drive(env, running, name => `${name} answers the launch plan now.`)
  assert.deepEqual(spoke.filter(name => name === 'Writer'), ['Writer'])
  assert.notEqual(fromBot, true, 'answers the owner, not a Bot')
  assert.ok(!jev.some(body => body.state.from === 'Coder' && body.state.message.includes('parser fix')), 'the Bot post is not judged')
})

// R3: a member a Bot names replies one hop deeper than that Bot.
test('25. owner @Writer, Writer @Coder, Coder calls nobody: Coder\'s reply is hop 2 (bar 0.7), so p 0.65 calls nobody', async (t) => {
  await fakeJev(t, body => (body.state.from === 'Coder' ? { p: { Tester: 0.65 } } : { p: {} }))
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('@Writer start the release notes'))
  const { spoke } = await playRound(env, room.id, name => (name === 'Writer' ? '@Coder please list the merged code changes for the notes.' : `${name} lists every merged change in detail.`))
  const coder = env.audit().find(line => nameOf(env, line) === 'Coder')
  assert.equal(coder?.hop, 2)
  assert.deepEqual(spoke, ['Writer', 'Coder'])
})

// R2: the count resets when the owner's message arrives, never later.
for (const delay of [0, 1200]) {
  test(`26. Jev always yes, an owner message and a Bot post in one relay, owner judgment ${delay} ms: at most 8 Bot-to-Bot picks`, async (t) => {
    await fakeJev(t, body => ({ p: { Writer: 0.95, Coder: 0.95, Tester: 0.95, Chief: 0.95 }, ...(body.state.from === 'user' ? { delayMs: delay } : {}) }))
    const env = start(t)
    const { room, ids } = await team(env)
    await env.emit(room.id, env.userMessage('Please plan the launch for Friday'))
    await env.emit(room.id, postEvent(ids, 'Chief', 'I pushed the new build to staging for everyone.'))
    await playRound(env, room.id, (name, n) => `${name} adds point ${n} to the launch plan.`)
    const botPicks = env.audit().filter(line => line.from !== 'user' && line.reason === 'jev').reduce((sum, line) => sum + line.picked.length, 0)
    assert.equal(botPicks, 8)
  })
}

test('27. worst case: Jev always yes, the owner writes mid-chain and its judgment takes 1200 ms: exactly 8 Bot-to-Bot picks after it', async (t) => {
  let second = false
  await fakeJev(t, (body) => {
    if (body.state.from === 'user') return body.state.message === 'second ask' ? { p: { Tester: 0.95 }, delayMs: 1200 } : { p: { Writer: 0.95 } }
    return { p: { Chief: 0.95, Writer: 0.95, Coder: 0.95, Tester: 0.95 } }
  })
  const env = start(t)
  const { room } = await team(env)
  await env.emit(room.id, env.userMessage('first ask'))
  const running = env.relay(room.id, 'relay')
  let mark
  await drive(env, running, (name, n) => `${name} adds point ${n} to the plan now.`, async (entry, who, n) => {
    if (n !== 3 || second) return
    second = true
    await env.compose(room.id, 'second ask')
    env.rt.nudgeRoom(room.id)
    await settle(60)
    mark = env.audit().length
  })
  await settle(200)
  const picks = env.audit().slice(mark).filter(line => line.from !== 'user' && line.reason === 'jev').reduce((sum, line) => sum + line.picked.length, 0)
  assert.equal(picks, 8, 'the chain reaches the cap, and no more')
})

// A group of the given members, set to auto; `prepare(rt, room)` edits saved data.
async function smallGroup(env, names, { jev = true } = {}) {
  const { call, rt, sent } = env
  const ids = { Chief: (await call('state', {})).value.mainBotId }
  for (const [name, role] of [['Writer', 'Writes copy'], ['Coder', 'Writes code'], ['Tester', 'Tests']]) {
    if (names.includes(name)) ids[name] = (await call('create-bot', { name, role })).value.id
  }
  const room = (await call('create-room', { name: 'R1', members: names.map(name => ids[name]) })).value
  await call('update-room', { id: room.id, mode: 'auto' })
  if (jev) await call('set-prefs', { jev: true })
  sent.length = 0
  return { room: rt.roomOf(room.id), ids }
}

test('28. no admin and no Main Bot, Jev null: every member answers the owner', async (t) => {
  await fakeJev(t, () => ({ status: 500 }))
  const env = start(t)
  const { room } = await smallGroup(env, ['Writer', 'Coder', 'Tester'])
  assert.equal(room.admin ?? null, null)
  await env.emit(room.id, env.userMessage('Anyone around?'))
  const { spoke } = await playRound(env, room.id, name => `${name} is here and ready to help.`)
  assert.deepEqual(spoke.toSorted(), ['Coder', 'Tester', 'Writer'])
})

test('29. the only other member is private: the default answers the owner; no request names it', async (t) => {
  const jev = await fakeJev(t, () => ({ p: {} }))
  const env = start(t)
  const { room, ids } = await smallGroup(env, ['Chief', 'Tester'])
  env.rt.botOf(ids.Tester).private = true
  await env.emit(room.id, env.userMessage('Can someone check the build?'))
  const { spoke } = await playRound(env, room.id, name => `${name} checked the build and it is green.`)
  assert.deepEqual(spoke, ['Chief'])
  assert.equal(jev.length, 1, 'Chief\'s reply has nobody to ask about')
  for (const body of jev) {
    const raw = JSON.stringify(body)
    assert.ok(!raw.includes('Tester') && !raw.includes('Tests'), raw)
  }
})

for (const jevOn of [true, false]) {
  test(`30. a group of one member, Jev ${jevOn ? 'on' : 'off'}: that member answers the owner`, async (t) => {
    await fakeJev(t, () => ({ p: { Chief: 0.9 } }))
    const env = start(t)
    const { room, ids } = await smallGroup(env, ['Chief', 'Writer'], { jev: jevOn })
    // A group cannot be made with one member; saved data can hold one.
    env.rt.roomOf(room.id).members = [ids.Chief]
    await env.emit(room.id, env.userMessage('Status please'))
    const { spoke } = await playRound(env, room.id, () => 'Chief reports that all work is on track.')
    assert.deepEqual(spoke, ['Chief'])
  })
}

// R4: in an auto relay the owner's post opens, each Bot post queued with it still calls
// the members its rules name (A-E); those members reply at hop 2 (F).
const postX = (ids, name, text, extra = {}) => ({ type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: ids[name], senderName: name, exchangeId: randomUUID(), ...extra }, content: [{ type: 'text', text: `[Group post from ${name}]\n${text}` }] } })
const OWNER_PLAN = 'Please plan the launch for Friday'
const BOT_PARTS = {
  'none': () => [],
  'Chief plain': ids => [postX(ids, 'Chief', 'I pushed the new build to staging for everyone.')],
  'Chief @Coder': ids => [postX(ids, 'Chief', '@Coder please fix the parser bug before the launch.', { mentions: { ids: [ids.Coder], all: false } })],
  'Writer(member) @Coder': ids => [postX(ids, 'Writer', '@Coder please list the merged code changes.', { member: true, mentions: { ids: [ids.Coder], all: false } })],
  'Writer late askedBy Coder': ids => [postX(ids, 'Writer', 'Here is the copy you asked for: launch on Friday at noon.', { late: true, askedBy: ids.Coder })],
  'Chief report_back @Coder': ids => [postX(ids, 'Chief', '@Coder please review the release branch today.', { reportBack: true, mentions: { ids: [ids.Coder], all: false } })],
  'Chief report_back plain': ids => [postX(ids, 'Chief', 'Please review the release plan for the launch.', { reportBack: true })],
}
const OWNER_PARTS = {
  'none': async () => [],
  'plain': async env => [env.userMessage(OWNER_PLAN)],
  '@Tester': async env => [env.userMessage('@Tester please run the launch checklist')],
  'goal draft': async (env, room) => {
    assert.equal((await env.call('goal-draft', { roomId: room.id, text: 'Ship the launch site' })).ok, true)
    const goalId = env.rt.roomOf(room.id).goal.id
    return [{ type: 'user/message', data: { source: { kind: 'bot', role: 'goal', goal: 'draft', goalId, exchangeId: randomUUID(), senderName: 'You' }, content: [{ type: 'text', text: '[Goal request]\nShip the launch site' }] } }]
  },
  'two plain': async env => [env.userMessage('Also check the launch budget'), env.userMessage(OWNER_PLAN)],
}
const WAKE = /finished the work you asked for/
// One relay of the given parts. Jev says yes for Writer only. Every member answers a
// status line (no judgment of it); Coder works first, so its caller is woken.
async function cell(t, mode, ownerPart, botPart) {
  const jev = await fakeJev(t, () => ({ p: { Writer: 0.95 } }))
  const env = start(t)
  const { room, ids } = await team(env, { mode })
  const events = [...await OWNER_PARTS[ownerPart](env, room), ...BOT_PARTS[botPart](ids)]
  env.sent.length = 0
  jev.length = 0
  for (const event of events) await env.emit(room.id, event)
  const turns = []
  await drive(env, env.relay(room.id, 'relay'), () => 'standby', async (entry, who) => {
    turns.push({ who, wake: WAKE.test(entry.message.content[0].text.split('\n')[0]) })
    if (who === 'Coder') env.rt.workRoomTurn(entry.sessionId, 'bash')
  })
  await settle(100)
  const reports = env.sent.filter(entry => entry.message.source.role === 'report').map(entry => [...entry.message.content[0].text.matchAll(/^(Chief|Writer|Coder|Tester): /gm)].map(m => m[1]))
  const called = turns.filter(turn => !turn.wake).map(turn => turn.who)
  return { called, set: [...new Set(called)].sort(), woken: turns.filter(turn => turn.wake).map(turn => turn.who).sort(), jev: jev.map(body => body.state.from), reports }
}

for (const [label, ownerPart, botPart, member] of [
  ['GA3-1', 'plain', 'Chief @Coder', 'Coder'],
  ['GA3-2', 'plain', 'Writer late askedBy Coder', 'Coder'],
  ['GA3-3', 'plain', 'Writer(member) @Coder', 'Coder'],
]) {
  test(`31. ${label} owner plain + ${botPart} in one auto relay: ${member} answers by the rule, the owner's pick too`, async (t) => {
    const result = await cell(t, 'auto', ownerPart, botPart)
    assert.deepEqual(result.set, ['Coder', 'Writer'])
  })
}

test('32. GA3-5 owner plain + Chief report_back "@Coder" in one auto relay: Coder answers, one report with Coder\'s reply only', async (t) => {
  const result = await cell(t, 'auto', 'plain', 'Chief report_back @Coder')
  assert.deepEqual(result.set, ['Coder', 'Writer'])
  assert.deepEqual(result.reports, [['Coder']])
})

test('33. matrix: owner part x Bot part in auto; Bot rule calls come from the same Bot part alone in an admin group', async (t) => {
  const admin = {}
  for (const botPart of Object.keys(BOT_PARTS)) if (botPart !== 'none') admin[botPart] = await cell(t, 'admin', 'none', botPart)
  const grid = {}
  for (const ownerPart of Object.keys(OWNER_PARTS)) {
    grid[ownerPart] = {}
    for (const botPart of Object.keys(BOT_PARTS)) {
      if (ownerPart !== 'none' || botPart !== 'none') grid[ownerPart][botPart] = await cell(t, 'auto', ownerPart, botPart)
    }
  }
  const owners = { 'plain': ['Writer'], '@Tester': ['Tester'], 'goal draft': ['Chief'], 'two plain': ['Writer'] }
  const table = []
  for (const [ownerPart, row] of Object.entries(grid)) {
    for (const [botPart, got] of Object.entries(row)) {
      table.push(`${ownerPart.padEnd(10)} | ${botPart.padEnd(26)} | called=${got.set.join(',') || '-'} woken=${got.woken.join(',') || '-'} jev=${got.jev.length}${got.jev.length ? `(${got.jev.join(',')})` : ''} reports=${JSON.stringify(got.reports)}`)
      const where = `${ownerPart} x ${botPart}: ${JSON.stringify(got)}`
      // The Bot part alone in auto: rules give the admin-mode calls, else one Bot-message judgment (D).
      const alone = grid.none[botPart]
      const rules = botPart === 'none' || alone.jev.length > 0 ? undefined : admin[botPart]
      if (ownerPart === 'none') {
        if (rules !== undefined) {
          assert.deepEqual([got.set, got.woken, got.jev], [rules.set, rules.woken, []], where)
        } else {
          assert.deepEqual([got.set, got.jev], [['Writer'], ['Chief']], where)
        }
        if (botPart.includes('report_back')) assert.deepEqual(got.reports, rules?.reports ?? [got.set], where)
        continue
      }
      const ruleCalls = rules?.set ?? []
      assert.ok(got.set.length > 0, where)
      assert.deepEqual(got.set, [...new Set([...owners[ownerPart], ...ruleCalls])].sort(), where)
      assert.equal(got.called.length, got.set.length, `each member once: ${where}`)
      assert.deepEqual(got.woken, rules?.woken ?? [], where)
      const ownerJudged = ['plain', 'two plain'].includes(ownerPart)
      assert.deepEqual(got.jev, ownerJudged ? ['user'] : [], where)
      if (botPart.includes('report_back')) assert.deepEqual(got.reports, [ruleCalls], where)
      else assert.deepEqual(got.reports, [], where)
    }
  }
  t.diagnostic(`matrix (owner | bot | result)\n${table.join('\n')}`)
})

// R4 F: a member a Bot's post calls by its rules replies at hop 2 (bar 0.7), so a 0.65
// pick from its reply calls nobody: in the relay the post opens, and in a running round.
test('34. GA3-8 a Bot post "@Coder" opens an auto relay; Coder calls nobody: Coder\'s reply is hop 2', async (t) => {
  await fakeJev(t, body => (body.state.from === 'Coder' ? { p: { Tester: 0.65 } } : { p: {} }))
  const env = start(t)
  const { room, ids } = await team(env)
  await env.emit(room.id, postX(ids, 'Writer', '@Coder please list the merged code changes.', { mentions: { ids: [ids.Coder], all: false } }))
  const { spoke } = await playRound(env, room.id, name => `${name} lists every merged change in detail.`)
  assert.equal(env.audit().find(line => nameOf(env, line) === 'Coder')?.hop, 2)
  assert.deepEqual(spoke, ['Coder'])
})

test('35. a Bot post "@Coder" into a running auto round (callPost); Coder calls nobody: Coder\'s reply is hop 2', async (t) => {
  await fakeJev(t, body => (body.state.from === 'Coder' ? { p: { Tester: 0.65 } } : { p: {} }))
  const env = start(t)
  const { room, ids } = await team(env)
  await env.emit(room.id, env.userMessage('@Writer hold the floor'))
  let posted = false
  const spoke = await drive(env, env.relay(room.id, 'relay'), name => `${name} lists every merged change in detail.`, async () => {
    if (posted) return
    posted = true
    await env.rt.postToRoom(env.rt.roomOf(room.id), env.rt.botOf(ids.Chief), '@Coder please list the merged code changes.', { mentions: { ids: [ids.Coder], all: false } })
  })
  assert.equal(env.audit().find(line => nameOf(env, line) === 'Coder')?.hop, 2)
  assert.deepEqual(spoke, ['Writer', 'Coder'])
})
