# @pushary/eve-extension

Human-in-the-loop for [Eve](https://eve.dev), packaged as an Eve extension. One mount adds a tool that pauses the agent until a real human approves on their phone, answered from the lock screen.

Full walkthrough: [Human-in-the-loop for Eve](https://pushary.com/human-in-the-loop-eve). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop).

## Install

```bash
npm i @pushary/eve-extension
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings)).

## Use

Mount it under `agent/extensions/`:

```ts
// agent/extensions/pushary.ts
import pushary from '@pushary/eve-extension'

export default pushary({})
```

The filename supplies the namespace, so the agent gains `pushary__ask_human` (approve, choose, or free-text, delivered to a phone, blocks until answered) and `pushary__connect_phone` (returns the one-tap connect link).

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
