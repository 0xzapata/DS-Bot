// The `bot-code` preset of a Bot's code mode, as the running app composes it: the real
// dsh-web-app presets, then the app's overlay (goal-patch.mjs) that DSH reads through
// `patchFiles`. Its rows are the restated `standard` rows plus the PTC executor row.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { CODE_PRESET, PTC_ROW, goalPatch, reconcileGoal } from '../src/goal-patch.mjs'

const PRESETS = fileURLToPath(new URL('presets/', import.meta.resolve('@deepseek-ai/dsh-web-app/package.json')))
const layers = readdirSync(PRESETS).filter(name => name.endsWith('.patch.yml'))
  .map(name => ({ patches: load(readFileSync(join(PRESETS, name), 'utf8'), { schema: entryListSchema }) }))
const presetOf = (entries, id) => entries.find(entry => entry.name === '@deepseek-ai/dsh-agent-preset' && entry.config?.id === id)

test('the written overlay gives the composed profile a bot-code preset: standard plus the PTC executor row', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-code-preset-'))
  try {
    const dir = join(home, 'profiles', 'ds-bot')
    mkdirSync(dir, { recursive: true })
    const [file] = reconcileGoal({ dir, layers, patches: [] })
    const overlay = load(readFileSync(file, 'utf8'), { schema: entryListSchema })
    // As DSH composes it: bundle layers, the profile patch, then the --patch overlays.
    const entries = composeEntries([...layers.map(layer => layer.patches), [], overlay])
    const standard = presetOf(entries, 'standard')
    const code = presetOf(entries, CODE_PRESET)
    assert.ok(code !== undefined)
    assert.deepEqual(code.config.plugins, [...standard.config.plugins, PTC_ROW])
    assert.deepEqual({ ...code.config, id: 'standard', plugins: standard.config.plugins }, standard.config)
    // Every row once: the executor is the one row standard lacks.
    const names = config => config.plugins.map(row => row.id)
    assert.deepEqual(names(code.config).filter(id => !names(standard.config).includes(id)), ['tool-executor-ptc'])
    assert.equal(names(standard.config).includes('tool-executor-ptc'), false)
    // The goal rows are gone from both; the headroom applies to both.
    assert.doesNotMatch(JSON.stringify(code.config), /dsh-command-goal|dsh-tool-goal/)
    assert.match(JSON.stringify(code.config), /"headroomTokens":16384/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a profile edit to standard reaches bot-code', () => {
  const standard = presetOf(composeEntries(layers.map(layer => layer.patches)), 'standard')
  const plugins = standard.config.plugins.filter(row => row.id !== 'tool-web')
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-code-preset-'))
  try {
    const dir = join(home, 'profiles', 'ds-bot')
    mkdirSync(dir, { recursive: true })
    const patches = [{ id: 'preset-standard', config: { ...standard.config, plugins } }]
    const [file] = reconcileGoal({ dir, layers, patches })
    const entries = composeEntries([...layers.map(layer => layer.patches), patches, load(readFileSync(file, 'utf8'), { schema: entryListSchema })])
    assert.equal(presetOf(entries, CODE_PRESET).config.plugins.some(row => row.id === 'tool-web'), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

const codeRows = rows => (rows ?? []).filter(row => row.insert?.some(entry => entry.config?.id === CODE_PRESET))

test('no bot-code over one the profile already has, by preset id or by row id', () => {
  const ownPreset = [{ insert: [{ id: 'my-bot-code', name: '@deepseek-ai/dsh-agent-preset', config: { id: CODE_PRESET, plugins: [] } }] }]
  assert.deepEqual(codeRows(goalPatch({ layers, patches: ownPreset })), [])
  const ownRow = [{ insert: [{ id: `preset-${CODE_PRESET}`, name: '@deepseek-ai/dsh-persona' }] }]
  assert.deepEqual(codeRows(goalPatch({ layers, patches: ownRow })), [])
})

test('no bot-code when standard is absent or turned off', () => {
  const noStandard = layers.map(layer => ({ patches: layer.patches.filter(row => !(row.insert ?? []).some(entry => entry.config?.id === 'standard')) }))
  assert.deepEqual(codeRows(goalPatch({ layers: noStandard, patches: [] })), [])
  assert.deepEqual(codeRows(goalPatch({ layers, patches: [{ id: 'preset-standard', disabled: true }] })), [])
  // An ordinary profile still gets it.
  assert.equal(codeRows(goalPatch({ layers, patches: [] })).length, 1)
})
