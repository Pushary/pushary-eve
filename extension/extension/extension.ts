import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    /** Your Pushary API key. Falls back to `process.env.PUSHARY_API_KEY`. */
    apiKey: z.string().optional(),
    /** The enrolled end-user who answers. Defaults to the session principal. */
    externalId: z.string().optional(),
    /** Shown on the approval so the human knows which agent is asking. */
    agentName: z.string().optional(),
    /** How long each ask blocks before returning. Serverless-safe by default. */
    timeoutMs: z.number().int().positive().optional(),
    /** Override the API base URL (tests / self-host). */
    baseUrl: z.string().url().optional(),
  }),
});
