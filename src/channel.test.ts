import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { createHmac } from 'crypto'
import {
  channelExternalId,
  decisionTypeFor,
  optionIdForAnswer,
  pusharyChannel,
  signRouting,
  encodeRequester,
  openDecisions,
  inputRequestFor,
} from './channel'

const APPROVAL = {
  interactionId: 'req_1',
  prompt: 'Refund charge ch_123 for $240?',
  display: 'confirmation' as const,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
}

describe('inputRequestFor', () => {
  it('puts an approval on the phone with its options', () => {
    expect(
      inputRequestFor({
        interactionId: 'req_1',
        request: { kind: 'approval', prompt: APPROVAL.prompt, display: 'confirmation', options: APPROVAL.options },
      }),
    ).toEqual({ ...APPROVAL, allowFreeform: undefined })
  })

  it('puts a free-text question on the phone', () => {
    expect(
      inputRequestFor({
        interactionId: 'q_1',
        request: { kind: 'question', prompt: 'Which customer?', allowFreeform: true },
      }),
    ).toEqual({ interactionId: 'q_1', prompt: 'Which customer?', display: undefined, allowFreeform: true, options: undefined })
  })

  it('leaves a sign-in to the channel that started the session', () => {
    expect(
      inputRequestFor({ interactionId: 's_1', request: { kind: 'sign-in', prompt: 'Sign in to GitHub' } }),
    ).toBeNull()
  })

  it('drops a display hint it does not know, so the decision type falls back to the options', () => {
    const request = inputRequestFor({
      interactionId: 'r_1',
      request: { kind: 'approval', prompt: 'Ship it?', display: 'carousel', options: APPROVAL.options },
    })
    expect(request?.display).toBeUndefined()
    expect(request && decisionTypeFor(request)).toBe('select')
  })
})

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

describe('interaction.opened', () => {
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
      signRouting('whsec_test', 'user_123', 'req_1', null, callback.searchParams.get('oid')),
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

  it('handles the interaction.opened event', () => {
    const channel = pusharyChannel({
      apiKey: 'pk_test.sk_test',
      webhookSecret: 'whsec_test',
      callbackOrigin: 'https://agent.example.com',
    }) as unknown as { adapter: Record<string, unknown> }

    expect(typeof channel.adapter['interaction.opened']).toBe('function')
  })
})

describe('webhook signature', () => {
  it('matches what the Pushary callback sends', () => {
    const body = JSON.stringify({ correlationId: 'dec_1', answer: 'Approve' })
    const expected = createHmac('sha256', 'whsec_test').update(body).digest('hex')
    expect(expected).toHaveLength(64)
  })
})

describe('an answer arriving from the phone', () => {
  const secret = 'whsec_test'
  const token = 'user_123'
  const interactionId = 'call_1'
  const requester = { authenticator: 'pushary', principalType: 'user', principalId: 'user_123' }
  const offered = Buffer.from(JSON.stringify(APPROVAL.options)).toString('base64url')

  const answerRoute = () =>
    (pusharyChannel({ apiKey: 'pk.sk', webhookSecret: secret, callbackOrigin: 'https://a.example' }) as unknown as {
      routes: readonly { path: string; handler: (req: Request, ctx: unknown) => Promise<Response> }[]
    }).routes.find((route) => route.path === '/pushary/answer')

  const deliver = async (answer: string, encoded: string | null, signature?: string, options: string = offered) => {
    const calls: { answers: unknown; options: unknown }[] = []
    const body = JSON.stringify({ correlationId: 'dec_1', answer })
    const url = new URL('https://a.example/pushary/answer')
    url.searchParams.set('ct', token)
    url.searchParams.set('rid', interactionId)
    url.searchParams.set('oid', options)
    if (encoded) url.searchParams.set('au', encoded)
    url.searchParams.set('sig', signature ?? signRouting(secret, token, interactionId, encoded, options))
    const request = new Request(url, {
      method: 'POST',
      body,
      headers: { 'x-pushary-signature': createHmac('sha256', secret).update(body).digest('hex') },
    })
    const response = await answerRoute()?.handler(request, {
      from: () => ({ respond: async (answers: unknown, options: unknown) => { calls.push({ answers, options }) } }),
    })
    return { calls, status: response?.status }
  }

  it.each([
    ['yes', 'approve'],
    ['Yes', 'approve'],
    ['no', 'deny'],
  ])('maps a %s tap on a confirmation to the %s option', (answer, optionId) => {
    expect(optionIdForAnswer(APPROVAL, answer)).toBe(optionId)
  })

  it('never turns another answer into an approval', () => {
    for (const answer of ['maybe', 'constructor', '']) expect(optionIdForAnswer(APPROVAL, answer)).toBeUndefined()
  })

  it('still prefers an option actually labelled yes', () => {
    const options = [{ id: 'first', label: 'Yes' }, { id: 'approve', label: 'Approve' }]
    expect(optionIdForAnswer({ options }, 'yes')).toBe('first')
  })

  it('answers as the requester, so eve admits the response', async () => {
    const { calls, status } = await deliver('yes', encodeRequester(requester))
    expect(status).toBe(200)
    expect(calls).toEqual([{
      answers: [{ interactionId, optionId: 'approve' }],
      options: { auth: { ...requester, attributes: {} } },
    }])
  })

  it('refuses a callback whose requester was changed after signing', async () => {
    const signed = signRouting(secret, token, interactionId, encodeRequester(requester), offered)
    const forged = encodeRequester({ ...requester, principalId: 'someone_else' })
    const { calls, status } = await deliver('yes', forged, signed)
    expect(status).toBe(401)
    expect(calls).toEqual([])
  })

  it('sends no identity when the request carried no requester', async () => {
    const { calls, status } = await deliver('Approve', null)
    expect(status).toBe(200)
    expect(calls).toEqual([{ answers: [{ interactionId, optionId: 'approve' }], options: { auth: null } }])
  })

  it('refuses a no whose offered options were changed so it means approve', async () => {
    const encoded = encodeRequester(requester)
    const signed = signRouting(secret, token, interactionId, encoded, offered)
    const forged = Buffer.from(JSON.stringify([{ id: 'approve', label: 'no' }]), 'utf8').toString('base64url')
    const { calls, status } = await deliver('no', encoded, signed, forged)
    expect(status).toBe(401)
    expect(calls).toEqual([])
  })

  it('refuses offered options added to a signature that never covered them', async () => {
    const { calls, status } = await deliver('yes', null, signRouting(secret, token, interactionId))
    expect(status).toBe(401)
    expect(calls).toEqual([])
  })

  it('does not let a field slide into its neighbour', () => {
    const encoded = encodeRequester(requester)
    expect(signRouting(secret, token, `${interactionId}\x00${encoded}`)).not.toBe(signRouting(secret, token, interactionId, encoded))
    expect(signRouting(secret, token, interactionId, `${encoded}\x00oid=${offered}`)).not.toBe(signRouting(secret, token, interactionId, encoded, offered))
  })

  it('does not mistake a signed requester for signed options', async () => {
    const encoded = encodeRequester(requester)
    expect(signRouting(secret, token, interactionId, encoded)).not.toBe(signRouting(secret, token, interactionId, null, encoded))
  })
})
