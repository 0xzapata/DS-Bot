// Roles and their rights. A Bot is a Main Bot (state.mainBotIds), the admin of a group
// chat (room.admin), or a member. The host enforces the table below in DSH's tool
// guard, before any tool body runs, so a refusal does not depend on the prompt or on a
// check inside each tool. The tools keep their finer checks (a member may still change
// itself with update_bot), which this table never loosens.
//
// Every call of a gated tool leaves an audit line in <home>/role-audit.jsonl.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const ROLES = ['main', 'admin', 'member']

// The least role that may call each gated tool. `admin` means the admin of the group
// the call is about, or of any group when the call names none. Tools not listed are
// open to every Bot.
export const RIGHTS = {
  create_bot: 'main',
  stop_bot: 'main',
  create_group: 'main',
  delete_group: 'main',
  update_group: 'admin',
}

// What each role may do, for the settings view. Plain words, one line each.
export const RIGHT_LINES = {
  main: ['Create Bots (create_bot)', 'Stop another Bot\'s turn (stop_bot)', 'Create and delete group chats (create_group, delete_group)', 'Change any group chat, its folder and section (update_group)', 'Change another Bot, its memory and capabilities (update_bot)', 'Post into any group chat and start a round (post_to_group)'],
  admin: ['Change its own group chat: name, notice, members, reply mode (update_group)', 'Start a round in its own group chat (post_to_group)'],
  member: ['Message other Bots (message_bot)', 'Change itself (update_bot)', 'Post into a group it is in; only named members answer (post_to_group)'],
}

const rank = role => ROLES.indexOf(role)

export function install(rt) {
  const { ctx, home } = rt
  const auditPath = join(home, 'role-audit.jsonl')
  let writing = Promise.resolve()

  // The role a Bot holds for one call: in the group it names when it names one, else
  // the highest it holds anywhere.
  function roleOf(botId, groupRef) {
    if (rt.isMain(botId)) return 'main'
    // The tools' own lookup, so a name they accept ("Dev" in quotes) is not refused here.
    // A name two groups share passes when the Bot runs either; the tool refuses it.
    const rooms = groupRef !== undefined && groupRef !== '' ? rt.findRooms(groupRef) : Object.values(rt.state.rooms ?? {})
    return rooms.some(room => rt.isAdminOf(room, botId)) ? 'admin' : 'member'
  }

  // Decides one call: undefined when the tool is open to every Bot.
  function decide(botId, tool, args = {}) {
    const needed = RIGHTS[tool]
    if (needed === undefined) return undefined
    const role = roleOf(botId, args.group)
    return { tool, role, needed, allowed: rank(role) <= rank(needed) }
  }

  const neededText = needed => (needed === 'main' ? 'a Main Bot' : 'a Main Bot or the group\'s admin')

  function audit(entry) {
    if (rt.readOnly?.() !== undefined) return
    const line = `${JSON.stringify({ time: Date.now(), ...entry })}\n`
    writing = writing.then(async () => {
      await mkdir(home, { recursive: true })
      await appendFile(auditPath, line, 'utf8')
    }).catch(error => rt.warn('ds-bot: role audit line not kept: %s', error?.message ?? error))
  }

  // Runs after every pre-execute listener and before the tool body, in Bot Sessions only.
  ctx.effect(() => ctx.tools.guard((exec) => {
    const sessionId = exec.agent?.id
    if (!rt.isBotSession?.(sessionId)) return undefined
    const botId = rt.selfOf(sessionId)
    if (botId === undefined) return undefined
    const verdict = decide(botId, exec.name, exec.arguments ?? {})
    if (verdict === undefined) return undefined
    const name = rt.botOf(botId)?.name ?? botId
    audit({ bot: botId, name, ...verdict })
    if (verdict.allowed) {
      ctx.logger.info('ds-bot: role %s: %s called %s', verdict.role, name, verdict.tool)
      return undefined
    }
    rt.warn('ds-bot: role %s: %s was refused %s, which needs %s', verdict.role, name, verdict.tool, verdict.needed)
    return `Refused by DS Bot: ${verdict.tool} needs ${neededText(verdict.needed)}, and you are a ${verdict.role === 'admin' ? 'group admin' : 'member'}. Ask a Main Bot with message_bot instead.`
  }), 'ds-bot: role rights')

  // For the settings view: each role, what it may do, and who holds it now.
  function rolesView() {
    const bots = Object.values(rt.state.bots ?? {})
    const holders = {
      main: bots.filter(bot => rt.isMain(bot.id)).map(bot => bot.id),
      admin: bots.filter(bot => !rt.isMain(bot.id) && Object.values(rt.state.rooms ?? {}).some(room => rt.isAdminOf(room, bot.id))).map(bot => bot.id),
    }
    holders.member = bots.map(bot => bot.id).filter(id => !holders.main.includes(id) && !holders.admin.includes(id))
    return {
      roles: ROLES.map(role => ({ role, rights: RIGHT_LINES[role], bots: holders[role] })),
      gated: Object.entries(RIGHTS).map(([tool, needed]) => ({ tool, needed })),
    }
  }

  Object.assign(rt, { roleOf, roleDecide: decide, rolesView })
}
