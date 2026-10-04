import { describe, expect, test } from "bun:test"
import { Permission } from "@orbit/core/permission"
import { PermissionWeb } from "@orbit/core/permission/web"
import { Wildcard } from "@orbit/core/util/wildcard"

describe("PermissionWeb.request", () => {
  const url = "https://example.com/a/b?x=1"

  test("asks about the URL alone for a read and saves its origin", () => {
    for (const [method, verb] of [
      ["GET", "GET"],
      ["get", "GET"],
      ["HEAD", "HEAD"],
      ["head", "HEAD"],
    ] as const)
      expect(PermissionWeb.request(url, method)).toEqual({
        resources: [url],
        aliases: { [url]: ["example.com"] },
        save: ["https://example.com/*"],
        metadata: { method: verb, url },
      })
  })

  test("also asks about the method form for a write, and saves that pattern too", () => {
    for (const method of ["POST", "post", "PUT", "PATCH", "DELETE", "OPTIONS", "M-SEARCH", "Propfind"]) {
      const verb = method.toUpperCase()
      expect(PermissionWeb.request(url, method)).toEqual({
        resources: [url, `${verb} ${url}`],
        // Only the URL has aliases: a rule or an approval written for the host never allows the method form.
        aliases: { [url]: ["example.com"] },
        save: ["https://example.com/*", `${verb} https://example.com/*`],
        metadata: { method: verb, url },
      })
    }
  })

  // The resource is the URL as rules see it: no credentials, no fragment, no default port, no trailing dot on the host
  // and an ASCII host. The host alias never has a port. A bare origin is also an alias without the root slash.
  test.each([
    [
      "https://user:pw@Example.com:443/a/b?x=1#section",
      "https://example.com/a/b?x=1",
      ["example.com"],
      "https://example.com",
    ],
    ["http://Localhost:8080/docs#top", "http://localhost:8080/docs", ["localhost"], "http://localhost:8080"],
    ["http://example.com:80/a", "http://example.com/a", ["example.com"], "http://example.com"],
    ["https://pastebin.com./raw/x", "https://pastebin.com/raw/x", ["pastebin.com"], "https://pastebin.com"],
    ["https://pastebin.com../raw/x", "https://pastebin.com/raw/x", ["pastebin.com"], "https://pastebin.com"],
    [
      "https://bücher.example/a",
      "https://xn--bcher-kva.example/a",
      ["xn--bcher-kva.example"],
      "https://xn--bcher-kva.example",
    ],
    ["http://[::1]:3000/x", "http://[::1]:3000/x", ["[::1]"], "http://[::1]:3000"],
    ["http://2130706433/x", "http://127.0.0.1/x", ["127.0.0.1"], "http://127.0.0.1"],
    ["https://example.com", "https://example.com/", ["example.com", "https://example.com"], "https://example.com"],
    [
      "http://example.com:8080/?#top",
      "http://example.com:8080/",
      ["example.com", "http://example.com:8080"],
      "http://example.com:8080",
    ],
    ["https://example.com/?page=2", "https://example.com/?page=2", ["example.com"], "https://example.com"],
  ] as const)("canonicalizes %s", (input, resource, aliases, origin) => {
    expect(PermissionWeb.request(input, "GET")).toEqual({
      resources: [resource],
      aliases: { [resource]: [...aliases] },
      save: [`${origin}/*`],
      metadata: { method: "GET", url: resource },
    })
  })

  test("reads a URL object without changing it", () => {
    const input = new URL("https://user@example.com./a#frag")

    expect(PermissionWeb.request(input, "GET").resources).toEqual(["https://example.com/a"])
    expect(input.href).toBe("https://user@example.com./a#frag")
  })

  test("rejects a scheme other than http and https", () => {
    for (const input of [
      "file:///etc/passwd",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "ftp://example.com/x",
      "s3://bucket/key",
      "blob:https://example.com/id",
      "ws://example.com/",
    ])
      expect(() => PermissionWeb.request(input, "GET")).toThrow("URL must use http:// or https://")
  })

  test("rejects a URL that does not parse", () => {
    for (const input of ["", "not a url", "example.com/a", "//example.com/a", "http://"])
      expect(() => PermissionWeb.request(input, "GET")).toThrow()
  })

  // "Always" saves the origin as a rule pattern, so a host that spells * must never get that far.
  test("rejects a host that spells a wildcard", () => {
    for (const input of [
      "https://docs.example.com*/x",
      "https://docs%2A.example.com/",
      "https://docs.example.com＊/x",
      "https://*.example.com/",
    ])
      expect(() => PermissionWeb.request(input, "GET")).toThrow("URL host must not contain *")
  })

  // The method is spliced into a resource and into a saved pattern, so it must not carry a space or a wildcard.
  test("rejects a method that is not a plain verb", () => {
    for (const method of [
      "",
      " ",
      "PO ST",
      "POST ",
      "*",
      "P?ST",
      "POST https://example.com/",
      "GET\n",
      "1GET",
      "ä",
      "ı",
    ])
      expect(() => PermissionWeb.request(url, method)).toThrow("HTTP method must be a name such as GET or POST")
  })

  // What the request means for rules: the host is an alias of the URL, so a rule written for it covers a read of the
  // host but never the `METHOD url` resource of a write, while a deny written for it still blocks the write.
  describe("against rules", () => {
    const effects = (rules: Permission.Ruleset, target: string, method: string) => {
      const web = PermissionWeb.request(target, method)
      return web.resources.map(
        (resource) => Permission.evaluate("webfetch", resource, rules, web.aliases[resource]).effect,
      )
    }
    const allow = (resource: string): Permission.Rule => ({ action: "webfetch", resource, effect: "allow" })

    test("a host allow covers a read of the host and asks for a write to it", () => {
      expect(effects([allow("example.com")], "https://example.com/x", "GET")).toEqual(["allow"])
      expect(effects([allow("example.com")], "https://example.com/x", "POST")).toEqual(["allow", "ask"])
    })

    test("a URL or origin allow covers a read and asks for a write", () => {
      const rules = [allow("https://example.com/*")]

      expect(effects(rules, "https://example.com/x", "HEAD")).toEqual(["allow"])
      expect(effects(rules, "https://example.com/x", "DELETE")).toEqual(["allow", "ask"])
    })

    test("a write is allowed once its method form is allowed too, and only for that method", () => {
      const rules = [allow("https://example.com/*"), allow("POST https://example.com/*")]

      expect(effects(rules, "https://example.com/x", "POST")).toEqual(["allow", "allow"])
      expect(effects(rules, "https://example.com/x", "PUT")).toEqual(["allow", "ask"])
    })

    test("a deny for the host or the URL blocks a write through the URL resource", () => {
      for (const resource of ["example.com", "https://example.com/*"])
        expect(
          effects([allow("*"), { action: "webfetch", resource, effect: "deny" }], "https://example.com/x", "POST"),
        ).toEqual(["deny", "allow"])
    })
  })

  test("saves patterns that match only their own origin and method", () => {
    const [origin, post] = PermissionWeb.request("https://example.com/a", "POST").save

    expect(Wildcard.match("https://example.com/", origin)).toBe(true)
    expect(Wildcard.match("https://example.com/x/y?z=1", origin)).toBe(true)
    for (const other of [
      "https://example.com.evil.test/x",
      "https://example.comx/",
      "https://evil.test/https://example.com/",
      "http://example.com/x",
      "https://example.com:8443/x",
    ])
      expect(Wildcard.match(other, origin)).toBe(false)
    expect(Wildcard.match("POST https://example.com/x", post)).toBe(true)
    for (const other of ["GET https://example.com/x", "POST https://example.com.evil.test/x", "https://example.com/x"])
      expect(Wildcard.match(other, post)).toBe(false)
  })
})
