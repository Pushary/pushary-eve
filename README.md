# @pushary/eve

[![CI](https://github.com/Pushary/pushary-eve/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-eve/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/eve)](https://www.npmjs.com/package/@pushary/eve)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for Eve](https://pushary.com/human-in-the-loop-eve?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme).

Human-in-the-loop for [Eve](https://eve.dev). Give your agent a tool that pauses until a real human approves on their phone, answered from the lock screen.

Two calls is the whole integration:

1. `pusharyConnectPhone()` returns a link the end-user taps once to connect their phone.
2. `pusharyAskHuman()` asks that person and blocks until they answer, with a fail-closed result.

Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme).

## Install

```bash
npm i @pushary/eve
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings)).

## Use

Eve discovers tools by file. Drop in two one-line files:

```ts
// agent/tools/ask-human.ts
import { pusharyAskHuman } from '@pushary/eve'
export default pusharyAskHuman()
```

```ts
// agent/tools/connect-phone.ts
import { pusharyConnectPhone } from '@pushary/eve'
export default pusharyConnectPhone()
```

That is it. The agent now has `ask-human` (approve / choose / free-text, delivered to a phone, blocks until answered) and `connect-phone` (returns the one-tap connect link).

## Gating a tool the model cannot skip

`pusharyAskHuman()` is a tool the model chooses to call. That is right for "go ask
someone about this", and wrong for "this must not happen without a yes", because a
model that does not want to be interrupted can decline to call it.

For an enforced gate, use `pusharyApproval()` in Eve's own per-tool `approval:`
field. Eve evaluates it before `execute` runs, so there is no path around it:

```ts
// agent/tools/issue-refund.ts
import { defineTool } from 'eve/tools'
import { pusharyApproval } from '@pushary/eve'

export default defineTool({
  name: 'issue_refund',
  inputSchema: z.object({ amount: z.number(), customer: z.string() }),
  approval: pusharyApproval(),
  execute: async ({ amount }) => refund(amount),
})
```

It sits alongside Eve's built-in `always()`, `never()` and `once()`, which decide
statically. This one asks a person and waits for the answer.

Fail-closed: a denial, an expiry, or nobody answering all come back denied and the
tool does not run. The decision is keyed on session, call and tool, so a replayed
turn resolves to the same decision instead of asking twice.

For a multi-tenant product, resolve the end-user per call:

```ts
approval: pusharyApproval({ externalId: (ctx) => ctx.toolInput?.customer })
```

`pusharyApproval<TInput>()` is generic over your tool's input, so `ctx.toolInput` is
typed inside that callback.

## The channel

The tools above are for asking on purpose. The channel covers everything Eve already pauses on: any tool gated with `approval` from `eve/tools/approval`, and the built-in `ask_question`. Eve renders those as buttons in Slack. This renders them on a phone.

```ts
// agent/channels/pushary.ts
import { pusharyChannel } from '@pushary/eve'
export default pusharyChannel()
```

```bash
PUSHARY_API_KEY=pk_...sk_...
PUSHARY_WEBHOOK_SECRET=whsec_...          # decisions.getWebhookSecret()
PUSHARY_CALLBACK_ORIGIN=https://your-agent.vercel.app
```

Eve emits `input.requested` and parks the turn durably. The channel opens a Pushary decision carrying a signed callback URL, and nothing is held open while it waits, so an approval can sit for hours at zero idle compute. When the human taps, `POST /pushary/answer` verifies the webhook signature and the per-request routing signature, then resumes the parked turn with the matching `inputResponses` entry.

Three more routes put the rest of the session on the phone:

| Route | Does |
| --- | --- |
| `POST /pushary/message` | Send a follow-up, starting a session if there is none |
| `POST /pushary/stop` | `cancel()` the in-flight turn, leaving history intact |
| `POST /pushary/reset` | `reset()` the session so the next message starts clean |

Options are matched back by label and then by id, so an approval resolves to Eve's `approve` or `deny` and a select resolves to the option that was tapped. Each decision carries an idempotency key derived from the session and request id, so a replayed step never asks the same person twice. A stale answer, one whose session already moved on, returns `410` rather than failing the webhook.

## Who answers

By default each tool asks the **session principal**, so run user-scoped auth and each end-user is their own principal. To bind a fixed end-user (single-user agents, jobs), pass one:

```ts
export default pusharyAskHuman({ externalId: 'user_123' })
```

If there is no principal and no configured `externalId`, the tool throws a clear error instead of asking the wrong person.

## Behavior that matters

- **Fail-closed.** A declined, expired, or unanswered `confirm` is reported to the model as "not approved, do not proceed." Approval only happens on an explicit yes.
- **Serverless-safe.** Each ask blocks up to 55 seconds by default (`timeoutMs`). The decision stays answerable for its full lifetime.

## Config

`pusharyAskHuman(config?)` / `pusharyConnectPhone(config?)` accept `{ apiKey?, externalId?, agentName?, timeoutMs?, baseUrl? }`. `apiKey` defaults to `process.env.PUSHARY_API_KEY`.

## Under the hood

Thin wrapper over [`@pushary/server`](https://www.npmjs.com/package/@pushary/server). The tools use `enroll` + `decisions.ask`; the channel uses `decisions.create` with a signed callback URL. Verified against `eve@0.27.8`. See the [adapters guide](https://pushary.com/docs/agents/adapters?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme).

MIT

## Example

A runnable example is in [`examples/`](examples).

