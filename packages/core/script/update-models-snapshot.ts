#!/usr/bin/env bun
/**
 * Refreshes the bundled model catalog snapshot at src/models-dev/snapshot.txt.
 * The snapshot is the boot-time floor for the catalog when no cache entry exists
 * and no catalog mirror is configured.
 */
const source = process.env.ORBIT_MODELS_URL
if (!source) {
  console.error("Set ORBIT_MODELS_URL to the catalog mirror to snapshot (no default source is built in)")
  process.exit(1)
}
const response = await fetch(`${source}/api.json`)
if (!response.ok) {
  console.error(`Failed to fetch ${source}/api.json: ${response.status} ${response.statusText}`)
  process.exit(1)
}
const text = await response.text()
const parsed: unknown = JSON.parse(text)
// A floor, not equality: guards against committing an error page or a
// truncated body that still parses as a small object.
const MINIMUM_PROVIDERS = 100
if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length < MINIMUM_PROVIDERS) {
  console.error(`Fetched catalog has fewer than ${MINIMUM_PROVIDERS} providers; refusing to write snapshot`)
  process.exit(1)
}
const target = new URL("../src/models-dev/snapshot.txt", import.meta.url)
await Bun.write(target, text)
console.log(`Wrote ${Object.keys(parsed).length} providers (${text.length} bytes) to ${Bun.fileURLToPath(target)}`)
