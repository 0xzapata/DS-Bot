import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { GOAL_PATCH_NAME, HEADROOM_TOKENS, goalPatch, reconcileGoal } from '../src/goal-patch.mjs'

const PRESETS = fileURLToPath(new URL('presets/', import.meta.resolve('@deepseek-ai/dsh-web-app/package.json')))
const GOAL_NAMES = new Set(['@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal'])
const COMPACTION = '@deepseek-ai/dsh-compaction-basic'

// The dsh-web-app bundle's preset patches, as the app's own launch reads them.
const realLayers = readdirSync(PRESETS).filter(name => name.endsWith('.patch.yml'))
  .map(name => ({ packageName: '@deepseek-ai/dsh-web-app', packageDir: PRESETS, patchPaths: [], patches: load(readFileSync(join(PRESETS, name), 'utf8'), { schema: entryListSchema }) }))

const flat = (patches) => patches.flatMap(patch => patch.insert ?? [patch])

const countRows = (names) => function count(rows) {
  return rows.reduce((n, row) => n + (names.has(row?.name) ? 1 : 0)
    + (row?.group === true && Array.isArray(row.config) ? count(row.config) : 0), 0)
}
const countGoalRows = countRows(GOAL_NAMES)
const countCompactionRows = countRows(new Set([COMPACTION]))
// Every compaction-basic row at any depth.
const compactionRows = (rows) => rows.flatMap(row => (row?.name === COMPACTION ? [row]
  : row?.group === true && Array.isArray(row.config) ? compactionRows(row.config) : []))

