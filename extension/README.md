# @pushary/eve-extension

Phone approvals for [Eve](https://eve.dev) agents, as an Eve extension. Your agent asks, your user taps Approve or Deny.

[Full walkthrough: Human-in-the-loop for Eve](https://pushary.com/human-in-the-loop-eve)

## What you need

- A Pushary Partner plan, from $99 a month. [Start the trial](https://pushary.com/sign-up?from=agent&plan=partner).
- An API key from [Partner onboarding](https://pushary.com/onboarding/partner), set as `PUSHARY_API_KEY`.
- Your users install the free Pushary app ([iPhone](https://apps.apple.com/us/app/pushary/id6785677563), [Android](https://play.google.com/store/apps/details?id=com.pushary.app)). They never sign up or pay.

## Quick start

```bash
npm i @pushary/eve-extension
```

Mount it under `agent/extensions/`:

```ts
// agent/extensions/pushary.ts
import pushary from '@pushary/eve-extension'

export default pushary({})
```

The filename supplies the namespace, so the agent gains `pushary__ask_human` (approve, choose or type an answer on a phone, and wait for it) and `pushary__connect_phone` (returns the connect link). Yes or no can be answered from the lock screen.

Eve's own approval docs: [Multi-tenant approvals](https://eve.dev/docs/patterns/multi-tenant-approvals).

## Config

```ts
export default pushary({
  externalId: 'user_123',
  agentName: 'Billing agent',
  timeoutMs: 55_000,
})
```

| Option | Does |
| --- | --- |
| `apiKey` | Falls back to `process.env.PUSHARY_API_KEY` |
| `externalId` | Bind a fixed end-user. Defaults to the session principal |
| `agentName` | Shown on the approval so the human knows who is asking |
| `timeoutMs` | How long each ask blocks. Serverless-safe by default |
| `baseUrl` | Override the API base URL (tests / self-host) |

## Which one do I want

- **This extension**, or the plain tools in [`@pushary/eve`](https://www.npmjs.com/package/@pushary/eve), for asking a human on purpose.
- **`pusharyChannel()`** in [`@pushary/eve`](https://www.npmjs.com/package/@pushary/eve) for everything Eve already pauses on: tools gated with `approval`, and the built-in `ask_question`. Eve renders those as buttons in Slack; the channel renders them on a phone.

They compose. Mount both if you want the agent to be able to ask directly *and* to have every gated tool call reach a phone.

MIT
