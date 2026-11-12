// The headroom goal-patch.mjs gives every preset's compaction-basic row, on DSH's real
// agent loop: a Bot that switches from a 160,000 window to an 80,000 one (both with 4,000
// of output) gets its answer on the new model. With DSH's default (65,536) that switch
// fails with MODEL_SWITCH_COMPACTION_FAILED.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { HEADROOM_TOKENS, goalPatch } from '../src/goal-patch.mjs'

// The compaction-basic config of the standard preset (a Bot's) after the app's patch.
const PRESETS = fileURLToPath(new URL('presets/', import.meta.resolve('@deepseek-ai/dsh-web-app/package.json')))
const layers = readdirSync(PRESETS).filter(name => name.endsWith('.patch.yml'))
  .map(name => ({ patches: load(readFileSync(join(PRESETS, name), 'utf8'), { schema: entryListSchema }) }))
const find = rows => rows.flatMap(row => (row?.name === '@deepseek-ai/dsh-compaction-basic' ? [row.config]
  : row?.group === true && Array.isArray(row.config) ? find(row.config) : []))
const [appConfig] = find(goalPatch({ layers, patches: [] }).find(row => row.id === 'preset-standard').config.plugins)

const P = 'hr'
const MODELS = { big: 160_000, small: 80_000 }
const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('')

async function switchOnce(t, compaction) {
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry, TokenMeter]) await ctx.plugin(plugin)
  const asked = []
  class Mock extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: MODELS[id] }, defaultMaxTokens: 4_000 } }
    async listModels() { return Object.keys(MODELS).map(id => ({ id, name: id })) }
    async *stream(options) {
      const last = textOf(options.messages.at(-1))
      asked.push([options.model, last])
      const text = `answer to ${last}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([P], new Mock())
  await ctx.plugin(BasicCompactionEngine, compaction)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agentLoop.create(SessionId('s'), { provider: P, model: 'big' })
  t.after(() => ctx.fiber.dispose())
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error?.code ?? String(error)))
  const say = async (text) => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    const end = Date.now() + 5000
    do await new Promise(resolve => setTimeout(resolve, 10))
    while ((agent.status !== 'idle' || agent.inbox.hasPending) && Date.now() < end)
  }
  await say('before')
  await agent.model.select({ provider: P, model: 'small' })
  await say('after')
  const answers = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').map(event => textOf(event.data.message ?? event.data))
  return { errors, asked, answers }
}

test('the app\'s headroom: a switch from a 160,000 to an 80,000 window is answered on the new model', async (t) => {
  assert.deepEqual(appConfig, { headroomTokens: HEADROOM_TOKENS })
  assert.equal(HEADROOM_TOKENS, 16_384)
  const { errors, asked, answers } = await switchOnce(t, appConfig)
  assert.deepEqual(errors, [])
  assert.deepEqual(asked, [['big', 'before'], ['small', 'after']])
  assert.deepEqual(answers, ['answer to before', 'answer to after'])
})

test('DSH\'s default headroom fails the same switch', async (t) => {
  const { errors, asked, answers } = await switchOnce(t, {})
  assert.deepEqual(errors, ['MODEL_SWITCH_COMPACTION_FAILED'])
  assert.deepEqual(asked, [['big', 'before']])
  assert.deepEqual(answers, ['answer to before'])
})