function profile({ layers = realLayers, patches = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-goal-patch-'))
  const dir = join(home, 'profiles', 'ds-bot')
  mkdirSync(dir, { recursive: true })
  return { name: 'ds-bot', dir, patchPath: join(dir, 'cordis.patch.yml'), skippedBundles: [], layers, patches, home }
}

describe('goalPatch', () => {
  const made = []
  const track = (...args) => { const p = profile(...args); made.push(p.home); return p }
  after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

  test('restates every real preset that carries goal or compaction rows: minus the goal rows, with the headroom', () => {
    const rows = goalPatch(track())
    assert.ok(rows !== undefined)
    const restated = new Map(rows.map(row => [row.id, row]))
    // The standard, ptc, cordis and minimal presets; minimal has no goal rows.
    assert.equal(restated.size >= 4, true)
    assert.ok(restated.has('preset-minimal'))
    for (const layer of realLayers) {
      for (const patch of layer.patches) {
        for (const preset of patch.insert ?? []) {
          const source = preset.config?.plugins ?? []
          if (countGoalRows(source) === 0 && countCompactionRows(source) === 0) {
            assert.equal(restated.has(preset.id), false)
            continue
          }
          const row = restated.get(preset.id)
          assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
          // The restated plugins list is the source list minus the goal rows, each
          // compaction-basic row with the headroom.
          const expected = source
            .map(r => (r?.group === true && Array.isArray(r.config)
              ? { ...r, config: r.config.filter(c => !GOAL_NAMES.has(c?.name)).map(c => (c?.name === COMPACTION ? { ...c, config: { headroomTokens: HEADROOM_TOKENS } } : c)) }
              : r))
            .filter(r => !GOAL_NAMES.has(r?.name))
          assert.equal(countGoalRows(row.config.plugins), 0)
          assert.equal(countCompactionRows(row.config.plugins), countCompactionRows(source))
          for (const compaction of compactionRows(row.config.plugins)) assert.equal(compaction.config.headroomTokens, 16_384)
          assert.deepEqual(row.config.plugins, expected)
          assert.deepEqual({ ...row.config, plugins: source }, preset.config)
        }
      }
    }
  })

  test('every composed preset that mounts compaction-basic carries the headroom after the patch', () => {
    const rows = goalPatch(track())
    const presets = realLayers.flatMap(layer => layer.patches).flatMap(patch => patch.insert ?? []).filter(row => countCompactionRows(row.config?.plugins ?? []) > 0)
    assert.ok(presets.length >= 4)
    for (const preset of presets) {
      const row = rows.find(r => r.id === preset.id)
      assert.ok(row !== undefined, preset.id)
      assert.deepEqual(compactionRows(row.config.plugins).map(c => c.config.headroomTokens), compactionRows(preset.config.plugins).map(() => 16_384), preset.id)
    }
  })

  test('a user-edited compaction-basic config keeps its other keys', () => {
    const standard = realLayers.flatMap(layer => layer.patches).flatMap(patch => patch.insert ?? []).find(row => row.id === 'preset-standard')
    const edit = rows => rows.map(row => (row?.group === true && Array.isArray(row.config) ? { ...row, config: edit(row.config) }
      : row?.name === COMPACTION ? { ...row, config: { thresholdRatio: 0.7, auto: true } } : row))
    const rows = goalPatch(track({ patches: [{ id: 'preset-standard', config: { ...standard.config, plugins: edit(standard.config.plugins) } }] }))
    const [compaction] = compactionRows(rows.find(r => r.id === 'preset-standard').config.plugins)
    assert.deepEqual(compaction.config, { thresholdRatio: 0.7, auto: true, headroomTokens: 16_384 })
    assert.equal(countGoalRows(rows.find(r => r.id === 'preset-standard').config.plugins), 0)
  })

  test('keeps !!js rows as expression objects the overlay writes back as !!js scalars', () => {
    const p = track()
    const [file] = reconcileGoal(p)
    const content = readFileSync(file, 'utf8')
    assert.match(content, /!!js process\.platform === 'win32'/)
    assert.doesNotMatch(content, /__jsExpr/)
    const parsed = load(content, { schema: entryListSchema })
    const standard = parsed.find(row => row.id === 'preset-standard')
    const bash = standard.config.plugins.find(row => row.id === 'tool-bash')
    assert.deepEqual(bash.disabled, { __jsExpr: "process.platform === 'win32'" })
  })

  test('does nothing when no preset carries goal rows', () => {
    const preset = { insert: [{ id: 'preset-free', name: '@deepseek-ai/dsh-agent-preset', config: { plugins: [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }] } }] }
    assert.equal(goalPatch(track({ layers: [{ packageName: 'x', packageDir: '', patchPaths: [], patches: [preset] }] })), undefined)
  })

  test('a profile-patch edit to a preset survives, minus the goal rows', () => {
    const standard = realLayers.flatMap(layer => layer.patches).flatMap(patch => patch.insert ?? []).find(row => row.id === 'preset-standard')
    const edited = standard.config.plugins.map(row => (row.id === 'tool-bash' ? { ...row, disabled: false } : row))
    const rows = goalPatch(track({ patches: [{ id: 'preset-standard', config: { ...standard.config, plugins: edited } }] }))
    const row = rows.find(r => r.id === 'preset-standard')
    assert.equal(row.config.plugins.find(r => r.id === 'tool-bash').disabled, false)
    assert.equal(countGoalRows(row.config.plugins), 0)
  })
})

describe('reconcileGoal', () => {
  test('writes the overlay next to the profiles and drops a stale one when satisfied', () => {
    const p = profile()
    try {
      const [file] = reconcileGoal(p)
      // Outside the profile directory itself, so DSH only reads it through patchFiles.
      assert.equal(file, join(dirname(p.dir), GOAL_PATCH_NAME))
      assert.notEqual(file, p.patchPath)
      assert.equal(readFileSync(file, 'utf8').includes('command-goal') === false, true)
      // A later launch with nothing to change drops the stale overlay.
      assert.deepEqual(reconcileGoal({ ...p, layers: [], patches: [] }), [])
      assert.equal(existsSync(file), false)
    } finally { rmSync(p.home, { recursive: true, force: true }) }
  })
})
