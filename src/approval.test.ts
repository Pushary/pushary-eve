import { describe, it, expect, afterEach } from 'vitest'
import type { ApprovalContext } from 'eve/tools/approval'
import { pusharyApproval, defaultQuestion, resolveApprovalExternalId } from './approval'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}
type Responder = (call: Recorded) => { status?: number; json: unknown }

// What POST /authorize answers. The gate asks policy before it asks a person; this
// suite is about the eve binding, so the default verdict is the one that still
// reaches a human.
const REQUIRES_HUMAN = {
  verdict: 'requires_human',
  policy: null,
  reason: 'No policy rule names this action, so a person decides.',
  authorizationId: null,
}
const ALLOWED = {
  verdict: 'allow',
  policy: 'issue_refund',
  reason: 'Allowed by policy rule issue_refund.',
  authorizationId: 'az_1',
}

const realFetch = globalThis.fetch
// The policy hop is answered but not recorded, so `calls` keeps meaning "the
// decisions this adapter opened" and every assertion below reads as it did before
// the gate consulted policy.
const installFetch = (
  responders: readonly Responder[],
  evaluation: unknown = REQUIRES_HUMAN,
): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    if (call.url.endsWith('/authorize')) {
      return { ok: true, status: 200, json: async () => evaluation } as Response
    }
    calls.push(call)
    const responder = responders[Math.min(i, responders.length - 1)]
    i += 1
    const { status = 200, json } = responder(call)
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response
  }) as typeof fetch
  return calls
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const ctx = (
  overrides: {
    principalId?: string | null
    toolName?: string
    toolInput?: unknown
  } = {},
): ApprovalContext<never> =>
  ({
    approvedTools: new Set<string>(),
    callId: 'call_1',
    toolName: overrides.toolName ?? 'issue_refund',
    toolInput: overrides.toolInput,
    session: {
      id: 'sess_1',
      auth: {
        current:
          overrides.principalId === null
            ? null
            : { principalId: overrides.principalId ?? 'user_42' },
        initiator: null,
      },
    },
  }) as unknown as ApprovalContext<never>

const answered = (value: string) => ({
  json: {
    decisionId: 'd1',
    status: 'answered',
    answered: true,
    value,
    type: 'confirm',
  },
})

describe('pusharyApproval', () => {
  it('approves when the human says yes', async () => {
    installFetch([() => answered('yes')])
    const policy = pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })
    expect(await policy(ctx())).toEqual({ type: 'approved' })
  })

  it('approves without opening a decision when a rule allows the call', async () => {
    const calls = installFetch([() => answered('yes')], ALLOWED)
    const result = await pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })(ctx())
    expect(result).toMatchObject({ type: 'approved' })
    expect(calls).toHaveLength(0)
  })

  it('denies on a policy denial without asking anyone', async () => {
    const calls = installFetch([() => answered('yes')], {
      verdict: 'deny',
      policy: 'issue_refund',
      reason: 'Denied by policy rule issue_refund.',
      authorizationId: 'az_1',
    })
    const result = (await pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })(ctx())) as {
      type: string
      reason: string
    }
    expect(result.type).toBe('denied')
    expect(result.reason).toContain('Denied by policy rule issue_refund.')
    expect(calls).toHaveLength(0)
  })

  it('denies when the human says no', async () => {
    installFetch([() => answered('no')])
    const policy = pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })
    const result = await policy(ctx())
    expect(result).toMatchObject({ type: 'denied' })
  })

  it('fails closed when nobody answers', async () => {
    installFetch([
      () => ({
        json: { decisionId: 'd1', status: 'pending', answered: false, value: null, type: 'confirm' },
      }),
    ])
    const policy = pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })
    const result = (await policy(ctx())) as { type: string; reason: string }
    expect(result.type).toBe('denied')
    expect(result.reason).toContain('No answer')
  })

  it('asks the session principal by default', async () => {
    const calls = installFetch([() => answered('yes')])
    await pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })(ctx({ principalId: 'user_99' }))
    expect(calls[0]?.body?.externalId).toBe('user_99')
  })

  it('lets externalId be resolved per call', async () => {
    const calls = installFetch([() => answered('yes')])
    const policy = pusharyApproval({
      apiKey: 'pk_test.sk_test', timeoutMs: 0,
      externalId: (c) => `tenant:${c.toolName}`,
    })
    await policy(ctx())
    expect(calls[0]?.body?.externalId).toBe('tenant:issue_refund')
  })

  it('refuses when there is no end-user to ask', () => {
    expect(() => resolveApprovalExternalId({}, ctx({ principalId: null }))).toThrow(
      /no end-user to ask/,
    )
  })

  it('keys idempotency on session, call and tool so a replay does not ask twice', async () => {
    const calls = installFetch([() => answered('yes'), () => answered('yes')])
    const policy = pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })
    await policy(ctx())
    await policy(ctx())
    expect(calls[0]?.body?.idempotencyKey).toBe(calls[1]?.body?.idempotencyKey)
  })

  it('varies the idempotency key across different tool calls', async () => {
    const calls = installFetch([() => answered('yes'), () => answered('yes')])
    const policy = pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })
    await policy(ctx({ toolName: 'issue_refund' }))
    await policy(ctx({ toolName: 'delete_account' }))
    expect(calls[0]?.body?.idempotencyKey).not.toBe(calls[1]?.body?.idempotencyKey)
  })

  it('puts the tool input in the question so the human sees what they are approving', () => {
    const q = defaultQuestion(ctx({ toolInput: { amount: 480 } }))
    expect(q).toContain('issue_refund')
    expect(q).toContain('480')
  })

  it('truncates a large tool input rather than sending it whole', () => {
    const q = defaultQuestion(ctx({ toolInput: { blob: 'x'.repeat(1000) } }))
    expect(q.length).toBeLessThan(400)
    expect(q).toContain('...')
  })

  it('asks confirm, never a free-text type', async () => {
    const calls = installFetch([() => answered('yes')])
    await pusharyApproval({ apiKey: 'pk_test.sk_test', timeoutMs: 0 })(ctx())
    expect(calls[0]?.body?.type).toBe('confirm')
  })
})
