// Reconcile C2 / #133: Bots run DS Bot's own group goal, and DSH's session
// goal does not survive conversation parts — in the app the `/goal` command,
// and its tool are dead weight. Removing them needs
// new rows in the bundled presets, which the app must not rewrite, so the
// Host restates the preset rows without the goal rows through a `--patch`
// overlay it writes into its own data area next to the profiles
// (`<DSH_HOME>/profiles/goal.patch.yml`): DSH reads it only through
// `patchFiles` and nothing scans this location. The composer's goal bar
// stays — a DSH goal left from before must still be pausable, and no new
// one can start without the command or the tool. Preset rows carry `!!js`
// expressions; the overlay keeps them by writing through the same
// entry-list dialect the include parses. This reconciliation runs on the
// next launch.
//
// The same restatement gives every preset's compaction-basic row the headroom
// below: DSH keeps 65,536 tokens free, so a switch to a model whose window minus
// its output limit is 78,019 or less failed (MODEL_SWITCH_COMPACTION_FAILED).
// The row sits in a group inside the preset's `config.plugins`, which a patch
// cannot address by id.
//
// The same overlay adds the `bot-code` preset of a Bot's code mode (ds-bot's
// botPreset): the composed `standard` preset, restated as above, plus the PTC
// executor row, which applies to the scope that mounts it. Derived, not copied,
// so it follows `standard` across DSH upgrades and the owner's preset edits.
import { dirname, join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'

export const GOAL_PATCH_NAME = 'goal.patch.yml'

export const HEADROOM_TOKENS = 16_384

const PRESET = '@deepseek-ai/dsh-agent-preset'
export const CODE_PRESET = 'bot-code'
export const PTC_ROW = { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' }
const COMPACTION = '@deepseek-ai/dsh-compaction-basic'
const GOAL_ROWS = new Set(['@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal'])

// A group row keeps its child rows in `config`, a plain list.
const hasRow = (rows) => rows.some(row => GOAL_ROWS.has(row?.name) || row?.name === COMPACTION
  || (row?.group === true && Array.isArray(row.config) && hasRow(row.config)))

const restate = (rows) => rows
  .map(row => (row?.group === true && Array.isArray(row.config)
    ? { ...row, config: restate(row.config) }
    : row?.name === COMPACTION ? { ...row, config: { ...row.config, headroomTokens: HEADROOM_TOKENS } } : row))
  .filter(row => GOAL_ROWS.has(row?.name) === false)

/**
 * The overlay rows that restate every preset carrying goal rows without them, and
 * its compaction-basic row with the headroom merged into that row's config, or
 * `undefined` when no preset needs it. Composed over the bundles and the profile's
 * own patch, so user edits to a preset survive — minus the goal rows.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {import('@deepseek-ai/cordis-plugin-include').PatchOptions[] | undefined}
 */
export function goalPatch(profile) {
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const rows = entries
    .filter(entry => entry.name === PRESET && Array.isArray(entry.config?.plugins) && hasRow(entry.config.plugins))
    .map(entry => ({ id: entry.id, name: entry.name, config: { ...entry.config, plugins: restate(entry.config.plugins) } }))
  const standard = entries.find(entry => entry.name === PRESET && entry.config?.id === 'standard' && Array.isArray(entry.config.plugins))
  if (standard !== undefined) {
    rows.push({ insert: [{ id: `preset-${CODE_PRESET}`, name: PRESET, config: { ...standard.config, id: CODE_PRESET, plugins: [...restate(standard.config.plugins), PTC_ROW] } }] })
  }
  return rows.length === 0 ? undefined : rows
}

/**
 * Write the goal overlay next to the profiles and report it for `patchFiles`;
 * when none is needed, drop a stale one from an earlier launch.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} the `patchFiles` argument for this launch
 */
export function reconcileGoal(profile) {
  const file = join(dirname(profile.dir), GOAL_PATCH_NAME)
  const rows = goalPatch(profile)
  if (rows === undefined) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, dump(rows, { schema: entryListSchema }), 'utf8')
  return [file]
}
