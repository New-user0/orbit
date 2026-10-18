export * as SessionEffort from "./effort.js"

// ASCII word boundaries: a letter, digit or underscore on either side makes it part of a longer word.
const KEYWORD = /(?<![A-Za-z0-9_])ultrathink(?![A-Za-z0-9_])/i

/** Whether the text asks for a higher level of reasoning effort for the turn it starts. */
export const requested = (text: string) => KEYWORD.test(text)

/** The harness note that tells the model about the request. It carries no outside text. */
export const note =
  "The person asked for a high level of reasoning effort for this turn. Think the task through carefully before you act."
