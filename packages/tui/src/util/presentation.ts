import { mark } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"
const ion = "\x1b[36m"

function wordmark(pad = "") {
  return [
    `${pad}${ion}${mark.top}${reset}`,
    `${pad}${dim}${mark.ring}${ion}${mark.planet}${dim}${mark.ring}${reset}${mark.moon}   ${ion}${bold}Orbit${reset}`,
    `${pad}${ion}${mark.bottom}${reset}`,
  ]
}

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    ...wordmark("  "),
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}orb -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
