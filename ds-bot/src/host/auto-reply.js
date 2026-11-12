// Auto reply mode. In a group whose mode is `auto`, a message the rules (an @mention,
// "@all") leave open asks one quick judgment (jev.js) which members should answer: one
// `noul` per member that may see the message. An owner message is always answered, by
// the members the judgment picks or by the default; a member's reply that called nobody
// is answered only by members the judgment is sure of, and never on a failed judgment.
// groups.js calls this; every check of live state comes after the last await, so the
// caller applies the result at once.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const MESSAGE_CHARS = 2000
const OWNER_BAR = 0.5
const OWNER_MAX = 3
const BOT_MAX = 2
// Turns the judgment may start per owner message, across rounds.
export const AUTO_TURN_CAP = 8
// The bar for the nth Bot-to-Bot hop since the owner wrote: each hop needs more certainty.
export const botBar = hop => Math.min(0.9, 0.6 + 0.1 * (hop - 1))

export function install(rt) {
  const { home, state } = rt
  const auditPath = join(home, 'reply-audit.jsonl')
  let writing = Promise.resolve()

  // One line per decision; no message text.
  function audit(entry) {
    if (rt.readOnly?.() !== undefined) return
    const line = `${JSON.stringify({ time: Date.now(), ...entry })}\n`
    writing = writing.then(async () => {
      await mkdir(home, { recursive: true })
      await appendFile(auditPath, line, 'utf8')
    }).catch(error => rt.warn('ds-bot: reply audit line not kept: %s', error?.message ?? error))
  }

  // Who answers an owner message the judgment did not settle: the admin, else a Main Bot
  // member, else every member in turn, admin first. A group moved to `everyone` while
  // Jev judged answers as `everyone`.
  const ownerDefault = (room) => {
    const members = room.members.filter(id => rt.botOf(id) !== undefined)
    const admin = members.find(id => rt.isAdminOf(room, id))
    const everyone = admin === undefined ? members : [admin, ...members.filter(id => id !== admin)]
    if (room.mode === 'everyone') return everyone
    if (admin !== undefined) return [admin]
    const main = members.find(id => rt.isMain(id))
    return main !== undefined ? [main] : everyone
  }

  // `fromBotId`: the member whose reply this is; none for the owner's message. `hop`: how
  // many calls that reply is from the owner's message, 1 for a member the owner called.
  // `after`: a promise to wait for before the checks, so owner messages apply in their order.
  // `busy(id)`: a member already answering, skipped for a Bot's message. `apply(ids)`
  // calls the members in the same synchronous step as the pick, so no other judgment
  // runs between them. Resolves to { ids, reason }: the members to call, in order.
  async function autoRepliers(given, { text, fromBotId, hop = 1, signal, after, busy = () => false, apply }) {
    // The store can replace a room record; the caller's may be from before an await.
    const room = rt.roomOf(given.id) ?? given
    const owner = fromBotId === undefined
    const epoch = room.autoEpoch
    const base = { room: room.id, from: fromBotId ?? 'user' }
    const done = (ids, reason, extra = {}) => {
      audit({ ...base, hop: extra.hop ?? 0, p: extra.p ?? {}, picked: ids, reason })
      if (ids.length > 0) apply?.(ids)
      return { ids, reason }
    }
    const fallback = (reason, live = room) => (owner ? done(ownerDefault(live), reason) : done([], reason))
    if (!owner && rt.botOf(fromBotId)?.private === true) return done([], 'private')
    if (!owner && (room.autoTurns ?? 0) >= AUTO_TURN_CAP) return done([], 'cap')
    const eligible = room.members.map(rt.botOf).filter(bot => bot !== undefined && bot.private !== true && bot.id !== fromBotId)
    if (eligible.length === 0) return fallback('private')
    const questions = Object.fromEntries(eligible.map((bot, index) => [`m${index}`, {
      type: 'noul',
      instructions: `Should ${bot.name} (${bot.role || 'no role'}${rt.isAdminOf(room, bot.id) ? ', the group\'s admin' : ''}) reply to \`message\` in this group chat? Yes only if the message asks for it or it needs this member's role.`,
    }]))
    const judged = { message: String(text ?? '').slice(0, MESSAGE_CHARS), from: owner ? 'user' : rt.botOf(fromBotId)?.name ?? 'a member', group: room.name }
    // A Stop ends the wait at once.
    const stopped = new Promise(resolve => signal?.addEventListener('abort', () => resolve(null), { once: true }))
    const answers = await Promise.race([rt.decide(judged, questions, { kind: 'judgment', sessionId: rt.sessionOfRoom(room), botId: fromBotId }), stopped])
    await after
    // Read live: while Jev judged, the owner may have stopped, written again, changed the
    // mode, the members or the Jev switch, or deleted the group.
    const live = rt.roomOf(room.id)
    if (signal?.aborted || live === undefined) return done([], 'stopped')
    if (!owner && live.autoEpoch !== epoch) return done([], 'stale')
    // Each owner message starts the count of Bot-to-Bot turns again, in message order.
    if (owner) delete live.autoTurns
    // A mode changed away from `auto` is the owner's: the pick is not applied.
    if (live.mode !== 'auto') return fallback('stopped', live)
    if (state.prefs?.jev !== true || answers == null) return fallback('null', live)
    const p = {}
    eligible.forEach((bot, index) => { p[bot.id] = answers[`m${index}`]?.noul ?? 0 })
    const bar = owner ? OWNER_BAR : botBar(hop)
    const ranked = eligible.map(bot => bot.id)
      .filter(id => live.members.includes(id) && rt.botOf(id) !== undefined && p[id] >= bar && (owner || !busy(id)))
      .sort((a, b) => p[b] - p[a])
    if (ranked.length === 0) return owner ? done(ownerDefault(live), 'below', { p }) : done([], 'below', { hop, p })
    if (owner) return done(ranked.slice(0, OWNER_MAX), 'jev', { p })
    // Taken at pick time, not when the judgment started, so two judgments in flight
    // cannot both spend the same turns.
    const left = AUTO_TURN_CAP - (live.autoTurns ?? 0)
    if (left <= 0) return done([], 'cap', { hop, p })
    const ids = ranked.slice(0, Math.min(BOT_MAX, left))
    live.autoTurns = (live.autoTurns ?? 0) + ids.length
    return done(ids, 'jev', { hop, p })
  }

  rt.autoRepliers = autoRepliers
}
