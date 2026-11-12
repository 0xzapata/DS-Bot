// Background checkpoints for a Bot's own chat. Once the steward says "compact", the
// checkpoint is written while the Bot is idle, from the same prefix as its last request,
// and held here in memory. Nothing is written to the
// Session until the next step of a turn applies it, with no model call, in place of the
// idle maintenance pass that held the owner's next message back. A draft that no longer
// matches its Session is dropped, and the part makes room the way it always did.
import { isDeepStrictEqual } from 'node:util'

// A checkpoint that leaves the part above this share of its check line is not used:
// another cycle would start at once.
const AFTER_SHARE = 0.75
// Draft requests per checkpoint cycle (from the part's start or its last checkpoint to
// its next one). A draft that is dropped unused or whose apply fails spends the rest:
// the part's next checkpoint is made the way it was before drafts.
const REQUESTS_MAX = 2
const DRAFT_TIMEOUT_MS = 600_000

// What the backend's summary hook will be given for a span: the system head on surface
// node 0, then the span's own messages, and the tools of the last request
// (dsh-compaction-basic buildSummarizationInput).
export function summaryInput(session, seqs) {
  const head = session.eventAt(session.surface.nodes[0])
  const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null
  const messages = seqs.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(message => message !== null)
  const tools = session.requestHeader()?.tools
  return { ...(tools === undefined ? {} : { tools }), messages: system === null ? messages : [system, ...messages] }
}

// The tokens of the nodes in `seqs` that DSH puts back at the next step once a checkpoint
// condenses them, so they are never freed: the latest runtime-context snapshot
// (dsh-agent-loop RuntimeContextProjection), skill catalog (dsh-tool-skill catalogHistory)
// and instruction-file baseline (dsh-agent-instructions visibleBaselineSource) on the
// surface, each put back when none is left there.
const comesBack = source => source?.kind === 'runtime-context' || source?.kind === 'skill-catalog' || (source?.kind === 'agent-instructions' && source.baseline === true)
export function returning(session, measured, seqs) {
  const latest = new Map()
  for (const node of measured?.nodes ?? []) {
    const source = session.eventAt(node.seq)?.data?.source
    if (comesBack(source)) latest.set(source.kind, node)
  }
  return [...latest.values()].filter(node => seqs.includes(node.seq)).reduce((total, node) => total + node.tokens, 0)
}

// The span a checkpoint would condense now: every surface node after the system head up
// to the one before the last answer, which stays.
export function spanOf(session) {
  const nodes = session.surface.nodes
  const first = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  const last = nodes.findLastIndex(seq => session.eventAt(seq)?.type === 'assistant/message')
  if (last - first < 1) return undefined
  const seqs = nodes.slice(first, last)
  return { seqs, generation: session.surface.replaceGeneration, input: summaryInput(session, seqs) }
}

