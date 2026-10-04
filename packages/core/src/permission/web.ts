export * as PermissionWeb from "./web.js"

// Any other method is a write, which asks about its own method as well.
const reads = new Set(["GET", "HEAD"])

// A method is a verb: letters, with hyphens for names like M-SEARCH. It is spliced into the `METHOD url` resource and
// into the pattern an "always" reply saves, so a space or a wildcard in it could forge a resource or widen a saved rule.
const verb = /^[A-Za-z][A-Za-z-]*$/

/**
 * The permission request for one web request, shared by everything that fetches. It throws for a URL that is not http(s)
 * or has a wildcard in its host, and for a method that is not a plain verb.
 *
 * - The URL resource is the URL as rules see it: no credentials, fragment, default port or trailing dot on the host, and
 *   an ASCII host (a rule for bücher.example is written xn--bcher-kva.example). A rule on a URL cannot be sidestepped by
 *   appending credentials or a fragment.
 * - The host is an alias of the URL resource, so a rule or an approval written for the host keeps covering reads of it.
 *   So is a bare origin, without the root slash the URL parser adds, so a rule written as https://example.com keeps
 *   matching.
 * - A GET or HEAD asks about the URL alone. Any other method also asks about `METHOD url`, which has no aliases: a rule
 *   written for the host or the URL cannot allow a write, but a deny written for either still blocks it through the URL
 *   resource.
 * - "Always" saves the origin, plus `METHOD origin` for a write, never the host alone.
 */
export function request(input: string | URL, method: string) {
  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://")
  // "Always" saves the origin as a rule pattern, where * is a wildcard. A URL can still spell one in its host
  // (docs.example.com*, docs%2A.example.com), which would save a pattern that matches other hosts.
  // No real host contains one.
  if (url.hostname.includes("*")) throw new Error("URL host must not contain *")
  // pastebin.com. is the same host, but a rule written for pastebin.com would not match it.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.replace(/\.+$/, "")
  if (!verb.test(method)) throw new Error("HTTP method must be a name such as GET or POST")

  const name = method.toUpperCase()
  const resource = `${url.origin}${url.pathname}${url.search}`
  const read = reads.has(name)
  return {
    resources: read ? [resource] : [resource, `${name} ${resource}`],
    aliases: { [resource]: url.pathname === "/" && !url.search ? [url.hostname, url.origin] : [url.hostname] },
    save: read ? [`${url.origin}/*`] : [`${url.origin}/*`, `${name} ${url.origin}/*`],
    metadata: { method: name, url: resource },
  }
}
