#!/usr/bin/env bun
// Bundles the extension host and the chat webview into dist/. With --package, also writes dist/orbit-code-<version>.vsix.
import { $ } from "bun"
import { rm } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"

const root = path.resolve(import.meta.dir, "..")
const dist = path.join(root, "dist")
await rm(dist, { recursive: true, force: true })

const builds = await Promise.all([
  Bun.build({
    entrypoints: [path.join(root, "src/extension.ts")],
    outdir: dist,
    naming: "extension.js",
    target: "node",
    format: "cjs",
    // ws probes for these optional native add-ons; the bundle leaves them out and ws falls back to plain JavaScript.
    external: ["vscode", "bufferutil", "utf-8-validate"],
    minify: true,
  }),
  Bun.build({
    entrypoints: [path.join(root, "src/webview/main.ts")],
    outdir: dist,
    naming: "webview.js",
    target: "browser",
    format: "iife",
    minify: true,
  }),
])
const failed = builds.flatMap((result) => (result.success ? [] : result.logs))
if (failed.length > 0) {
  failed.forEach((log) => console.error(log))
  process.exit(1)
}
await Bun.write(path.join(dist, "webview.css"), Bun.file(path.join(root, "src/webview/main.css")))
console.log(`built ${path.relative(process.cwd(), dist)}`)

if (process.argv.includes("--package")) {
  const out = path.join(dist, `${pkg.name}-${pkg.version}.vsix`)
  // Everything the extension runs is bundled into dist/, so no node_modules are packaged.
  await $`bun x vsce package --no-dependencies --skip-license --out ${out}`.cwd(root)
  console.log(`packaged ${path.relative(process.cwd(), out)}`)
}
