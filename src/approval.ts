import type { ApprovalContext, ApprovalStatus } from 'eve/tools/approval'
import { createAdapterKernel, renderApprovalQuestion } from '@pushary/server/adapters'

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

const kernel = createAdapterKernel('pusharyApproval()')

const sessionPrincipal = <TInput>(ctx: ApprovalContext<TInput>): string | undefined =>
  ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId

/** Renders `toolName` plus a truncated view of the tool input. */
export const defaultQuestion = <TInput>(ctx: ApprovalContext<TInput>): string =>
  renderApprovalQuestion(ctx.toolName, ctx.toolInput)

/** The configured end-user, else the session principal. Throws when neither exists. */
export const resolveApprovalExternalId = <TInput>(
  config: PusharyApprovalConfig<TInput>,
  ctx: ApprovalContext<TInput>,
): string => {
  const configured =
    typeof config.externalId === 'function' ? config.externalId(ctx) : config.externalId
  return kernel.requireExternalId(configured ?? sessionPrincipal(ctx))
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
  const gate = kernel.createGate(config)
  const buildQuestion = config.question ?? defaultQuestion

  return async (ctx: ApprovalContext<TInput>): Promise<ApprovalStatus> => {
    const decision = await gate({
      toolName: ctx.toolName,
      callId: ctx.callId,
      sessionId: ctx.session.id,
      question: buildQuestion(ctx),
      externalId: resolveApprovalExternalId(config, ctx),
    })
    return decision.approved ? { type: 'approved' } : { type: 'denied', reason: decision.reason }
  }
}
