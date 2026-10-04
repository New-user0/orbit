import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  ORBIT_CHANNEL: process.env["ORBIT_CHANNEL"],
  ORBIT_VERSION: process.env["ORBIT_VERSION"],
  ORBIT_RELEASE: process.env["ORBIT_RELEASE"],
}
// The channel names storage folders, registration files and the version, so it must be one path-safe segment: a
// branch such as `feature/x` becomes `feature-x`, and a detached checkout with no branch builds as `preview`.
const CHANNEL = await (async () => {
  if (env.ORBIT_CHANNEL) return env.ORBIT_CHANNEL
  if (env.ORBIT_VERSION && !env.ORBIT_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})().then((channel) => channel.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "") || "preview")
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.ORBIT_VERSION) return env.ORBIT_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${previewBuildNumber()}`
  // Builds never ask a package registry for the last release: a release build names its version explicitly.
  throw new Error("ORBIT_VERSION is required for the latest channel")
})()

function previewBuildNumber() {
  const runNumber = process.env["GITHUB_RUN_NUMBER"]
  if (!runNumber) return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
  const runAttempt = process.env["GITHUB_RUN_ATTEMPT"]
  if (runAttempt && runAttempt !== "1") return `${runNumber}.${runAttempt}`
  return runNumber
}

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.ORBIT_RELEASE
  },
}
console.log(`orbit script`, JSON.stringify(Script, null, 2))
