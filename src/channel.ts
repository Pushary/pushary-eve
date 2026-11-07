import { defineChannel, POST } from 'eve/channels'
import {
  createPusharyServer,
  deterministicKey,
  parseDecisionCallback,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  type DecisionType,
} from '@pushary/server'
import { createHmac, timingSafeEqual } from 'crypto'

/** One pending request as eve emits it on `interaction.opened`. */
export interface InputRequest {
  readonly interactionId: string
  readonly prompt: string
  readonly display?: 'confirmation' | 'select' | 'text'
  readonly allowFreeform?: boolean
  readonly options?: readonly { readonly id: string; readonly label: string }[]
}

/** What eve 1.0 puts on an `interaction.opened` event, as far as this channel reads it. */
export interface OpenedInteraction {
  readonly interactionId: string
  readonly request: {
    readonly kind: string
    readonly prompt: string
    readonly display?: string
    readonly allowFreeform?: boolean
    readonly options?: readonly { readonly id: string; readonly label: string }[]
  }
}

export interface PusharyChannelConfig {
  /** Your Pushary API key. Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /**
   * Public origin this agent is reachable at, used to build the callback URL
   * Pushary posts the answer to. Defaults to `process.env.PUSHARY_CALLBACK_ORIGIN`,
   * then to `https://$VERCEL_PROJECT_PRODUCTION_URL`.
   */
  readonly callbackOrigin?: string
  /**
   * Webhook secret used to verify inbound answers. Defaults to
   * `process.env.PUSHARY_WEBHOOK_SECRET`. Get it from `decisions.getWebhookSecret()`.
   */
  readonly webhookSecret?: string
  /** The enrolled end-user who answers. Defaults to the session principal. */
  readonly externalId?: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long a pending approval stays answerable. */
  readonly expiresInSeconds?: number
  /**
   * Refuse to open a decision nobody can receive. When true, an end-user with no
   * connected device fails loudly at create time instead of silently expiring.
   */
  readonly requireReachable?: boolean
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

// eve mounts a route at the literal path given to POST(); the channel file stem
// names the channel but does not prefix its URLs. Namespace them here so a
// Pushary channel never collides with another channel's routes.
const ROUTE_ANSWER = '/pushary/answer'
const ROUTE_MESSAGE = '/pushary/message'
const ROUTE_STOP = '/pushary/stop'
const ROUTE_RESET = '/pushary/reset'

const SIGN_IN_KIND = 'sign-in'
type RequestDisplay = NonNullable<InputRequest['display']>
const REQUEST_DISPLAYS: readonly RequestDisplay[] = ['confirmation', 'select', 'text']

const isRequestDisplay = (display: string | undefined): display is RequestDisplay =>
  REQUEST_DISPLAYS.some((known) => known === display)

const requestDisplayOf = (display: string | undefined): InputRequest['display'] =>
  isRequestDisplay(display) ? display : undefined

/** The request to put on a phone, or null for a kind a phone decision cannot answer. */
export const inputRequestFor = (opened: OpenedInteraction): InputRequest | null => {
  if (opened.request.kind === SIGN_IN_KIND) return null
  return {
    interactionId: opened.interactionId,
    prompt: opened.request.prompt,
    display: requestDisplayOf(opened.request.display),
    allowFreeform: opened.request.allowFreeform,
    options: opened.request.options,
  }
}

const requireApiKey = (config: PusharyChannelConfig): string => {
  const key = config.apiKey ?? process.env.PUSHARY_API_KEY
  if (!key) throw new Error('Pushary: set PUSHARY_API_KEY or pass { apiKey } to pusharyChannel().')
  return key
}

const resolveWebhookSecret = (config: PusharyChannelConfig): string => {
  const secret = config.webhookSecret ?? process.env.PUSHARY_WEBHOOK_SECRET
  if (!secret) {
    throw new Error(
      'Pushary: set PUSHARY_WEBHOOK_SECRET or pass { webhookSecret } to pusharyChannel(). ' +
        'Get it from decisions.getWebhookSecret().',
    )
  }
  return secret
}

const resolveCallbackOrigin = (config: PusharyChannelConfig): string => {
  const origin =
    config.callbackOrigin ??
    process.env.PUSHARY_CALLBACK_ORIGIN ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined)
  if (!origin) {
    throw new Error(
      'Pushary: set PUSHARY_CALLBACK_ORIGIN (the public origin of this agent) or pass ' +
        '{ callbackOrigin } to pusharyChannel(), so answers can be delivered back.',
    )
  }
  return origin.replace(/\/+$/, '')
}

