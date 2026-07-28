// agent/channels/pushary.ts
//
// Every approval and every ask_question Eve raises is delivered as a push
// notification and answered from the lock screen. The turn stays parked
// durably in between, so nothing is held open while it waits.
import { pusharyChannel } from '@pushary/eve'

export default pusharyChannel()
