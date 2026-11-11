// Quick judgments from TypeSafe's Jev: one HTTP call with a `state` and a few typed
// questions returns a choice with probabilities, or the probability of a yes, in about
// 200 ms. `rt.decide` is the only way in. It never throws and never rejects: every
// failure resolves to null, which each caller turns into its own safe default.
//
// Nothing is sent unless the team switch is on (prefs.jev) and a key is set. The key
// lives in DSH's credential store as TYPESAFE_API_KEY (or comes from that environment
// variable) and is read per call; it never reaches the client, a log or the ledger.
import { checkKey } from './providers.js'

// A versioned id, not the moving `jev-latest` alias: the pick threshold is tuned against it.
export const JEV_MODEL = 'jev-1.14.0'
const BASE_URL = 'https://api.typesafe.ai'
const KEY_REF = 'TYPESAFE_API_KEY'
const TIMEOUT_MS = 1500
const MAX_BYTES = 64_000
// How far a choice's probabilities may sum from 1, as OpenMausBot's parser allows.
const PROBABILITY_SLACK = 0.1

const isProbability = value => typeof value === 'number' && value >= 0 && value <= 1
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// The answers to `questions` in `body`, or undefined when the body is not exactly the
// shape asked for: every question answered with its own type, a choice one that was
// offered, every number a probability, a choice's probabilities a distribution over its options.
export function parseAnswers(body, questions) {
  if (!isObject(body) || !isObject(body.answers) || !isObject(body.usage)) return undefined
  if (!Number.isSafeInteger(body.usage.input_tokens) || body.usage.input_tokens < 0) return undefined
  const ids = Object.keys(questions)
  if (Object.keys(body.answers).some(id => !Object.hasOwn(questions, id))) return undefined
  const answers = {}
  for (const id of ids) {
    const question = questions[id]
    const answer = body.answers[id]
    if (!isObject(answer) || answer.type !== question.type) return undefined
    if (question.type === 'noul') {
      if (!isProbability(answer.noul)) return undefined
      answers[id] = { type: 'noul', noul: answer.noul }
      continue
    }
    const options = Object.keys(question.criteria)
    const probabilities = answer.probabilities
    if (typeof answer.choice !== 'string' || !options.includes(answer.choice)) return undefined
    if (!isObject(probabilities) || Object.entries(probabilities).some(([option, p]) => !options.includes(option) || !isProbability(p))) return undefined
    // A distribution: every offered option has a probability and they sum to 1, within
    // PROBABILITY_SLACK for rounding.
    if (options.some(option => !Object.hasOwn(probabilities, option))) return undefined
    if (Math.abs(options.reduce((sum, option) => sum + probabilities[option], 0) - 1) > PROBABILITY_SLACK) return undefined
    if (answer.confidence !== undefined && answer.confidence !== null && !isProbability(answer.confidence)) return undefined
    answers[id] = { type: 'choice', choice: answer.choice, probabilities: { ...probabilities }, ...(isProbability(answer.confidence) ? { confidence: answer.confidence } : {}) }
  }
  return { answers, model: typeof body.model === 'string' && body.model !== '' ? body.model : JEV_MODEL, inputTokens: body.usage.input_tokens }
}

// Only choice and noul are asked here; a choice needs at least two named options.
const validQuestions = questions => isObject(questions) && Object.keys(questions).length > 0 && Object.values(questions).every(question =>
  isObject(question) && (question.type === 'noul' || (question.type === 'choice' && isObject(question.criteria) && Object.keys(question.criteria).length >= 2)))

// The body, read up to MAX_BYTES; undefined past it.
async function readCapped(response) {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function install(rt) {
  const { ctx, state } = rt
  const credentials = () => ctx.get?.('credentials')

  // The key, read per call as DSH asks; the environment variable when no store is mounted.
  async function key() {
    const store = credentials()
    if (store === undefined) return process.env[KEY_REF] || undefined
    try { return (await store.resolve(KEY_REF))?.value || undefined } catch { return undefined }
  }

  // What the client may know: whether a key is set, and whether Settings can change it.
  let keyInfo = { set: false, writable: false }
  async function refreshKey() {
    const store = credentials()
    if (store === undefined) {
      keyInfo = { set: Boolean(process.env[KEY_REF]), writable: false }
      return keyInfo
    }
    try {
      const info = await store.describe(KEY_REF)
      keyInfo = { set: info?.configured === true, writable: info?.writable !== false }
    } catch {
      keyInfo = { set: false, writable: false }
    }
    return keyInfo
  }
  void refreshKey()
  ctx.on?.('credentials/reference-updated', (ref) => { if (String(ref) === KEY_REF) void refreshKey() })

  // `value` null removes the key that Settings stored; an environment variable stays.
  async function setJevKey(value) {
    const store = credentials()
    if (store === undefined) throw Object.assign(new Error('This DSH cannot store keys; set TYPESAFE_API_KEY in the environment'), { code: 'bot/invalid' })
    if (value === null) await store.unset(KEY_REF)
    else await store.set(KEY_REF, checkKey(value))
    return refreshKey()
  }

  let warnedNoKey = false
  const fail = (kind, reason) => {
    rt.warn('ds-bot: judgment (%s) not used: %s', kind, reason)
    return null
  }

  // `state` and `questions` as TypeSafe takes them. Resolves to the parsed answers keyed
  // by question id, or null: switch off, no key, a private Bot (`botId`), a timeout, a
  // network error, a non-2xx, a body over the cap, or a body of another shape.
  async function decide(judged, questions, { timeoutMs = TIMEOUT_MS, kind = 'judgment', sessionId, botId } = {}) {
    try {
      if (state.prefs?.jev !== true) return null
      // A private Bot's content is not shared without the user (privacy.js).
      if (botId !== undefined && rt.botOf(botId)?.private === true) return null
      if (!validQuestions(questions)) return fail(kind, 'questions of a type this client does not ask')
      const secret = await key()
      if (secret === undefined) {
        if (!warnedNoKey) { warnedNoKey = true; rt.warn('ds-bot: quick judgments are on but no TypeSafe key is set') }
        return null
      }
      const base = (process.env.TYPESAFE_BASE_URL || BASE_URL).replace(/\/+$/, '')
      let response
      try {
        response = await fetch(`${base}/v1/systemone`, {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ model: JEV_MODEL, state: judged, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        return fail(kind, error?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : 'network error')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return fail(kind, `HTTP ${response.status}`)
      }
      let text
      try { text = await readCapped(response) } catch (error) {
        return fail(kind, error?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : 'network error')
      }
      if (text === undefined) return fail(kind, `answer over ${MAX_BYTES} bytes`)
      let body
      try { body = JSON.parse(text) } catch { return fail(kind, 'answer is not JSON') }
      const parsed = parseAnswers(body, questions)
      if (parsed === undefined) return fail(kind, 'answer of an unexpected shape')
      rt.recordUsage?.({ sessionId, kind, provider: 'typesafe', model: parsed.model, usage: { inputTokens: parsed.inputTokens } })
      return parsed.answers
    } catch (error) {
      return fail(kind, error?.name ?? 'error')
    }
  }

  Object.assign(rt, { decide, setJevKey, jevKey: () => keyInfo })
}
