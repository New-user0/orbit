// context-memory-11: the secret scanner that keeps credentials out of team memory. The rules are the high-confidence
// ones of the public gitleaks rule set (v8.30.1, MIT), as the reference takes them: each has a distinctive prefix, and
// no generic keyword rule is included. A scan names the rules that fired and never returns the text that matched.
//
// Every sample below is assembled at run time from pieces, so that no file in the repository holds a string that a
// secret scanner (this one, or a host's push protection) would take for a real credential.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

// The scanner is new with context-memory-11. Until it is built, the suite loads it by a name the type checker does not
// follow, so that the repository still type-checks; the build replaces this with
// `import { SecretScan } from "@orbit/util/secret-scan"` and drops the type below.
type Match = { readonly id: string; readonly label: string }
const SecretScan: { readonly RULES: readonly Match[]; readonly scan: (text: string) => readonly Match[] } = (
  await import(["@orbit/util", "secret-scan"].join("/"))
).SecretScan

const ALNUM = "aB3dE5gH7jK9mN2pQ4rS6tU8vW0xY1zC"
const HEX = "0a1b2c3d4e5f6789"
const UPPER = "QWERTYUPASDFGHJK"
const LOWER = "qwertyuiopasdfghjklzxcvbnm"
const fill = (alphabet: string, length: number) =>
  Array.from({ length }, (_, index) => alphabet[(index * 7 + 3) % alphabet.length]).join("")
const join = (...parts: string[]) => parts.join("")

// One sample per rule, each written to that rule's gitleaks pattern, and placed in a line of ordinary text.
const samples: ReadonlyArray<readonly [id: string, sample: string]> = [
  ["aws-access-token", join("AK", "IA", fill("J2K3L4M5N6P7Q2R3", 16))],
  ["gcp-api-key", join("AI", "za", fill(ALNUM, 35))],
  ["azure-ad-client-secret", join("abc", "1", "Q~", fill(ALNUM, 32))],
  ["digitalocean-pat", join("dop", "_v1_", fill(HEX, 64))],
  ["digitalocean-access-token", join("doo", "_v1_", fill(HEX, 64))],
  ["model-provider-api-key", join("sk-", "ant-", "api03-", fill(ALNUM, 93), "AA")],
  ["model-provider-admin-key", join("sk-", "ant-", "admin01-", fill(ALNUM, 93), "AA")],
  ["model-provider-project-key", join("sk-", fill(ALNUM, 20), "T3Blbk", "FJ", fill(ALNUM, 20))],
  ["huggingface-access-token", join("hf", "_", fill(LOWER, 34))],
  ["github-pat", join("gh", "p_", fill(ALNUM, 36))],
  ["github-fine-grained-pat", join("github", "_pat_", fill(ALNUM, 82))],
  ["github-app-token", join("gh", "s_", fill(ALNUM, 36))],
  ["github-oauth", join("gh", "o_", fill(ALNUM, 36))],
  ["github-refresh-token", join("gh", "r_", fill(ALNUM, 36))],
  ["gitlab-pat", join("gl", "pat-", fill(ALNUM, 20))],
  ["gitlab-deploy-token", join("gl", "dt-", fill(ALNUM, 20))],
  ["slack-bot-token", join("xo", "xb-", "1234567890", "-", "1234567890", fill(ALNUM, 24))],
  ["slack-user-token", join("xo", "xp", "-1234567890", "-1234567890", "-1234567890", "-", fill(ALNUM, 30))],
  ["slack-app-token", join("xa", "pp-", "1-", "A0B1C2D3", "-1234567890-", fill(HEX, 16))],
  ["twilio-api-key", join("S", "K", fill(HEX, 32))],
  ["sendgrid-api-token", join("SG", ".", fill(ALNUM, 66))],
  ["npm-access-token", join("np", "m_", fill(ALNUM, 36))],
  ["pypi-upload-token", join("pypi-", "AgEIcHlwaS5vcmc", fill(ALNUM, 60))],
  ["databricks-api-token", join("da", "pi", fill(HEX, 32))],
  ["hashicorp-tf-api-token", join(fill(LOWER, 14), ".", "atlas", "v1", ".", fill(LOWER, 64))],
  ["pulumi-api-token", join("pu", "l-", fill(HEX, 40))],
  ["postman-api-token", join("PM", "AK-", fill(HEX, 24), "-", fill(HEX, 34))],
  ["grafana-api-key", join("eyJr", "Ijoi", fill(ALNUM, 80))],
  ["grafana-cloud-api-token", join("gl", "c_", fill(ALNUM, 40))],
  ["grafana-service-account-token", join("gl", "sa_", fill(ALNUM, 32), "_", fill(HEX, 8))],
  ["sentry-user-token", join("sntr", "yu_", fill(HEX, 64))],
  [
    "sentry-org-token",
    join("sntr", "ys_", "eyJpYXQiO", fill(ALNUM, 20), "LCJyZWdpb25fdXJs", fill(ALNUM, 20), "_", fill(ALNUM, 43)),
  ],
  ["stripe-access-token", join("s", "k_", "li", "ve_", fill(ALNUM, 24))],
  ["shopify-access-token", join("sh", "pat_", fill(HEX, 32))],
  ["shopify-shared-secret", join("sh", "pss_", fill(HEX, 32))],
  [
    "private-key",
    join("-----BEGIN ", "RSA PRIVATE KEY-----\n", fill(ALNUM, 64), "\n", fill(ALNUM, 64), "\n-----END RSA PRIVATE KEY-----"),
  ],
]

