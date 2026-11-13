// Code mode on DSH's real agent loop with the PTC executor and the real Node PTC runtime:
// the model calls only run_code, and a program's tool calls pass through DS Bot's own
// guards and privacy checks like direct calls. Programs here only call tools: no network,
// no files outside the test's folder, no processes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import { createRuntime } from '../index.js'
import { output } from '../src/host/tools.js'

const P = 'code'
const textOf = message => (message?.content ?? []).map(block => block.text ?? '').join('')

// Writer ('w') is a member on code mode; Chief is the Main Bot; Vault is private with a
// folder of its own. `program` is the code the model's first step runs, or a function of
// Vault's folder that returns it.
async function boot(t, program) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-code-loop-')))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const home = join(root, 'home')
  const vault = join(root, 'vault')
  mkdirSync(home)
  mkdirSync(vault)
  const code = typeof program === 'function' ? program(vault) : program
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['chief'], revision: 1, whaleStored: true, exchanges: [], exchangeTurns: {}, questions: {}, rooms: {},
    bots: {
      chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
      w: { id: 'w', sessionId: 'w', name: 'Writer', role: 'Writes', instructions: '', createdAt: 2, codeMode: true },
      v: { id: 'v', sessionId: 'v', name: 'Vault', role: 'Keeps', instructions: '', createdAt: 3, private: true, workDir: vault },
    },
  }))
  const ctx = new Context()
  await ctx.plugin(FsLocal)
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' }, workingDirectory: true })
  await ctx.plugin(NodePtc, {})
  const requests = []
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100_000 } } }
    async listModels() { return [{ id: 'm', name: 'M' }] }
    async *stream(options) {
      requests.push(options)
      if (requests.length === 1) {
        const block = { type: 'tool-call', id: 'c1', name: 'run_code', arguments: JSON.stringify({ description: 'Test program', code }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([P], new Model())
  // A global tool DS Bot hides from Bots, and a file tool the privacy check reads.
  const ran = []
  ctx.tools.register(defineTool({ name: 'ask_user_question', description: 'Ask and wait', parameters: {}, output, async execute() { ran.push('ask_user_question'); return 'asked' } }))
  ctx.tools.register(defineTool({ name: 'read', description: 'Read a file', parameters: { file_path: { type: 'string', required: true } }, output, async execute(args) { ran.push(`read ${args.file_path}`); return 'contents' } }))
  // The plugin's own context, with the DSH services the Session side does not run here.
  const plugin = ctx.extend()
  Object.assign(plugin, {
    connection: { fetch: { register: () => () => {} } },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {}, list: () => [] },
    sessionController: { create: async () => ({ sessionId: 'unused' }), resolveAgent: async id => ({ agent: ctx.agents.get(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }), inspect: async () => ({ events: [] }) },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(plugin, { home, github: false, diagnosticsFile: false })
  rt.warn = () => {}
  await rt.load()
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('w'), { provider: P, model: 'm', cwd: root })
  t.after(() => ctx.fiber.dispose())
  const run = async (source = { kind: 'user' }) => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source }))
    const end = Date.now() + 20_000
    while (Date.now() < end && !(agent.status === 'idle' && agent.session.snapshotEvents().some(event => event.type === 'turn/end'))) await new Promise(resolve => setTimeout(resolve, 20))
    return textOf(agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')?.data.message)
  }
  return { rt, agent, requests, ran, run, vault }
}

test('the model sees only run_code; a program calls a team tool and its result comes back', async (t) => {
  const env = await boot(t, 'console.log(await tools.list_bots({}))')
  const result = await env.run()
  assert.deepEqual(env.requests[0].tools.map(tool => tool.name), ['run_code'])
  assert.match(result, /- Writer \(Writes, you\)/)
  // The catalog names the team tools and not the hidden ones.
  const system = textOf(env.requests[0].messages[0])
  assert.match(system, /list_bots/)
  assert.match(system, /message_bot/)
  assert.doesNotMatch(system, /ask_user_question/)
  const from = system.indexOf('`run_code` is the only tool')
  const sdk = system.slice(from, system.indexOf('\n```', system.indexOf('```ts', from) + 5) + 4)
  t.diagnostic(`system ${system.length} chars; run_code instructions and tool catalog ${sdk.length} chars; run_code schema ${JSON.stringify(env.requests[0].tools[0]).length} chars`)
})

test('the role guard refuses a gated tool called from a program', async (t) => {
  const env = await boot(t, 'try { await tools.create_bot({ name: "Zed" }) } catch (error) { console.log("refused:", error.message) }')
  assert.match(await env.run(), /refused: Refused by DS Bot: create_bot needs a Main Bot, and you are a member/)
  assert.equal(env.rt.findBot('Zed'), undefined)
})

test('a hidden tool cannot be called from a program', async (t) => {
  const env = await boot(t, 'try { await tools.ask_user_question({}) } catch (error) { console.log("refused:", error.message) }')
  const result = await env.run()
  t.diagnostic(result)
  assert.match(result, /refused: .*(not a function|ask_user_question)/)
  assert.deepEqual(env.ran, [])
})

test('the privacy check refuses a program\'s read of a private Bot\'s folder', async (t) => {
  const env = await boot(t, vault => `try { await tools.read({ file_path: ${JSON.stringify(join(vault, 'notes.md'))} }) } catch (error) { console.log("refused:", error.message) }`)
  assert.match(await env.run(), /refused: Vault is a private Bot, and other Bots cannot reach its files/)
  assert.deepEqual(env.ran, [])
})

test('run_code is refused in a turn another Bot started', async (t) => {
  const env = await boot(t, 'console.log(await tools.list_bots({}))')
  const result = await env.run({ kind: 'bot', role: 'request', form: 'relay', senderSessionId: 'chief', exchangeId: 'x1' })
  assert.match(result, /runs only in a turn the user's own message started/)
})
