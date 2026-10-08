export * as SessionDelivery from "./session-delivery.js"

import { Schema } from "effect"

/**
 * How pending input reaches the Session: a steer joins the work in progress at its next step boundary, while a queued
 * input waits until the previous work ended and then starts a turn of its own. The inbox names it
 * `SessionInbox.Delivery`. It lives apart from the inbox because a message records the delivery it was promoted with,
 * and the inbox already imports the message module for its IDs.
 */
export const Delivery = Schema.Literals(["steer", "queue"]).annotate({ identifier: "Session.Inbox.Delivery" })
export type Delivery = typeof Delivery.Type