// `write(input, agent, signal)`: the checkpoint for `input` (parts.js
// writeCheckpoint). `current(agent)`: the part is still its Bot's current own chat and
// no switch runs. `measure(session)` prices the Session, `size(text)` one message.
export function createDrafts({ rt, write, current, measure, size }) {
  /** @type {Map<string, {seqs:number[], generation:number, input:any, abort:AbortController, result?:any}>} */
  const drafts = new Map()
  const requests = new Map()
  // The summary of a part's last draft dropped as too large, or of a checkpoint made since
  // without a draft: no draft at "compact" while it would not fit the span it takes.
  const tooBig = new Map()
  // The draft whose summary the hook hands over during an apply, per Session.
  const applying = new Map()
  let closed = false

  // The span is still on the surface as it was drafted: same replacement generation,
  // same nodes in a row, same messages (a pruned or offloaded node reads differently).
  function matches(session, entry) {
    if (session.surface.replaceGeneration !== entry.generation) return false
    const nodes = session.surface.nodes
    const at = nodes.indexOf(entry.seqs[0])
    if (at === -1 || !isDeepStrictEqual(nodes.slice(at, at + entry.seqs.length), entry.seqs)) return false
    return isDeepStrictEqual(summaryInput(session, entry.seqs), entry.input)
  }

  // The context size at the step after the checkpoint replaces the span.
  function after(session, entry) {
    const measured = measure(session)
    const at = measured?.nodes?.findIndex(node => node.seq === entry.seqs[0]) ?? -1
    if (at === -1 || measured.totalTokens === undefined) return Infinity
    const span = measured.nodes.slice(at, at + entry.seqs.length).reduce((total, node) => total + node.tokens, 0)
    return measured.totalTokens - span + returning(session, measured, entry.seqs) + size(entry.result.summary.map(block => block.text).join('\n'))
  }

  // Whether the written draft still matches and fits under `lines`. One that does
  // not is dropped, and the part drafts no more this cycle.
  function fits(agent, lines) {
    const entry = drafts.get(agent.id)
    if (entry?.result === undefined) return false
    const same = lines !== undefined && matches(agent.session, entry)
    if (same && after(agent.session, entry) <= AFTER_SHARE * lines.check) return true
    if (same) tooBig.set(agent.id, entry.result)
    drop(agent.id)
    requests.set(agent.id, REQUESTS_MAX)
    return false
  }

  // The steward said "compact": the part's draft is written now, for the next step. True
  // once it is written and fits under `lines`.
  async function compact(agent, lines) {
    const id = agent.id
    const span = spanOf(agent.session)
    if (closed || (requests.get(id) ?? 0) >= REQUESTS_MAX || span === undefined) return false
    // Predicts from the part's latest summary too large or made without a draft.
    const big = tooBig.get(id)
    if (big !== undefined && after(agent.session, { seqs: span.seqs, result: big }) > AFTER_SHARE * lines.check) return false
    requests.set(id, (requests.get(id) ?? 0) + 1)
    const entry = { ...span, abort: new AbortController() }
    drafts.set(id, entry)
    try {
      entry.result = await write(span.input, agent, AbortSignal.any([entry.abort.signal, AbortSignal.timeout(DRAFT_TIMEOUT_MS)]))
    } catch (error) {
      if (drafts.get(id) !== entry) return false
      drafts.delete(id)
      rt.warn('ds-bot: background checkpoint for %s failed: %s', id, error?.message ?? error)
      return false
    }
    // Read live: the part may have moved on, been dropped, or changed meanwhile.
    if (drafts.get(id) !== entry) return false
    if (!current(agent)) {
      drafts.delete(id)
      return false
    }
    return fits(agent, lines)
  }

  // Takes the draft for this step, synchronously checked under `lines`: once taken
  // it is gone, so it is applied at most once.
  function take(agent, lines) {
    if (!fits(agent, lines)) return undefined
    const entry = drafts.get(agent.id)
    drafts.delete(agent.id)
    return entry
  }

  // Runs `region` (the engine's compactRegion) with the summary hook answering from `entry`.
  async function apply(agent, entry, region) {
    applying.set(agent.id, entry)
    try {
      const result = await region(entry.seqs[0], entry.seqs.at(-1))
      requests.delete(agent.id)
      tooBig.delete(agent.id)
      return result
    } catch (error) {
      requests.set(agent.id, REQUESTS_MAX)
      throw error
    } finally {
      applying.delete(agent.id)
    }
  }

  // The summary hook during an apply: the held summary, returned with no await, and only
  // for the input it was written from. Undefined when no apply runs for this Session.
  function summary(sessionId, input) {
    const entry = applying.get(sessionId)
    if (entry === undefined) return undefined
    if (!isDeepStrictEqual(input, entry.input)) throw new Error('the background checkpoint no longer matches the conversation')
    return entry.result
  }

  function drop(sessionId) {
    const entry = drafts.get(sessionId)
    if (entry === undefined) return
    drafts.delete(sessionId)
    // A request cut off unfinished (a switch, /new, a stopped Session) is not spent.
    if (entry.result === undefined) requests.set(sessionId, (requests.get(sessionId) ?? 1) - 1)
    entry.abort.abort(new Error('the background checkpoint was dropped'))
  }

  return {
    compact,
    take,
    fits,
    apply,
    summary,
    drop,
    marked: sessionId => drafts.has(sessionId),
    // A new cycle: a checkpoint made another way, or a part that becomes current again.
    // `fresh`: the part becomes current again, and its size mark goes too. `result`: the
    // checkpoint made another way; a size mark follows its summary.
    succeeded: (sessionId, fresh = false, result = undefined) => {
      requests.delete(sessionId)
      if (fresh) tooBig.delete(sessionId)
      else if (result?.summary !== undefined && tooBig.has(sessionId)) tooBig.set(sessionId, result)
    },
    closed: () => closed,
    dispose() {
      closed = true
      tooBig.clear()
      for (const sessionId of drafts.keys()) drop(sessionId)
    },
  }
}
