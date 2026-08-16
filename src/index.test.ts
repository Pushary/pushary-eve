import { describe, it, expect, afterEach } from 'vitest'
import type { ToolContext } from 'eve/tools'
import { pusharyAskHuman, pusharyConnectPhone, pickExternalId, answerToModelText, parseAskInput } from './index'
import type { AskResult } from '@pushary/server'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}
type Responder = (call: Recorded) => { status?: number; json: unknown }

const realFetch = globalThis.fetch
const installFetch = (responders: readonly Responder[]): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
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

// A minimal ToolContext whose session principal is `principalId`.
const ctxWithPrincipal = (principalId: string | null): ToolContext =>
  ({
    session: {
      id: 's1',
      auth: {
        current: principalId
          ? { principalId, principalType: 'user', authenticator: 'test', attributes: {} }
          : null,
        initiator: null,
      },
      turn: {},
    },
    callId: 'call_1',
    toolName: 'ask-human',
    abortSignal: new AbortController().signal,
    getSandbox: () => {
      throw new Error('no sandbox in test')
    },
    getSkill: () => {
      throw new Error('no skill in test')
    },
  }) as unknown as ToolContext

const ask = (r: Partial<AskResult>): AskResult => ({
  decisionId: 'd',
  status: 'answered',
  answered: true,
  value: 'yes',
  type: 'confirm',
  approved: true,
  ...r,
})

describe('pickExternalId', () => {
  it('config.externalId wins over the session principal', () => {
    expect(pickExternalId({ externalId: 'cfg' }, 'session')).toBe('cfg')
  })
  it('falls back to the session principal', () => {
    expect(pickExternalId({}, 'session')).toBe('session')
  })
  it('throws when there is no end-user to ask', () => {
    expect(() => pickExternalId({}, undefined)).toThrow(/no end-user/i)
  })
})

describe('answerToModelText', () => {
  it('formats every outcome', () => {
    expect(answerToModelText('confirm', ask({ approved: true }))).toContain('approved')
    expect(answerToModelText('confirm', ask({ approved: false, value: 'no' }))).toContain('declined')
    expect(answerToModelText('confirm', ask({ answered: false, status: 'expired', approved: false }))).toContain(
      'NOT approved',
    )
    expect(answerToModelText('select', ask({ type: 'select', value: 'B' }))).toContain('B')
  })
})

describe('pusharyAskHuman tool', () => {
  it('asks the session principal and reports approval', async () => {
    const calls = installFetch([
      () => ({ json: { decisionId: 'd', status: 'pending', answered: false, type: 'confirm' } }),
      () => ({ json: { decisionId: 'd', status: 'answered', answered: true, value: 'yes', type: 'confirm' } }),
    ])
    const tool = pusharyAskHuman({ apiKey: 'pk_x.sk_y', baseUrl: 'https://pushary.com/api/v1/server', timeoutMs: 5000 })
    expect(typeof tool.execute).toBe('function')
    const out = await tool.execute({ question: 'Ship it?', type: 'confirm' }, ctxWithPrincipal('user_9'))
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/decisions')
    expect(calls[0].body?.externalId).toBe('user_9')
    expect(out).toContain('approved')
  })

  it('throws a clear error when there is no principal and no configured externalId', async () => {
    installFetch([() => ({ json: {} })])
    const tool = pusharyAskHuman({ apiKey: 'pk_x.sk_y' })
    await expect(tool.execute({ question: 'q', type: 'confirm' }, ctxWithPrincipal(null))).rejects.toThrow(
      /no end-user/i,
    )
  })
})

describe('pusharyConnectPhone tool', () => {
  it('enrolls the session principal and returns the connect link', async () => {
    const calls = installFetch([
      () => ({
        json: {
          externalId: 'user_9',
          token: 'tok',
          deepLink: 'pushary://enroll?token=tok',
          universalLink: 'https://pushary.com/e/tok',
          expiresInSeconds: 900,
        },
      }),
    ])
    const tool = pusharyConnectPhone({ apiKey: 'pk_x.sk_y', baseUrl: 'https://pushary.com/api/v1/server' })
    const out = await tool.execute({}, ctxWithPrincipal('user_9'))
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/enroll')
    expect(calls[0].body?.externalId).toBe('user_9')
    expect(out).toContain('https://pushary.com/e/tok')
  })

  it('ignores a model-supplied externalId and enrolls the session principal', async () => {
    const calls = installFetch([
      () => ({
        json: {
          externalId: 'user_9',
          token: 'tok',
          deepLink: 'pushary://enroll?token=tok',
          universalLink: 'https://pushary.com/e/tok',
          expiresInSeconds: 900,
        },
      }),
    ])
    const tool = pusharyConnectPhone({ apiKey: 'pk_x.sk_y', baseUrl: 'https://pushary.com/api/v1/server' })
    // A prompt-injected model must not bind another user's identity to this phone.
    await tool.execute({ externalId: 'victim_user' } as never, ctxWithPrincipal('user_9'))
    expect(calls[0].body?.externalId).toBe('user_9')
  })

  it('config.externalId is used and model input cannot override it', async () => {
    const calls = installFetch([
      () => ({
        json: {
          externalId: 'fixed_user',
          token: 'tok',
          deepLink: 'pushary://enroll?token=tok',
          universalLink: 'https://pushary.com/e/tok',
          expiresInSeconds: 900,
        },
      }),
    ])
    const tool = pusharyConnectPhone({ apiKey: 'pk_x.sk_y', externalId: 'fixed_user', baseUrl: 'https://pushary.com/api/v1/server' })
    await tool.execute({ externalId: 'victim_user' } as never, ctxWithPrincipal('someone_else'))
    expect(calls[0].body?.externalId).toBe('fixed_user')
  })
})

describe('parseAskInput', () => {
  it('reads a well-formed input', () => {
    expect(parseAskInput({ question: 'Ship it?', type: 'select', options: ['a', 'b'] })).toEqual({
      question: 'Ship it?',
      type: 'select',
      options: ['a', 'b'],
    })
  })

  it('defaults type to confirm', () => {
    expect(parseAskInput({ question: 'Ship it?' }).type).toBe('confirm')
  })

  it('rejects a type the model invented', () => {
    expect(parseAskInput({ question: 'q', type: 'freeform' }).type).toBe('confirm')
  })

  it('drops non-string options rather than passing them through', () => {
    expect(parseAskInput({ question: 'q', options: ['a', 3, null, 'b'] }).options).toEqual([
      'a',
      'b',
    ])
  })

  it('omits options entirely when none survive', () => {
    expect(parseAskInput({ question: 'q', options: [1, 2] }).options).toBeUndefined()
  })

  it('survives a non-object input', () => {
    expect(parseAskInput(null)).toEqual({ question: '', type: 'confirm' })
    expect(parseAskInput('nope')).toEqual({ question: '', type: 'confirm' })
  })
})
