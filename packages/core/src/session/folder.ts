export * as SessionFolder from "./folder.js"

// A client chooses the ID of a session it creates, and the ID of the parent or the fork source it names, and an import
// keeps the IDs its file holds. Such an ID becomes the name of a folder (a scratchpad, a session's saved tool results), so
// it names one only when it is `ses_` and plain letters, digits and underscores (class 5). That leaves out every
// separator, `..`, drive colon and trailing dot or space, and no Windows device name starts with `ses_`. A generated ID
// is `ses_` and 26 letters and digits.
export const KEY = /^ses_[A-Za-z0-9_]{1,96}$/
