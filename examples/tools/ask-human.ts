// Eve discovers tools by file. Drop this into your agent's tools directory.
// The agent gets an `ask-human` tool: approve / choose / free-text, delivered to a
// phone, blocking until answered, fail-closed. By default it asks the session
// principal; pass { externalId } to bind a fixed end-user.
import { pusharyAskHuman } from '@pushary/eve'

export default pusharyAskHuman()
