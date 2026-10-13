export * as ManagedNetwork from "./managed-network.js"

import type { ConfigManaged } from "@orbit/schema/config/managed"
import type { ConfigSandbox } from "@orbit/schema/config/sandbox"
import { AddressGuard } from "@orbit/util/address-guard"
import { Effect } from "effect"
import { ToolNames } from "./tool/names.js"

/**
 * The actions whose resource is a URL, which `denied_domains` binds. Code Mode `fetch` asks as `WebFetch` too, once per
 * request and per redirect hop. The permissions workstream adds any new URL-bearing action here.
 */
export const actions: readonly string[] = ["WebFetch"]

export function bearsUrl(action: string) {
  const canonical = ToolNames.canonical(action)
  return actions.some((item) => ToolNames.canonical(item) === canonical)
}

/**
 * Normalizes one domain pattern, or returns undefined when it is not one. A pattern is a host, or `*.` followed by a
 * domain of at least two labels. A scheme, path, port, credentials, whitespace, any other `*` and a leading or trailing
 * dot are refused. A name with one label (`intranet`) is a host, because refusing it would silently narrow a deny list.
 */
export function pattern(text: string): string | undefined {
  if (text.startsWith(".")) return undefined
  if (text.startsWith("*.")) {
    const rest = text.slice(2)
    if (rest.includes("*") || rest.includes(":") || rest.startsWith(".")) return undefined
    const host = AddressGuard.canonical(rest)
    if (host === undefined || isAddress(host) || !host.includes(".") || host.split(".").some((part) => part === ""))
      return undefined
    return `*.${host}`
  }
  if (text.includes("*") || text === "") return undefined
  // `[::1]` is an address; any other colon is a port or a scheme.
  if (text.includes(":") && !/^\[[0-9a-fA-F:.]+\]$/.test(text)) return undefined
  const host = AddressGuard.canonical(text)
  if (host === undefined || host === "" || host.split(".").some((part) => part === "")) return undefined
  // An IPv6 spelling of an IPv4 address is kept as that address, so one entry covers every spelling (class 6).
  return AddressGuard.embeddedIPv4(host) ?? host
}

/** Whether a host matches one of the patterns, an IPv4 address in any IPv6 spelling counting as itself. `*.d` matches the subdomains of `d` at any depth, never `d` or an address. */
export function matches(patterns: readonly string[], host: string) {
  const spelled = AddressGuard.canonical(host)
  if (spelled === undefined) return false
  const name = AddressGuard.embeddedIPv4(spelled) ?? spelled
  return patterns.some((item) => {
    if (!item.startsWith("*.")) return item === name
    return !isAddress(name) && name.endsWith(item.slice(1))
  })
}

/**
 * Whether a URL-bearing request is denied, from its permission resources (`url` or `METHOD url`). While a deny list
 * exists, a resource that is not an http(s) URL is denied as well, because it cannot be checked.
 */
export function denies(patterns: readonly string[], resources: readonly string[]) {
  if (patterns.length === 0) return false
  return resources.some((resource) => {
    const text = resource.replace(/^[A-Za-z][A-Za-z-]* (?=https?:)/, "")
    if (!URL.canParse(text)) return true
    const url = new URL(text)
    if (url.protocol !== "http:" && url.protocol !== "https:") return true
    return matches(patterns, url.hostname)
  })
}

function isAddress(name: string) {
  return name.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(name)
}

type Network = ConfigManaged.Restrictions["network"]

/**
 * Whether the organization's domain settings bind shell commands. The sandbox can only allow all of the network or none
 * of it, so until it has a proxy that decides per host, any of these keys makes a sandboxed command run offline.
 */
export function limitsShell(network: Network) {
  return (
    network !== undefined &&
    (network.allow_managed_domains_only === true ||
      network.allowed_domains !== undefined ||
      (network.denied_domains?.length ?? 0) > 0)
  )
}

let announcedOffline = false
let announcedUnbound = false

/**
 * The sandbox settings a command launches with. Fail closed: network on becomes network off while domain settings exist.
 * Logs once per process, because every command would otherwise repeat it.
 */
export const sandboxSettings = Effect.fnUntraced(function* (settings: ConfigSandbox.Info | undefined, network: Network) {
  if (!limitsShell(network) || settings?.network !== true) return settings ?? {}
  if (!announcedOffline) {
    announcedOffline = true
    yield* Effect.logWarning(
      "shell sandbox network is off because managed settings set domain lists, which the sandbox cannot yet apply per host",
    )
  }
  return { ...settings, network: false }
})

/** Domain settings exist but a command ran without a sandbox, so they did not bind it. Logs once per process. */
export const unbound = Effect.fnUntraced(function* (network: Network) {
  if (!limitsShell(network) || announcedUnbound) return
  announcedUnbound = true
  yield* Effect.logWarning(
    "managed domain lists do not bind shell commands because the shell sandbox is not in effect; turn on sandbox.enabled in managed settings",
  )
})
