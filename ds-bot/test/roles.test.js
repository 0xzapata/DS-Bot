import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { allows, install } from '../src/host/roles.js'
import { normalize, unquote } from '../src/host/text.js'
import { fakeContext } from './fake-ctx.js'

// The host enforces each role's rights in DSH's tool guard, before any tool body runs.
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-roles-'))
  const ctx = fakeContext()
  const warnings = []
  const state = {
    mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', name: 'Chief' }, lead: { id: 'lead', name: 'Lead' }, kai: { id: 'kai', name: 'Kai' } },
    rooms: { r1: { id: 'r1', name: 'Dev', admin: 'lead', members: ['chief', 'lead', 'kai'] }, r2: { id: 'r2', name: 'Ops', admin: 'chief', members: ['chief', 'lead'] } },
  }
  const sessions = { 's-chief': 'chief', 's-lead': 'lead', 's-kai': 'kai' }
  const rt = {
    ctx, home, state,
    warn: (...args) => warnings.push(format(...args)),
    readOnly: () => undefined,
    isMain: id => state.mainBotIds.includes(id),
    isAdminOf: (room, id) => room.admin === id,
    // As the store finds a group: by id, else by name without quotes or case.
    findRooms: ref => (state.rooms[ref] ? [state.rooms[ref]] : Object.values(state.rooms).filter(room => normalize(room.name) === normalize(unquote(ref)))),
    isBotSession: id => id in sessions,
    selfOf: id => sessions[id],
    botOf: id => state.bots[id],
  }
  install(rt)
  const guard = ctx.guards.at(-1)
  const callAs = (sessionId, name, args = {}) => guard({ agent: { id: sessionId }, name, arguments: args })
  return { rt, callAs, home, warnings, stop: () => rmSync(home, { recursive: true, force: true }) }
}

test('a member calling a Main-Bot-only tool is refused by the host with a clear error', async (t) => {
  const { callAs, home, warnings, stop } = setup()
  t.after(stop)
  const refusal = callAs('s-kai', 'create_bot', { name: 'X' })
  assert.match(refusal, /^Refused by DS Bot: create_bot needs a Main Bot, and you are a member\./)
  assert.match(callAs('s-kai', 'stop_bot', { bot: 'Chief' }), /stop_bot needs a Main Bot/)
  assert.ok(warnings.some(line => /Kai was refused create_bot/.test(line)))
  // The refusal leaves an audit line.
  await new Promise(done => setTimeout(done, 50))
  const lines = readFileSync(join(home, 'role-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(({ bot, tool, role, allowed }) => [bot, tool, role, allowed]), [['kai', 'create_bot', 'member', false], ['kai', 'stop_bot', 'member', false]])
})

test('a Main Bot is allowed, and the call is audited as main', async (t) => {
  const { callAs, home, stop } = setup()
  t.after(stop)
  assert.equal(callAs('s-chief', 'create_bot', { name: 'X' }), undefined)
  assert.equal(callAs('s-chief', 'delete_group', { group: 'Dev' }), undefined)
  await new Promise(done => setTimeout(done, 50))
  const lines = readFileSync(join(home, 'role-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(({ tool, role, allowed }) => [tool, role, allowed]), [['create_bot', 'main', true], ['delete_group', 'main', true]])
})

test('a group admin may change its own group but not another, and tools open to all pass', (t) => {
  const { callAs, stop } = setup()
  t.after(stop)
  assert.equal(callAs('s-lead', 'update_group', { group: 'Dev' }), undefined)
  // The names update_group itself accepts: by id, in quotes, in another case.
  for (const group of ['r1', '"Dev"', '「Dev」', ' dev ']) assert.equal(callAs('s-lead', 'update_group', { group }), undefined, group)
  assert.match(callAs('s-lead', 'update_group', { group: '"Ops"' }), /you are a member/)
  assert.match(callAs('s-lead', 'update_group', { group: 'Ops' }), /update_group needs a Main Bot or the group's admin, and you are a member/)
  assert.match(callAs('s-lead', 'create_group', {}), /needs a Main Bot, and you are a group admin/)
  assert.match(callAs('s-kai', 'update_group', { group: 'Dev' }), /needs a Main Bot or the group's admin/)
  // Open tools and non-Bot Sessions are left alone.
  assert.equal(callAs('s-kai', 'message_bot', { bot: 'Chief' }), undefined)
  assert.equal(callAs('s-other', 'create_bot', {}), undefined)
})

test('the roles view lists each role, its rights, and who holds it', (t) => {
  const { rt, stop } = setup()
  t.after(stop)
  const view = rt.rolesView()
  assert.deepEqual(view.roles.map(({ role, bots }) => [role, bots]), [['main', ['chief']], ['admin', ['lead']], ['member', ['kai']]])
  assert.ok(view.roles.every(role => role.rights.length > 0))
  assert.deepEqual(Object.fromEntries(view.gated.map(({ tool, needed }) => [tool, needed])), { create_bot: 'main', stop_bot: 'main', create_group: 'main', delete_group: 'main', update_group: 'admin' })
})

test('the guard refuses a role or a need it does not know', () => {
  assert.equal(allows('main', 'main'), true)
  assert.equal(allows('admin', 'admin'), true)
  assert.equal(allows('member', 'admin'), false)
  for (const role of ['guest', '', undefined, null, 'Main']) assert.equal(allows(role, 'main'), false, String(role))
  for (const needed of ['root', undefined]) assert.equal(allows('main', needed), false, String(needed))
})
