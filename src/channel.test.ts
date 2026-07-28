import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { createHmac } from 'crypto'
import {
  channelExternalId,
  decisionTypeFor,
  optionIdForAnswer,
  pusharyChannel,
  signRouting,
  openDecisions,
} from './channel'

const APPROVAL = {
  requestId: 'req_1',
  prompt: 'Refund charge ch_123 for $240?',
  display: 'confirmation' as const,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
  action: { toolName: 'refund_charge', callId: 'call_1' },
}

describe('decisionTypeFor', () => {
  it('maps an approval to a confirm', () => {
    expect(decisionTypeFor(APPROVAL)).toBe('confirm')
  })

  it('maps an explicit select', () => {
    expect(
      decisionTypeFor({ ...APPROVAL, display: 'select', prompt: 'Which environment?' }),
    ).toBe('select')
  })

  it('maps options without freeform to a select', () => {
    expect(decisionTypeFor({ ...APPROVAL, display: undefined })).toBe('select')
  })

  it('maps a freeform question to an input', () => {
    expect(
      decisionTypeFor({ ...APPROVAL, display: undefined, options: [], allowFreeform: true }),
    ).toBe('input')
  })
})

describe('optionIdForAnswer', () => {
  it('resolves the tapped label back to the id eve expects', () => {
    expect(optionIdForAnswer(APPROVAL, 'Approve')).toBe('approve')
  })

  it('ignores case and surrounding space', () => {
    expect(optionIdForAnswer(APPROVAL, '  deny ')).toBe('deny')
  })

  it('falls back to matching the id directly', () => {
    const request = { ...APPROVAL, options: [{ id: 'ship', label: 'Ship it' }] }
    expect(optionIdForAnswer(request, 'ship')).toBe('ship')
  })

  it('returns undefined for free text so it is delivered as text', () => {
    expect(optionIdForAnswer(APPROVAL, 'call me first')).toBeUndefined()
  })
})

describe('channelExternalId', () => {
  it('prefers the configured end-user', () => {
    expect(channelExternalId({ externalId: 'fixed' }, 'principal')).toBe('fixed')
  })

  it('falls back to the session principal', () => {
    expect(channelExternalId({}, 'principal')).toBe('principal')
  })

  it('refuses rather than asking the wrong person', () => {
    expect(() => channelExternalId({}, undefined)).toThrow(/no end-user to ask/)
  })
})

describe('signRouting', () => {
  it('is stable for the same session and request', () => {
    expect(signRouting('s', 'ct', 'rid')).toBe(signRouting('s', 'ct', 'rid'))
  })

  it('does not collide when the fields shift across the boundary', () => {
    expect(signRouting('s', 'ab', 'c')).not.toBe(signRouting('s', 'a', 'bc'))
  })
})

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? address.port : 0)
  }))

describe('input.requested', () => {
  it('opens a Pushary decision that can route the answer home', async () => {
    const received: { path: string; body: Record<string, unknown> }[] = []
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ decisionId: 'dec_1', status: 'pending', answered: false }))
      })
    })
    const port = await listen(server)

    await openDecisions(
      {
        apiKey: 'pk_test.sk_test',
        webhookSecret: 'whsec_test',
        callbackOrigin: 'https://agent.example.com/',
        agentName: 'Test agent',
        baseUrl: `http://127.0.0.1:${port}/api/v1/server`,
      },
      { requests: [APPROVAL], continuationToken: 'user_123', principalId: 'user_123' },
    )

    server.close()

    expect(received).toHaveLength(1)
    expect(received[0].path).toBe('/api/v1/server/decisions')

    const body = received[0].body
    expect(body.question).toBe(APPROVAL.prompt)
    expect(body.type).toBe('confirm')
    expect(body.options).toEqual(['Approve', 'Deny'])
    expect(body.externalId).toBe('user_123')
    expect(body.agentName).toBe('Test agent')
    // Stable across replays, so a re-run never asks the same human twice.
    expect(body.idempotencyKey).toEqual(expect.any(String))

    const callback = new URL(body.callbackUrl as string)
    // The trailing slash on callbackOrigin must not double up.
    expect(callback.origin + callback.pathname).toBe('https://agent.example.com/pushary/answer')
    expect(callback.searchParams.get('ct')).toBe('user_123')
    expect(callback.searchParams.get('rid')).toBe('req_1')
    expect(callback.searchParams.get('sig')).toBe(
      signRouting('whsec_test', 'user_123', 'req_1'),
    )

    const offered = JSON.parse(
      Buffer.from(callback.searchParams.get('oid') as string, 'base64url').toString('utf8'),
    )
    expect(offered).toEqual(APPROVAL.options)
  })

  it('refuses to open a decision when no end-user can be identified', async () => {
    await expect(
      openDecisions(
        {
          apiKey: 'pk_test.sk_test',
          webhookSecret: 'whsec_test',
          callbackOrigin: 'https://agent.example.com',
        },
        { requests: [APPROVAL], continuationToken: 'anon', principalId: undefined },
      ),
    ).rejects.toThrow(/no end-user to ask/)
  })
})

describe('pusharyChannel', () => {
  it('namespaces its routes so they cannot collide with another channel', () => {
    const channel = pusharyChannel({
      apiKey: 'pk_test.sk_test',
      webhookSecret: 'whsec_test',
      callbackOrigin: 'https://agent.example.com',
    }) as unknown as { routes: readonly { method: string; path: string }[] }

    expect(channel.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /pushary/answer',
      'POST /pushary/message',
      'POST /pushary/stop',
      'POST /pushary/reset',
    ])
  })

  it('handles the input.requested event', () => {
    const channel = pusharyChannel({
      apiKey: 'pk_test.sk_test',
      webhookSecret: 'whsec_test',
      callbackOrigin: 'https://agent.example.com',
    }) as unknown as { adapter: Record<string, unknown> }

    expect(typeof channel.adapter['input.requested']).toBe('function')
  })
})

describe('webhook signature', () => {
  it('matches what the Pushary callback sends', () => {
    const body = JSON.stringify({ correlationId: 'dec_1', answer: 'Approve' })
    const expected = createHmac('sha256', 'whsec_test').update(body).digest('hex')
    expect(expected).toHaveLength(64)
  })
})
