declare const ORBIT_VERSION: string
declare const ORBIT_CHANNEL: string
declare const ORBIT_ARTIFACT: string

const version = typeof ORBIT_VERSION === "string" ? ORBIT_VERSION : "local"
const channel = typeof ORBIT_CHANNEL === "string" ? ORBIT_CHANNEL : "local"
const artifact = typeof ORBIT_ARTIFACT === "string" ? ORBIT_ARTIFACT : "cli"

export { version as ORBIT_VERSION, channel as ORBIT_CHANNEL, artifact as ORBIT_ARTIFACT }
export const ORBIT_LOCAL = channel === "local"
