# @pushary/eve-extension

Phone approvals for [Eve](https://eve.dev) agents, as an Eve extension. Your agent asks, your user taps Approve or Deny.

[Full walkthrough: Human-in-the-loop for Eve](https://pushary.com/human-in-the-loop-eve?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme)

## What you need

- A Pushary Partner plan, from $99 a month. [Start the trial](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=partner-start).
- An API key from [Partner onboarding](https://pushary.com/onboarding/partner?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=partner-start), set as `PUSHARY_API_KEY`.
- Your users install the free Pushary app ([iPhone](https://apps.apple.com/us/app/pushary/id6785677563), [Android](https://play.google.com/store/apps/details?id=com.pushary.app)). They never sign up or pay.

## What your customer gets

They open your connect link once, and it connects their phone. When the agent calls `pushary__ask_human`, a push notification titled with your product name arrives, such as **Acme needs your approval**. They approve or decline, pick an option or type an answer, and the tool returns it. No answer means no.

Pushary hosts the phone delivery and the decision record. Eve and your app keep the session, its sign-in and the tools.

## Quick start

```bash
npm i @pushary/eve-extension
```

It needs `eve` 1.0 or a 1.0 release candidate, and Node.js 24 or later.

Mount it under `agent/extensions/`:

```ts
// agent/extensions/pushary.ts
import pushary from '@pushary/eve-extension'

export default pushary({})
```

The filename supplies the namespace, so the agent gains `pushary__ask_human` (approve, choose or type an answer on a phone, and wait for it) and `pushary__connect_phone` (returns the connect link). On iPhone, yes or no can be answered from the lock screen.

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

## Links

- [Eve section of the adapters guide](https://pushary.com/docs/agents/adapters?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme#eve) in the Pushary docs.
- [Partner plan](https://pushary.com/partners?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme), from $99 a month. All plans are on the [pricing page](https://pushary.com/pricing?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme).
- [Browser demo](https://pushary.com/try?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme) of one approval.
- Other adapters: [Vercel AI SDK](https://github.com/Pushary/pushary-ai-sdk), [Mastra](https://github.com/Pushary/pushary-mastra).

MIT