/**
 * The end-user who should answer: an explicit `config.externalId` wins, else the
 * session principal. Shared/app-scoped sessions have no per-user principal, so we
 * refuse rather than silently ask the wrong person.
 */
export const channelExternalId = (
  config: PusharyChannelConfig,
  principalId: string | undefined,
): string => {
  const id = config.externalId ?? principalId
  if (!id) {
    throw new Error(
      'Pushary: no end-user to ask. Pass { externalId } to pusharyChannel(), or run ' +
        'user-scoped auth so the session principal is your end-user.',
    )
  }
  return id
}

/** eve's request display maps onto a Pushary decision type. */
export const decisionTypeFor = (request: InputRequest): DecisionType => {
  if (request.display === 'confirmation') return 'confirm'
  if (request.display === 'select') return 'select'
  if (request.options && request.options.length > 0 && !request.allowFreeform) return 'select'
  return 'input'
}

/**
 * Pushary answers with the option *label* the human tapped. eve resolves an
 * approval by option *id*. Match on label first, then id, case-insensitively, so
 * "Approve" and "approve" both land on the `approve` option.
 */
export const optionIdForAnswer = (
  request: Pick<InputRequest, 'options'>,
  answer: string,
): string | undefined => {
  const wanted = answer.trim().toLowerCase()
  const byLabel = request.options?.find((o) => o.label.trim().toLowerCase() === wanted)
  if (byLabel) return byLabel.id
  const byId = request.options?.find((o) => o.id.trim().toLowerCase() === wanted)
  return byId?.id
}

/**
 * Routing params travel on the callback URL, so a parked approval needs no
 * server-side map and survives redeploys. Signed so only we can mint one.
 */
export const signRouting = (secret: string, continuationToken: string, interactionId: string): string =>
  createHmac('sha256', secret).update(`${continuationToken}\x00${interactionId}`).digest('hex')

