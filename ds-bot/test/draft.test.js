// Background checkpoints (draft.js) on a fake Session: one draft per part, taken once,
// handed over only for the input it was written from, and dropped when it no longer fits.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDrafts, spanOf, summaryInput } from '../src/host/draft.js'
import { estimateTokens } from '../src/host/text.js'

test('one draft in flight; a second trigger does nothing; the hook gives the held summary only for its input', async () => {
  const writes = []
  const gate = Promise.withResolvers()
  const drafts = createDrafts({
    rt: { warn() {} },
    write: async (input) => { writes.push(input); await gate.promise; return { summary: [{ type: 'text', text: 'held' }] } },
    current: () => true,
    measure: () => ({ totalTokens: 1_000, nodes: [{ seq: 1, tokens: 100 }, { seq: 2, tokens: 100 }, { seq: 3, tokens: 100 }] }),
    size: estimateTokens,
  })
  const events = [
    { type: 'system/message', data: {} },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant/message', data: {} },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'b' }] } },
    { type: 'assistant/message', data: {} },
  ]
  const session = {
    surface: { nodes: [0, 1, 2, 3, 4], replaceGeneration: 0 },
    eventAt: seq => events[seq],
    deriveEventMessage: event => ({ role: event.type.split('/')[0], text: event.data.content?.[0]?.text }),
    requestHeader: () => ({ tools: [] }),
  }
  const agent = { id: 'b', session }
  assert.deepEqual(spanOf(session).seqs, [1, 2, 3])
  const first = drafts.start(agent)
  assert.equal(drafts.start(agent), first)
  assert.equal(writes.length, 1)
  gate.resolve()
  assert.equal(await drafts.compact(agent, { check: 2_000 }), true)
  assert.equal(drafts.fits(agent, { check: 2_000 }), true)
  const entry = drafts.take(agent, { check: 2_000 })
  assert.equal(drafts.take(agent, { check: 2_000 }), undefined, 'taken once')
  let handed
  await drafts.apply(agent, entry, async () => { handed = drafts.summary('b', summaryInput(session, [1, 2, 3])) })
  assert.equal(handed.summary[0].text, 'held')
  await assert.rejects(drafts.apply(agent, entry, async () => drafts.summary('b', { messages: [] })), /no longer matches/)
  assert.equal(drafts.summary('b', {}), undefined, 'no apply runs')
})

test('a draft over the size share or on a changed surface is not used', async () => {
  const make = (totalTokens) => createDrafts({
    rt: { warn() {} },
    write: async () => ({ summary: [{ type: 'text', text: 'x'.repeat(4_000) }] }),
    current: () => true,
    measure: () => ({ totalTokens, nodes: [0, 1, 2, 3, 4].map(seq => ({ seq, tokens: 500 })) }),
    size: estimateTokens,
  })
  const events = [{ type: 'user/message', data: {} }, { type: 'user/message', data: {} }, { type: 'assistant/message', data: {} }, { type: 'user/message', data: {} }, { type: 'assistant/message', data: {} }]
  const session = { surface: { nodes: [0, 1, 2, 3, 4], replaceGeneration: 0 }, eventAt: seq => events[seq], deriveEventMessage: () => ({}), requestHeader: () => undefined }
  const agent = { id: 'b', session }
  // No system head: the span is nodes 0-3 (2,000 tokens), the summary ~1,000.
  assert.equal(await make(2_000).compact(agent, { check: 4_000 }), true)
  assert.equal(await make(5_000).compact(agent, { check: 4_000 }), false)
  const drafts = make(2_000)
  assert.equal(await drafts.compact(agent, { check: 4_000 }), true)
  session.surface.replaceGeneration = 1
  assert.equal(drafts.fits(agent, { check: 4_000 }), false)
  assert.equal(drafts.marked('b'), false, 'dropped')
})

test('after two failed drafts in a row no third starts, until a checkpoint succeeds', async () => {
  let fail = true
  let writes = 0
  const drafts = createDrafts({
    rt: { warn() {} },
    write: async () => { writes += 1; if (fail) throw new Error('down'); return { summary: [{ type: 'text', text: 's' }] } },
    current: () => true,
    measure: () => ({ totalTokens: 1_000, nodes: [0, 1, 2].map(seq => ({ seq, tokens: 300 })) }),
    size: estimateTokens,
  })
  const events = [{ type: 'user/message', data: {} }, { type: 'assistant/message', data: {} }, { type: 'assistant/message', data: {} }]
  const agent = { id: 'b', session: { surface: { nodes: [0, 1, 2], replaceGeneration: 0 }, eventAt: seq => events[seq], deriveEventMessage: () => ({}), requestHeader: () => undefined } }
  assert.equal(await drafts.compact(agent, { check: 4_000 }), false)
  assert.equal(await drafts.compact(agent, { check: 4_000 }), false)
  assert.equal(drafts.start(agent), undefined)
  assert.equal(writes, 2)
  drafts.succeeded('b')
  fail = false
  assert.equal(await drafts.compact(agent, { check: 4_000 }), true)
  assert.equal(writes, 3)
})
