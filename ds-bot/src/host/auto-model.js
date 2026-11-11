// Auto model. A Bot with Auto on (bot.auto) lets a quick judgment (jev.js) pick the model
// for each message the user sends to its own chat, among the models the user wrote a
// "when to use it" note for (prefs.modelNotes). The Bot's own model stays its start and
// its fallback; a pick lives in the Session's selection and in appliedModel, so a build
// without Auto puts the Bot back on its own model at its next start.
//
// DSH reads a step's model before agent/pre-step runs, and nothing else runs between a
// prompt and its first step. So the pick is asked in the first step of a turn that woke
// an idle Session; a pick that changes the model hands that step's input back to the
// inbox and ends the turn before any model call, and the next turn runs on the pick.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { linesFor } from './steward.js'
import { estimateTokens, splitRef } from './text.js'

// The confidence a pick needs before the Session moves: a move adds a model-change
// notice and loses the provider's prompt cache. Tuned from model-audit.jsonl.
export const AUTO_MIN_CONFIDENCE = 0.6
const MESSAGE_CHARS = 2000
const STAY_NOTE = 'The model in use now.'

const textOf = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const hasImage = message => (message.content ?? []).some(block => block.type === 'image')
const refOf = selection => (selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : undefined)

export function install(rt) {
  const { ctx, home, state } = rt
  const auditPath = join(home, 'model-audit.jsonl')
  let writing = Promise.resolve()

  // One line per judgment asked; no message text.
  function audit(entry) {
    if (rt.readOnly?.() !== undefined) return
    const line = `${JSON.stringify({ time: Date.now(), ...entry })}\n`
    writing = writing.then(async () => {
      await mkdir(home, { recursive: true })
      await appendFile(auditPath, line, 'utf8')
    }).catch(error => rt.warn('ds-bot: model audit line not kept: %s', error?.message ?? error))
  }

  // A Bot's own chat whose driver just woke from idle: its next step opens a turn that
  // a new message started, not one queued behind a running turn.
  const woke = new Set()
  // A chat held so its turn starts on the pick: that next turn is not asked about again.
  const decided = new Set()
  // A chat whose turn was ended for a pick, waiting to be woken on it.
  const rewake = new Set()
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running' && rt.chatOwners.has(agent?.id)) woke.add(agent.id)
    else woke.delete(agent?.id)
    if (status !== 'idle' || !rewake.delete(agent?.id)) return
    // After the loop has left its turn, as images.js does on idle.
    setImmediate(() => {
      try { rt.wakeInput(agent) } catch (error) { rt.warn('ds-bot: %s kept its input after a model pick but was not woken: %s', rt.botOf(rt.chatOwners.get(agent.id))?.name ?? agent.id, error?.message ?? error) }
    })
  })

  // Code decides first: only noted, keyed DSH models (never a local agent, so the pick
  // never crosses run modes), only vision models for an image, and only windows that
  // hold the conversation as it stands below DS Bot's hard line, so a pick never forces
  // a compaction.
  async function candidatesFor(agent, messages, image) {
    const notes = state.prefs?.modelNotes ?? {}
    const tokens = (rt.sessionTokens?.(agent.session) ?? 0) + estimateTokens(messages.map(textOf).join('\n'))
    const found = []
    for (const entry of await rt.catalog()) {
      if (!Object.hasOwn(notes, entry.ref) || entry.needsKey === true || rt.isLocalAgentRef?.(entry.ref) === true) continue
      const { provider, model } = splitRef(entry.ref)
      const info = await ctx.llm.resolveModelInfo(provider, model).catch(() => undefined)
      if (info === undefined) continue
      if (image && !(info.inputModalities ?? entry.input ?? []).includes('image')) continue
      if (tokens >= linesFor({ window: info.context?.contextWindow, reserve: info.defaultMaxTokens }).hard) continue
      found.push({ ref: entry.ref, name: entry.name, note: notes[entry.ref] })
    }
    return found
  }

  // The model the next turn should run on, or why the Session stays where it is.
  async function judge(bot, agent, current, messages) {
    const image = messages.some(hasImage)
    const candidates = await candidatesFor(agent, messages, image)
    if (candidates.length < 2) return undefined
    const criteria = Object.fromEntries(candidates.map(entry => [entry.ref, `${entry.name}: ${entry.note}`]))
    criteria[current] ??= STAY_NOTE
    const answers = await rt.decide({
      message: messages.map(textOf).join('\n\n').slice(0, MESSAGE_CHARS),
      bot_role: bot.role || '(none)',
      current_model: current,
      has_image: image,
    }, {
      model: {
        type: 'choice',
        instructions: 'Which model should answer `message`, the user\'s latest message to an assistant whose role is `bot_role`? `current_model` is in use now, and a switch costs time and money, so choose `current_model` unless another model\'s description clearly fits this message better.',
        criteria,
      },
    }, { kind: 'judgment', sessionId: agent.id, botId: bot.id })
    const answer = answers?.model
    if (answer === undefined) return { pick: null, confidence: null, reason: 'no judgment' }
    const confidence = answer.confidence ?? answer.probabilities[answer.choice] ?? 0
    const base = { pick: answer.choice, confidence }
    if (answer.choice === current) return { ...base, reason: 'stays' }
    if (confidence < AUTO_MIN_CONFIDENCE) return { ...base, reason: 'low confidence' }
    return { ...base, apply: true }
  }

  // Selected the way a manual change selects (the user's default is restored after
  // it), with a thinking level the new model has.
  async function select(bot, sessionId, ref) {
    const effort = await rt.desiredEffort(bot, ref)
    await rt.selectSessionModel(sessionId, { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    bot.appliedModel = ref
    if (effort === undefined) delete bot.appliedEffort
    else bot.appliedEffort = effort
    await rt.save()
  }

  // Installed before parts.js, whose own prepend then runs first: a part that moves on
  // takes the step before a pick is asked. This one runs before the listeners that add
  // memory and the clock, so a held step stays empty.
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent } = payload
    const woken = woke.delete(agent.id)
    if (decided.delete(agent.id) || !woken || payload.step !== 1) return next()
    const botId = rt.chatOwners.get(agent.id)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    // ponytail: only a Bot's own chat is picked for. Group Sessions, queued and steering
    // messages, and messages from other Bots keep the model their Session has. Upgrade:
    // ask once per group round for the member that answers, in groups.js.
    if (bot?.auto !== true || bot.private === true || state.prefs?.jev !== true || rt.live?.get(agent.id)?.carried === true) return next()
    const messages = payload.messages ?? []
    if (messages.length === 0 || !messages.every(message => message.source?.kind === 'user')) return next()
    const current = refOf(payload.modelSelection)
    if (current === undefined || rt.isLocalAgentRef?.(current) === true) return next()
    let verdict
    try { verdict = await judge(bot, agent, current, messages) } catch (error) {
      rt.warn('ds-bot: model pick for %s failed: %s', bot.name, error?.message ?? error)
      return next()
    }
    if (verdict === undefined) return next()
    if (verdict.apply === true) {
      try {
        await select(bot, agent.id, verdict.pick)
      } catch (error) {
        verdict = { ...verdict, apply: false, reason: `not selected: ${error?.code ?? error?.name ?? 'error'}` }
      }
    }
    audit({ bot: bot.id, name: bot.name, before: current, pick: verdict.pick, confidence: verdict.confidence, applied: verdict.apply === true, reason: verdict.reason ?? 'picked' })
    if (verdict.apply !== true || payload.signal?.aborted) return next()
    // The step was read on the old model. Its input goes back to the inbox, in order, and
    // the turn ends before any model call (turns.js reads it as a switch); once the
    // Session is idle the input wakes it again, and that turn runs on the pick.
    try {
      rt.restoreInput(agent, messages)
    } catch (error) {
      rt.warn('ds-bot: %s answers on the earlier model; its input could not be held: %s', bot.name, error?.message ?? error)
      return next()
    }
    rt.liveOf(agent.id).switched = true
    decided.add(agent.id)
    rewake.add(agent.id)
    return { kind: 'enter', messages: [] }
  }, { prepend: true })
}