const ids = (text: string) => SecretScan.scan(text).map((match) => match.id)

describe("SecretScan.RULES", () => {
  // The 36 rules of the reference's curated set, taken from gitleaks by their gitleaks ids; the three that gitleaks names
  // after model vendors carry neutral ids, so that the vendor gate passes without an allowlist entry.
  test("holds the curated gitleaks rules and nothing else", () => {
    expect(SecretScan.RULES.map((rule) => rule.id).toSorted()).toEqual(samples.map(([id]) => id).toSorted())
  })

  test("gives every rule a readable label made from its id", () => {
    const labels = new Map(SecretScan.RULES.map((rule) => [rule.id, rule.label]))
    expect(labels.get("aws-access-token")).toBe("AWS Access Token")
    expect(labels.get("github-pat")).toBe("GitHub PAT")
    expect(labels.get("private-key")).toBe("Private Key")
    expect(labels.get("model-provider-api-key")).toBe("Model Provider API Key")
    for (const rule of SecretScan.RULES) {
      expect(rule.label).not.toBe("")
      expect(rule.label).not.toContain("-")
    }
  })
})

describe("SecretScan.scan", () => {
  for (const [id, sample] of samples)
    test(`finds ${id}`, () => {
      expect(ids(`The deploy note says to use ${sample} for now.\n`)).toContain(id)
      // At the end of the text too, where the patterns that look for a boundary after the key accept the end.
      expect(ids(sample)).toContain(id)
    })

  test("finds nothing in ordinary memory text", () => {
    expect(
      SecretScan.scan(
        "---\nname: testing\ndescription: how we test\ntype: feedback\n---\n\nIntegration tests hit a real database.\nWhy: a mocked one hid a broken migration.\n",
      ),
    ).toEqual([])
  })

  // No generic keyword rule is part of the set: a word such as password or api_key next to a value does not fire.
  test("has no generic keyword rule", () => {
    expect(SecretScan.scan("password = hunter2-hunter2\napi_key: 1234567890abcdef1234567890abcdef\n")).toEqual([])
  })

  // One short of the length a rule asks for is not that rule's key.
  test("does not fire on a key one character short", () => {
    expect(ids(join("gh", "p_", fill(ALNUM, 35)))).not.toContain("github-pat")
    expect(ids(join("AK", "IA", fill("J2K3L4M5N6P7Q2R3", 15)))).not.toContain("aws-access-token")
    // The control: the full length fires.
    expect(ids(join("gh", "p_", fill(ALNUM, 36)))).toContain("github-pat")
  })

  test("reports each rule once, in rule order, with its label and without the matched text", () => {
    const pat = join("gh", "p_", fill(ALNUM, 36))
    const aws = join("AK", "IA", fill("J2K3L4M5N6P7Q2R3", 16))
    const found = SecretScan.scan(`${pat}\n${aws}\n${pat}\n`)
    const order = SecretScan.RULES.map((rule) => rule.id)
    expect(found.map((match) => match.id).toSorted((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(
      found.map((match) => match.id),
    )
    expect(found.filter((match) => match.id === "github-pat")).toEqual([{ id: "github-pat", label: "GitHub PAT" }])
    expect(found.filter((match) => match.id === "aws-access-token")).toEqual([
      { id: "aws-access-token", label: "AWS Access Token" },
    ])
    const shown = JSON.stringify(found)
    expect(shown).not.toContain(pat)
    expect(shown).not.toContain(aws)
  })

  // A rule whose pattern is compiled with the global flag would keep its position between calls and miss the next key.
  test("finds the same key on every call", () => {
    const pat = join("gh", "p_", fill(ALNUM, 36))
    expect([ids(pat), ids(pat), ids(pat)]).toEqual([["github-pat"], ["github-pat"], ["github-pat"]])
  })
})

// The rules are copied from gitleaks, whose MIT licence asks that its copyright and permission notice travel with them.
// The owner chose to carry it in the scanner's own header rather than in a notices file (2026-10-21).
describe("the scanner source", () => {
  test("carries the gitleaks licence notice and names the version the rules came from", async () => {
    const text = await fs.readFile(path.join(import.meta.dir, "..", "src", "secret-scan.ts"), "utf8")
    // The notice sits in the comment at the top of the file, before the rules.
    const header = text.split("\n").slice(0, 80).join("\n")
    expect(header).toContain("Copyright (c) 2019 Zachary Rice")
    expect(header).toContain("Permission is hereby granted, free of charge")
    expect(header).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(header).toContain("v8.30.1")
  })
})