const routingIsValid = (
  secret: string,
  continuationToken: string,
  interactionId: string,
  signature: string | null,
): boolean => {
  if (!signature) return false
  const expected = Buffer.from(signRouting(secret, continuationToken, interactionId))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * A Pushary channel for eve. Every approval and `ask_question` the agent raises
 * is delivered to a real person's phone and answered from the lock screen; the
 * session parks durably in between, so nothing is held open while it waits.
 *
 * ```ts
 * // agent/channels/pushary.ts
 * import { pusharyChannel } from '@pushary/eve'
 * export default pusharyChannel()
 * ```
 */
export const pusharyChannel = (config: PusharyChannelConfig = {}) =>
  defineChannel({
    routes: [
      POST(ROUTE_ANSWER, async (req, { from }) => {
        const secret = resolveWebhookSecret(config)
        const rawBody = await req.text()
        if (!verifyWebhookSignature(rawBody, req.headers.get(SIGNATURE_HEADER), secret)) {
          return new Response('invalid signature', { status: 401 })
        }

        const callback = parseDecisionCallback(rawBody)
        if (!callback) return new Response('not a decision callback', { status: 400 })

        const url = new URL(req.url)
        const continuationToken = url.searchParams.get('ct')
        const interactionId = url.searchParams.get('rid')
        const optionId = url.searchParams.get('oid')
        if (!continuationToken || !interactionId) {
          return new Response('missing routing params', { status: 400 })
        }
        if (!routingIsValid(secret, continuationToken, interactionId, url.searchParams.get('sig'))) {
          return new Response('invalid routing signature', { status: 401 })
        }

        const answer = callback.value || callback.answer
        // `oid` carries the option ids eve offered for this request, so a tapped
        // label resolves to the id eve expects without a server-side lookup.
        const offered = optionId
          ? (JSON.parse(Buffer.from(optionId, 'base64url').toString('utf8')) as readonly {
              readonly id: string
              readonly label: string
            }[])
          : undefined
        const resolved = offered
          ? optionIdForAnswer({ options: offered }, answer)
          : undefined

        try {
          const source = from(continuationToken)
          await (resolved
            ? source.respond([{ interactionId, optionId: resolved }], { auth: null })
            : source.respond([{ interactionId, text: answer }], { auth: null }))
        } catch {
          // The session already moved on: the approval timed out, was answered
          // elsewhere, or the session was reset. Nothing to resume, and a retry
          // will never succeed, so report it as terminal rather than a 500.
          return Response.json({ ok: false, reason: 'no_pending_request' }, { status: 410 })
        }

        return Response.json({ ok: true })
      }),

      POST(ROUTE_MESSAGE, async (req, { from }) => {
        const body = (await req.json()) as { message?: string; externalId?: string }
        const externalId = body.externalId ?? config.externalId
        if (!body.message || !externalId) {
          return new Response('message and externalId are required', { status: 400 })
        }
        const delivery = await from(externalId).send(body.message, {
          auth: {
            authenticator: 'pushary',
            principalType: 'user',
            principalId: externalId,
            attributes: {},
          },
        })
        return Response.json({ sessionId: delivery.sessionId })
      }),

      POST(ROUTE_STOP, async (req, { from }) => {
        const body = (await req.json()) as { externalId?: string; turnId?: string }
        const externalId = body.externalId ?? config.externalId
        if (!externalId) return new Response('externalId is required', { status: 400 })
        const result = await from(externalId).cancel(
          body.turnId ? { turnId: body.turnId } : undefined,
        )
        return Response.json(result)
      }),

      POST(ROUTE_RESET, async (req, { from }) => {
        const body = (await req.json()) as { externalId?: string; reason?: string }
        const externalId = body.externalId ?? config.externalId
        if (!externalId) return new Response('externalId is required', { status: 400 })
        const result = await from(externalId).end({
          reason: body.reason ?? 'Reset from Pushary',
        })
        return Response.json(result)
      }),
    ],

    events: {
      async 'interaction.opened'({ data }, ctx) {
        const request = inputRequestFor(data)
        const token = ctx.channel.continuation?.token
        if (!request || !token) return
        await openDecisions(config, {
          requests: [request],
          continuationToken: token,
          principalId:
            ctx.session.auth.current?.principalId ?? ctx.session.auth.initiator?.principalId,
        })
      },
    },
  })

/**
 * Opens one Pushary decision per pending input request. Split out of the channel
 * because `defineChannel` wraps event handlers in an eve async context, and this
 * is the part worth testing on its own.
 */
export const openDecisions = async (
  config: PusharyChannelConfig,
  input: {
    readonly requests: readonly InputRequest[]
    readonly continuationToken: string
    readonly principalId: string | undefined
  },
): Promise<void> => {
  const client = createPusharyServer({
    apiKey: requireApiKey(config),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  })
  const externalId = channelExternalId(config, input.principalId)
  const secret = resolveWebhookSecret(config)
  const origin = resolveCallbackOrigin(config)
  const token = input.continuationToken

  for (const request of input.requests) {
    const options = request.options ?? []
    const callbackUrl = new URL(`${origin}${ROUTE_ANSWER}`)
    callbackUrl.searchParams.set('ct', token)
    callbackUrl.searchParams.set('rid', request.interactionId)
    callbackUrl.searchParams.set('sig', signRouting(secret, token, request.interactionId))
    if (options.length > 0) {
      callbackUrl.searchParams.set(
        'oid',
        Buffer.from(JSON.stringify(options), 'utf8').toString('base64url'),
      )
    }

    await client.decisions.create({
      question: request.prompt,
      type: decisionTypeFor(request),
      ...(options.length > 0 ? { options: options.map((o) => o.label) } : {}),
      externalId,
      callbackUrl: callbackUrl.toString(),
      ...(config.agentName ? { agentName: config.agentName } : {}),
      ...(config.expiresInSeconds ? { expiresInSeconds: config.expiresInSeconds } : {}),
      ...(config.requireReachable ? { requireReachable: config.requireReachable } : {}),
      // Stable across replays, so a re-run of this step never asks twice.
      idempotencyKey: deterministicKey([token, request.interactionId]),
    })
  }
}
