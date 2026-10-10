export * as Token from "./token.js"

const CHARS_PER_TOKEN = 4

/** The estimate for text of `characters` UTF-16 units, so a total can be kept without joining the text. */
export const estimateLength = (characters: number) => Math.max(0, Math.round(characters / CHARS_PER_TOKEN))

export const estimate = (input: string) => estimateLength(input.length)
