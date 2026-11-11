import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { format } from 'node:util'
import { JEV_MODEL, install } from '../src/host/jev.js'

const KEY = 'ts-test-key-1234567890'
const QUESTIONS = {
  model: { type: 'choice', instructions: 'Which model?', criteria: { a: 'Model a', b: 'Model b' } },
  hard: { type: 'noul', instructions: 'Is it hard?' },
}
const GOOD = {
  model: JEV_MODEL,
  answers: {
    model: { type: 'choice', choice: 'b', confidence: 0.7, probabilities: { a: 0.15, b: 0.85 } },
    hard: { type: 'noul', noul: 0.9 },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
}

// A fake TypeSafe on 127.0.0.1; `reply(request, body, response)` answers each call.
async function fakeJev(t, reply) {
  const calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      calls.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined })
      reply(request, body, response)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const before = process.env.TYPESAFE_BASE_URL
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}`
  t.after(() => {
    server.closeAllConnections()
    server.close()
    if (before === undefined) delete process.env.TYPESAFE_BASE_URL
    else process.env.TYPESAFE_BASE_URL = before
  })
  return calls
}
const json = (status, value) => (_request, _body, response) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

// The client on a runtime with the switch `on`, a credential store holding `key`, and
// every warning and usage record kept.
function client({ on = true, key = KEY, bots = {} } = {}) {
  const warnings = []
  const usage = []
  const stored = new Map(key === null ? [] : [['TYPESAFE_API_KEY', key]])
  const credentials = {
    resolve: async ref => (stored.has(ref) ? { value: stored.get(ref), source: 'file' } : undefined),
    describe: async ref => ({ configured: stored.has(ref), writable: true }),
    set: async (ref, value) => { stored.set(ref, value) },
    unset: async (ref) => { stored.delete(ref) },
  }
  const rt = {
    ctx: { get: name => (name === 'credentials' ? credentials : undefined), on: () => () => {} },
    state: { prefs: on ? { jev: true } : {}, bots },
    warn: (template, ...args) => warnings.push(format(template, ...args)),
    botOf: id => bots[id],
    recordUsage: row => usage.push(row),
  }
  install(rt)
  return { rt, warnings, usage, stored }
}

test('a judgment returns the typed answers and counts its input tokens', async (t) => {
  const calls = await fakeJev(t, json(200, GOOD))
  const { rt, usage, warnings } = client()
  const answers = await rt.decide({ message: 'hello' }, QUESTIONS, { kind: 'judgment', sessionId: 's1' })
  assert.deepEqual(answers, {
    model: { type: 'choice', choice: 'b', confidence: 0.7, probabilities: { a: 0.15, b: 0.85 } },
    hard: { type: 'noul', noul: 0.9 },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/v1/systemone')
  assert.equal(calls[0].authorization, `Bearer ${KEY}`)
  assert.deepEqual(calls[0].body, { model: JEV_MODEL, state: { message: 'hello' }, questions: QUESTIONS })
  assert.deepEqual(usage, [{ sessionId: 's1', kind: 'judgment', provider: 'typesafe', model: JEV_MODEL, usage: { inputTokens: 120 } }])
  assert.deepEqual(warnings, [])
})

test('nothing is sent while the switch is off, or without a key', async (t) => {
  const calls = await fakeJev(t, json(200, GOOD))
  const off = client({ on: false })
  assert.equal(await off.rt.decide({ message: 'x' }, QUESTIONS), null)
  const keyless = client({ key: null })
  assert.equal(await keyless.rt.decide({ message: 'x' }, QUESTIONS), null)
  assert.equal(calls.length, 0)
  assert.deepEqual(off.warnings, [])
  // A keyless switch says so once, not on every message.
  assert.equal(await keyless.rt.decide({ message: 'y' }, QUESTIONS), null)
  assert.equal(keyless.warnings.length, 1)
})

test('a private Bot\'s content is never sent', async (t) => {
  const calls = await fakeJev(t, json(200, GOOD))
  const { rt } = client({ bots: { p: { id: 'p', private: true }, o: { id: 'o' } } })
  assert.equal(await rt.decide({ message: 'secret plans' }, QUESTIONS, { botId: 'p' }), null)
  assert.notEqual(await rt.decide({ message: 'open' }, QUESTIONS, { botId: 'o' }), null)
  assert.equal(calls.length, 1)
})

test('every failure resolves to null, is logged once with a reason, and counts nothing', async (t) => {
  const bodies = [
    ['HTTP 500', json(500, { detail: 'boom' })],
    ['HTTP 401', json(401, { detail: 'bad key' })],
    ['not JSON', (_request, _body, response) => { response.writeHead(200); response.end('<html>') }],
    ['over the size cap', json(200, { ...GOOD, pad: 'x'.repeat(70_000) })],
    ['a choice that was not offered', json(200, { ...GOOD, answers: { ...GOOD.answers, model: { ...GOOD.answers.model, choice: 'c' } } })],
    ['a probability for an option not offered', json(200, { ...GOOD, answers: { ...GOOD.answers, model: { ...GOOD.answers.model, probabilities: { a: 0.1, b: 0.8, c: 0.1 } } } })],
    ['a question left unanswered', json(200, { ...GOOD, answers: { model: GOOD.answers.model } })],
    ['an answer of the wrong type', json(200, { ...GOOD, answers: { ...GOOD.answers, hard: { type: 'choice', choice: 'a', probabilities: {} } } })],
    ['a noul outside 0 to 1', json(200, { ...GOOD, answers: { ...GOOD.answers, hard: { type: 'noul', noul: 1.5 } } })],
    ['no usage', json(200, { ...GOOD, usage: undefined })],
    ['a redirect', (_request, _body, response) => { response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }); response.end() }],
  ]
  let current
  await fakeJev(t, (...args) => current(...args))
  for (const [what, reply] of bodies) {
    current = reply
    const { rt, warnings, usage } = client()
    assert.equal(await rt.decide({ message: 'hello' }, QUESTIONS), null, what)
    assert.equal(warnings.length, 1, what)
    assert.match(warnings[0], /judgment \(judgment\) not used/, what)
    assert.doesNotMatch(warnings[0], /hello|ts-test-key/, what)
    assert.deepEqual(usage, [], what)
  }
})

test('a slow answer times out to null within its budget', async (t) => {
  await fakeJev(t, (request, body, response) => { setTimeout(() => json(200, GOOD)(request, body, response), 2000).unref() })
  const { rt, warnings } = client()
  const started = Date.now()
  assert.equal(await rt.decide({ message: 'hello' }, QUESTIONS, { timeoutMs: 150 }), null)
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
  assert.match(warnings[0], /no answer within 150 ms/)
})

test('a network error resolves to null', async (t) => {
  const before = process.env.TYPESAFE_BASE_URL
  // Nothing listens on port 1.
  process.env.TYPESAFE_BASE_URL = 'http://127.0.0.1:1'
  t.after(() => { if (before === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = before })
  const { rt, warnings } = client()
  assert.equal(await rt.decide({ message: 'hello' }, QUESTIONS), null)
  assert.match(warnings[0], /network error/)
})

test('a malformed question set sends nothing', async (t) => {
  const calls = await fakeJev(t, json(200, GOOD))
  const { rt } = client()
  assert.equal(await rt.decide({ message: 'x' }, { only: { type: 'choice', criteria: { a: 'one' } } }), null)
  assert.equal(await rt.decide({ message: 'x' }, {}), null)
  assert.equal(await rt.decide({ message: 'x' }, { s: { type: 'score', criteria: ['low', 'high'] } }), null)
  assert.equal(calls.length, 0)
})

test('a choice without confidence still parses; a key is stored, reported only as set', async (t) => {
  await fakeJev(t, json(200, { ...GOOD, answers: { ...GOOD.answers, model: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } } } }))
  const { rt, stored } = client({ key: null })
  assert.deepEqual(rt.jevKey(), { set: false, writable: false })
  assert.deepEqual(await rt.setJevKey(`  ${KEY}  `), { set: true, writable: true })
  assert.equal(stored.get('TYPESAFE_API_KEY'), KEY)
  const answers = await rt.decide({ message: 'x' }, QUESTIONS)
  assert.deepEqual(answers.model, { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } })
  await assert.rejects(rt.setJevKey('NAME=value'), /Paste only the key/)
  assert.deepEqual(await rt.setJevKey(null), { set: false, writable: true })
  assert.equal(stored.has('TYPESAFE_API_KEY'), false)
})
