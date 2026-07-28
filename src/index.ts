import { defineTool } from 'eve/tools'
import { createPusharyServer, type AskResult, type DecisionType } from '@pushary/server'

export {
  pusharyChannel,
  channelExternalId,
  decisionTypeFor,
  optionIdForAnswer,
  signRouting,
  openDecisions,
  type PusharyChannelConfig,
  type InputRequest,
} from './channel'

export interface PusharyEveConfig {
  /** Your Pushary API key. Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /**
   * The enrolled end-user who should answer. If omitted, the session principal
   * is used (run user-scoped auth so each end-user is their own principal).
   */
  readonly externalId?: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long each ask blocks before returning (default 55s, serverless-safe). */
  readonly timeoutMs?: number
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

interface AskInput {
  readonly question: string
  readonly type?: DecisionType
  readonly options?: readonly string[]
}

const resolveApiKey = (config: PusharyEveConfig): string => {
  const key = config.apiKey ?? process.env.PUSHARY_API_KEY
  if (!key) {
    throw new Error('Pushary: set PUSHARY_API_KEY or pass { apiKey } to the tool factory.')
  }
  return key
}

/**
 * The end-user who should answer: an explicit `config.externalId` wins, else the
 * session principal. App-scoped/shared sessions have no per-user principal, so we
 * throw rather than silently ask the wrong person.
 */
export const pickExternalId = (
  config: PusharyEveConfig,
  sessionPrincipalId: string | undefined,
): string => {
  const id = config.externalId ?? sessionPrincipalId
  if (!id) {
    throw new Error(
      'Pushary: no end-user to ask. Pass { externalId } to the tool factory, or run ' +
        'user-scoped auth so the session principal is your end-user.',
    )
  }
  return id
}

/** Turn a decision outcome into an unambiguous instruction for the model. */
export const answerToModelText = (type: DecisionType, result: AskResult): string => {
  if (!result.answered) {
    return `No answer (status: ${result.status}). Treat this as NOT approved and do not proceed.`
  }
  if (type === 'confirm') {
    return result.approved ? 'The human approved. You may proceed.' : 'The human declined. Do not proceed.'
  }
  return `The human answered: ${result.value ?? ''}`
}

// Plain JSON Schema (Eve accepts a JsonObject for inputSchema) so this package
// carries no schema-library dependency and stays compatible across Eve versions.
const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The exact question to put to the human.' },
    type: {
      type: 'string',
      enum: ['confirm', 'select', 'input'],
      default: 'confirm',
      description: 'confirm = yes/no, select = pick an option, input = free text.',
    },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: 'The choices, for a select question.',
    },
  },
  required: ['question'],
  additionalProperties: false,
}

// Deliberately empty: the end-user to connect is NEVER taken from model input,
// only from config.externalId or the session principal (same identity rule as the
// ask tool). Letting the model choose the externalId would let one end-user mint an
// enroll link that binds their phone to another user's identity. Cross-user
// enrollment belongs in the partner's backend via @pushary/server.enroll().
const CONNECT_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const sessionPrincipal = (ctx: {
  readonly session: { readonly auth: { readonly current: { readonly principalId: string } | null; readonly initiator: { readonly principalId: string } | null } }
}): string | undefined =>
  ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId ?? undefined

/**
 * An Eve tool that asks a real human to approve/choose/answer on their phone and
 * blocks until they reply. Drop it into a tool file:
 *
 * ```ts
 * // agent/tools/ask-human.ts
 * import { pusharyAskHuman } from '@pushary/eve'
 * export default pusharyAskHuman()
 * ```
 */
export const pusharyAskHuman = (config: PusharyEveConfig = {}) =>
  defineTool({
    description:
      'Ask a real human to approve, choose, or answer. Delivered to their phone and answered from the lock screen. Blocks until they reply. Use before any risky or irreversible action (spending money, deleting data, sending an external message) or when you need a human decision.',
    inputSchema: ASK_INPUT_SCHEMA,
    async execute(input, ctx) {
      // Eve validates `input` against inputSchema before calling execute.
      const { question, type = 'confirm', options } = input as unknown as AskInput
      const client = createPusharyServer({ apiKey: resolveApiKey(config), baseUrl: config.baseUrl })
      const externalId = pickExternalId(config, sessionPrincipal(ctx))
      const result = await client.decisions.ask({
        question,
        type,
        options,
        externalId,
        agentName: config.agentName,
        timeoutMs: config.timeoutMs,
      })
      return answerToModelText(type, result)
    },
  })

/**
 * An Eve tool that returns a one-tap link the end-user opens to connect their
 * phone for approvals. Drop it into a tool file:
 *
 * ```ts
 * // agent/tools/connect-phone.ts
 * import { pusharyConnectPhone } from '@pushary/eve'
 * export default pusharyConnectPhone()
 * ```
 */
export const pusharyConnectPhone = (config: PusharyEveConfig = {}) =>
  defineTool({
    description:
      'Get a one-tap link the user opens on their phone to turn on approvals. Use this if asking a human fails because they have not connected a device yet.',
    inputSchema: CONNECT_INPUT_SCHEMA,
    async execute(_input, ctx) {
      const client = createPusharyServer({ apiKey: resolveApiKey(config), baseUrl: config.baseUrl })
      const id = pickExternalId(config, sessionPrincipal(ctx))
      const { universalLink } = await client.enroll(id)
      return `Ask the user to open this link on their phone to turn on approvals: ${universalLink}`
    },
  })
