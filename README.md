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

Thin wrapper over [`@pushary/server`](https://www.npmjs.com/package/@pushary/server) (`enroll` + `decisions.ask`). Verified against `eve@0.24.x`; pin your `eve` version. See the [adapters guide](https://pushary.com/docs/agents/adapters?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-eve&utm_content=readme).

MIT

## Example

A runnable example is in [`examples/`](examples).

