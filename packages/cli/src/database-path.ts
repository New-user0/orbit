import path from "node:path"
import { ORBIT_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.ORBIT_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(ORBIT_CHANNEL) ||
    process.env.ORBIT_DISABLE_CHANNEL_DB === "1" ||
    process.env.ORBIT_DISABLE_CHANNEL_DB === "true"
      ? "orbit.db"
      : `orbit-${ORBIT_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
