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
// The hold is the last thing the listener does and has no await in it: if, at that
// moment, the turn was stopped or anything waits in next-step (which DSH claims ahead
// of held input), nothing is selected or held and the step goes on, on the model it
// has. So no input, whenever it came, is answered before the message held for it.
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
  // A chat held so its turn starts on the pick, with the held input: that next turn is
  // not asked about again.
  const decided = new Map()
  // A chat whose turn was ended for a pick, waiting to be woken on it.
  const rewake = new Map()
  // The restart mark is shared with part switching (parts.js, heldBack): the hold sets
  // its own only where none is, and removes only its own.
  const dropMark = (id) => {
    if (state.switching?.[id]?.pick === true) delete state.switching[id]
  }
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running' && rt.chatOwners.has(agent?.id)) woke.add(agent.id)
    else woke.delete(agent?.id)
    const held = status === 'idle' ? rewake.get(agent?.id) : undefined
    // The held turn was stopped before its first step reached the listener below, which
    // DSH does not run for a step stopped as it is assembled: held input it claimed and
    // dropped stays in the chat, where a Stop in its model call leaves it.
    const unreached = status === 'idle' && held === undefined ? decided.get(agent?.id) : undefined
    if (unreached !== undefined) {
      decided.delete(agent.id)
      const events = agent.session.snapshotEvents()
      // Only a stopped turn: a part switch that took the step carries its input on.
      if (events.findLast(event => event.type === 'turn/end')?.data?.reason?.kind === 'aborted') {
        const pending = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id))
        const said = new Set(events.filter(event => event.type === 'user/message').map(event => event.data.id))
        keep(agent, unreached.filter(message => !pending.has(message.id) && !said.has(message.id)))
      }
    }
    if (held === undefined) return
    rewake.delete(agent.id)
    // Stopped after the hold returned: the stopped turn changes nothing.
    if (held.signal.aborted) {
      decided.delete(agent.id)
      unhold(agent, held.messages, held.before)
      keep(agent, held.messages)
      held.bot.appliedModel = held.appliedModel
      if (held.appliedEffort === undefined) delete held.bot.appliedEffort
      else held.bot.appliedEffort = held.appliedEffort
      dropMark(agent.id)
      rt.save().catch(() => {})
      return
    }
    // After the loop has left its turn, as images.js does on idle.
    setImmediate(() => {
      try {
        wake(agent)
        dropMark(agent.id)
        rt.save().catch(() => {})
      } catch (error) { rt.warn('ds-bot: %s kept its input after a model pick but was not woken: %s', rt.botOf(rt.chatOwners.get(agent.id))?.name ?? agent.id, error?.message ?? error) }
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

  // A stopped step's input stays in the chat, unanswered, where DSH leaves a message
  // whose model call a Stop cuts off; the next request carries it.
  const keep = (agent, messages) => {
    try {
      for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
    } catch (error) { rt.warn('ds-bot: a stopped message of %s was not kept in its chat: %s', rt.botOf(rt.chatOwners.get(agent.id))?.name ?? agent.id, error?.message ?? error) }
  }
  // Wakes the driver on the inbox as it stands. DSH claims as the waking send lands, so
  // only the last waiting message is sent again, in its place: the first step then
  // claims all that waits, and heldFirst puts the held input ahead of it.
  const wake = (agent) => {
    const target = agent.inbox.nextTurn.length > 0 ? 'next-turn' : 'next-step'
    const last = (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep).at(-1)
    if (last === undefined) return
    agent.inbox.remove(last.id)
    agent.send(last, target, true)
  }
  const unhold = (agent, messages, before) => {
    for (const message of messages) agent.inbox.remove(message.id)
    agent.model.select(before)
  }

  // Synchronous. The Session's own model API, not rt.selectSessionModel: that one awaits,
  // and also saves the selection as the user's default, which DS Bot then writes back.
  function hold(agent, payload, { pick, effort }) {
    const settled = () => payload.signal?.aborted !== true && agent.inbox.nextStep.length === 0
    if (!settled()) return false
    try {
      agent.model.select({ ...splitRef(pick), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      rt.restoreInput(agent, payload.messages)
      // Looked at again: these writes ran other listeners, which may have sent or stopped.
      if (settled()) return true
    } catch (error) {
      rt.warn('ds-bot: %s answers on the earlier model; its input could not be held: %s', rt.botOf(rt.chatOwners.get(agent.id))?.name ?? agent.id, error?.message ?? error)
    }
    unhold(agent, payload.messages, payload.modelSelection)
    return false
  }

  // DSH claims next-step before next-turn, so a steer that started the held turn before
  // its wake comes ahead of the held input in the step; the held input goes first.
  function heldFirst(decision, claimed, held) {
    if (decision.kind === 'reject') return decision
    const ids = new Set(claimed.map(message => message.id))
    const order = [...claimed.filter(message => held.has(message.id)), ...claimed.filter(message => !held.has(message.id))]
    let at = 0
    return { ...decision, messages: decision.messages.map(message => (ids.has(message.id) ? order[at++] : message)) }
  }

  // Installed before parts.js, whose own prepend then runs first: a part that moves on
  // takes the step before a pick is asked. This one runs before the listeners that add
  // memory and the clock, so a held step stays empty.
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, signal } = payload
    const woken = woke.delete(agent.id)
    const held = decided.get(agent.id)
    if (held !== undefined) {
      decided.delete(agent.id)
      const decision = await next()
      // The held message would be in its model call by now with Auto off, so a Stop
      // leaves it in the chat as a Stop there does.
      const ids = new Set(held.map(message => message.id))
      if (signal?.aborted) keep(agent, payload.messages.filter(message => ids.has(message.id)))
      return heldFirst(decision, payload.messages, ids)
    }
    if (!woken || payload.step !== 1 || signal?.aborted) return next()
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
    // A Stop ends the wait for Jev at once, as it ends a model call.
    const stopped = new Promise(resolve => signal?.addEventListener('abort', () => resolve({ pick: null, confidence: null, reason: 'stopped' }), { once: true }))
    const judging = judge(bot, agent, current, messages)
    judging.catch(() => {})
    let verdict
    try { verdict = await Promise.race([judging, stopped]) } catch (error) {
      rt.warn('ds-bot: model pick for %s failed: %s', bot.name, error?.message ?? error)
    }
    if (verdict?.apply === true) {
      try { verdict = { ...verdict, effort: await rt.desiredEffort(bot, verdict.pick) } } catch (error) {
        verdict = { ...verdict, apply: false, reason: `not selected: ${error?.code ?? error?.name ?? 'error'}` }
      }
    }
    const applied = verdict?.apply === true && hold(agent, payload, verdict)
    if (verdict !== undefined) audit({ bot: bot.id, name: bot.name, before: current, pick: verdict.pick, confidence: verdict.confidence, applied, reason: applied ? 'picked' : signal?.aborted ? 'stopped' : verdict.apply === true ? 'input arrived' : verdict.reason })
    if (applied) {
      // The step was read on the old model, so it ends before any model call (turns.js
      // reads it as a switch); once the Session is idle the held input wakes it again,
      // and that turn runs on the pick.
      rewake.set(agent.id, { signal, messages, before: payload.modelSelection, bot, appliedModel: bot.appliedModel, appliedEffort: bot.appliedEffort })
      bot.appliedModel = verdict.pick
      if (verdict.effort === undefined) delete bot.appliedEffort
      else bot.appliedEffort = verdict.effort
      rt.liveOf(agent.id).switched = true
      decided.set(agent.id, messages)
      // Saved, so a restart before the wake still wakes the chat (parts.js, heldBack).
      // Input sent or a Stop from here on is the wake's to order or undo (above).
      state.switching ??= {}
      state.switching[agent.id] ??= { botId: bot.id, pick: true }
      await rt.save().catch(() => {})
      return { kind: 'enter', messages: [] }
    }
    if (signal?.aborted) {
      keep(agent, messages)
      return { kind: 'enter', messages: [] }
    }
    return next()
  }, { prepend: true })
}
