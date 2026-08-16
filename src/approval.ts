import type { ApprovalContext, ApprovalStatus } from 'eve/tools/approval'
import { createPusharyServer, deterministicKey } from '@pushary/server'

/** Resolves a value from the approval context of a single tool call. */
export type ApprovalResolver<TInput, TValue> = (ctx: ApprovalContext<TInput>) => TValue

/**
 * The request-time policy {@link pusharyApproval} returns. Assignable to eve's
 * `approval:` field, and callable directly so it can be composed or tested.
 */
export type PusharyApprovalPolicy<TInput = Record<string, unknown>> = (
  ctx: ApprovalContext<TInput>,
) => Promise<ApprovalStatus>

export interface PusharyApprovalConfig<TInput = Record<string, unknown>> {
  /** Pushary API key. Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /**
   * The enrolled end-user who decides. A string binds every call to one person; a
   * resolver picks the end-user per call. Defaults to the session principal.
   */
  readonly externalId?: string | ApprovalResolver<TInput, string | undefined>
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long the decision stays answerable. */
  readonly expiresInSeconds?: number
  /** How long to block waiting for an answer before failing closed. */
  readonly timeoutMs?: number
  /**
   * Refuse to open a decision nobody can receive, so an end-user with no connected
   * device is denied at request time instead of silently expiring.
   */
  readonly requireReachable?: boolean
  /** Builds the question the human sees. Defaults to {@link defaultQuestion}. */
  readonly question?: ApprovalResolver<TInput, string>
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

const MAX_INPUT_CHARS = 300

const DENIED_UNANSWERED =
  'No answer from the approver, so this was denied. Do not retry the same action.'
const DENIED_REFUSED = 'The approver denied this action.'

/** Renders `toolName` plus a truncated view of the tool input. */
export const defaultQuestion = <TInput>(ctx: ApprovalContext<TInput>): string => {
  const { toolInput } = ctx
  if (toolInput === undefined || toolInput === null) return `Approve ${ctx.toolName}?`
  const rendered = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
  if (rendered === undefined) return `Approve ${ctx.toolName}?`
  const summary =
    rendered.length > MAX_INPUT_CHARS ? `${rendered.slice(0, MAX_INPUT_CHARS)}...` : rendered
  return `Approve ${ctx.toolName}? ${summary}`
}

/** The configured end-user, else the session principal. Throws when neither exists. */
export const resolveApprovalExternalId = <TInput>(
  config: PusharyApprovalConfig<TInput>,
  ctx: ApprovalContext<TInput>,
): string => {
  const configured =
    typeof config.externalId === 'function' ? config.externalId(ctx) : config.externalId
  const externalId =
    configured ?? ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId
  if (!externalId) {
    throw new Error(
      'Pushary: no end-user to ask. Pass { externalId } to pusharyApproval(), or run ' +
        'user-scoped auth so the session principal is your end-user.',
    )
  }
  return externalId
}

const requireApiKey = (apiKey: string | undefined): string => {
  const resolved = apiKey ?? process.env.PUSHARY_API_KEY
  if (!resolved) {
    throw new Error('Pushary: set PUSHARY_API_KEY or pass { apiKey } to pusharyApproval().')
  }
  return resolved
}

/**
 * An eve approval gate that asks a real person on their phone before the tool runs.
 *
 * The runtime evaluates this before `execute`, so unlike a model-callable ask tool
 * the model cannot route around it. Fails closed: anything short of an explicit yes
 * denies.
 *
 * ```ts
 * // agent/tools/issue-refund.ts
 * export default defineTool({
 *   name: 'issue_refund',
 *   inputSchema: z.object({ amount: z.number() }),
 *   approval: pusharyApproval({ externalId: (ctx) => ctx.session.auth.current?.principalId }),
 *   execute: async ({ amount }) => refund(amount),
 * })
 * ```
 */
export const pusharyApproval = <TInput = Record<string, unknown>>(
  config: PusharyApprovalConfig<TInput> = {},
): PusharyApprovalPolicy<TInput> => {
  const client = createPusharyServer({
    apiKey: requireApiKey(config.apiKey),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  })
  const buildQuestion = config.question ?? defaultQuestion

  return async (ctx: ApprovalContext<TInput>): Promise<ApprovalStatus> => {
    const result = await client.decisions.ask({
      question: buildQuestion(ctx),
      type: 'confirm',
      externalId: resolveApprovalExternalId(config, ctx),
      ...(config.agentName ? { agentName: config.agentName } : {}),
      ...(config.expiresInSeconds ? { expiresInSeconds: config.expiresInSeconds } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.requireReachable ? { requireReachable: config.requireReachable } : {}),
      idempotencyKey: deterministicKey([ctx.session.id, ctx.callId, ctx.toolName]),
    })

    if (result.approved) return { type: 'approved' }
    return { type: 'denied', reason: result.answered ? DENIED_REFUSED : DENIED_UNANSWERED }
  }
}
