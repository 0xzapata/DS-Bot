import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_ROSTER, createSource, indexRoster, isAgentSession, onRunningChange } from '../src/client/sources.js'
import { groupsFor } from '../src/client/surface.js'

const ROSTER_VALUE = {
  revision: 3,
  mainBotId: 'm1',
  mainBotIds: ['m1'],
  bots: [{ id: 'm1', sessionId: 'm1', name: 'Chief', parts: [] }],
  rooms: [{ id: 'g1', name: 'Group', members: ['m1'] }],
  agents: [{ id: 'a1', name: 'DSH Agent', sessions: ['s1', 's2'], createdAt: 5 }],
  exchangeTurns: {},
  questions: {},
}

test('indexRoster indexes agents by id and by Session', () => {
  const roster = indexRoster(ROSTER_VALUE)
  assert.deepEqual(roster.agents.map(agent => agent.id), ['a1'])
  assert.equal(roster.agentsById.a1.name, 'DSH Agent')
  assert.equal(roster.agentOf.s1, 'a1')
  assert.equal(roster.agentOf.s2, 'a1')
  assert.equal(roster.agentOf.m1, undefined)
  // The Agent never enters the Bot index.
  assert.equal(roster.byId.s1, undefined)
  assert.equal(roster.byId.a1, undefined)
})

test('a roster without agents still answers the index reads', () => {
  const roster = indexRoster({ ...ROSTER_VALUE, agents: undefined })
  assert.deepEqual(roster.agents, [])
  assert.deepEqual(roster.agentOf, {})
})

// The plain flag decides which groups mount: an Agent Session keeps the shell and
// withdraws only the conversation replacements.
test('isAgentSession follows the roster first, the cache before it is ready', () => {
  const roster = indexRoster(ROSTER_VALUE)
  assert.equal(isAgentSession(roster, new Set(), 's1'), true)
  assert.equal(isAgentSession(roster, new Set(), 'm1'), false)
  assert.equal(isAgentSession(roster, new Set(), 'g1'), false)
  // Not ready: the cached ids from the last pull answer.
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(['s1']), 's1'), true)
  // A ready roster wins over a stale cache.
  assert.equal(isAgentSession(roster, new Set(['m1']), 'm1'), false)
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(), ''), false)
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(), undefined), false)
})

test('the plain flag maps to the mounted groups', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(indexRoster(ROSTER_VALUE), new Set(), 's1') }), { shell: true, conversation: false })
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(indexRoster(ROSTER_VALUE), new Set(), 'm1') }), { shell: true, conversation: true })
})

test('a Session that starts or stops running is reported, other list changes are not', () => {
  const list = createSource({ byId: { b: { id: 'b', running: false, updatedAt: 1 } } })
  const seen = []
  const off = onRunningChange(list, () => seen.push(Object.values(list.getSnapshot().byId).map(row => row.running)))
  list.set({ byId: { b: { id: 'b', running: false, updatedAt: 2 } } })
  assert.equal(seen.length, 0)
  list.set({ byId: { b: { id: 'b', running: true, updatedAt: 2 } } })
  list.set({ byId: { b: { id: 'b', running: false, updatedAt: 2 } } })
  // A Session that appears already running counts; one that leaves the list does not.
  list.set({ byId: { b: { id: 'b', running: false, updatedAt: 2 }, c: { id: 'c', running: true } } })
  list.set({ byId: { b: { id: 'b', running: false, updatedAt: 2 } } })
  assert.deepEqual(seen, [[true], [false], [false, true]])
  off()
  list.set({ byId: { b: { id: 'b', running: true } } })
  assert.equal(seen.length, 3)
})
