import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SedScript } from "../src/shell/sed"
import { bash } from "./shell-analysis/helper"

// Differential test: real GNU sed against the emulator on a fixed, seeded corpus. Every row runs `sed -i` on one copy
// of the files and `plan` + `apply` on another, then compares bytes. It needs a GNU sed on PATH (Linux, or Git for
// Windows' sed): the oracle is the real program, never a table of expected output. Run it on Linux with tools/linux-test.

const sed = Bun.which("sed")
const probe = sed ? Bun.spawnSync([sed, "--version"], { cwd: os.tmpdir() }) : undefined
const gnu = probe !== undefined && SedScript.classify({ stdout: probe.stdout.toString(), code: probe.exitCode }, process.platform) === "gnu"
// MSYS_NO_PATHCONV and MSYS2_ARG_CONV_EXCL stop Git for Windows' runtime from rewriting a script such as `/c$/d` as a path.
const env = { ...process.env, LC_ALL: "C.UTF-8", MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }

// Files are LF only: on a CRLF file the emulator deliberately differs from Linux sed (pure tests pin those rows).
const files = [
  "a\nb\nc\nd\ne\nf\n",
  "abc\n",
  "",
  "x",
  "a\nb",
  "\n",
  "aaa bbb aaa\nfoo bar foobar\nbar\n",
  "$^{} a{2} a^b a$b\n(a) a+ a? a|b\n",
  "café au lait\nnaïve é\néé\n",
  "1 22 333\nabc123 def\n  lead\ttab\n",
  "aXbxAB\nAbC abc ABC\n",
  "a.b axb a*b\n\\ back \\\\ slash\n",
  "aab aaab ab b\nbaab\n",
  "Hello World\nhello world\n",
  "﻿bom line\nsecond\n",
  "😀 smile\nx😀y\n",
]

// Basic and extended spellings of one pattern.
const patterns: Array<[string, string]> = [
  ["a", "a"],
  ["ab*", "ab*"],
  ["a\\+", "a+"],
  ["a\\?b", "a?b"],
  ["a\\{2\\}", "a{2}"],
  ["a\\{1,2\\}", "a{1,2}"],
  ["a\\{2,\\}", "a{2,}"],
  ["[0-9]\\+", "[0-9]+"],
  ["[[:alpha:]]\\+", "[[:alpha:]]+"],
  ["[[:upper:]][[:lower:]]*", "[[:upper:]][[:lower:]]*"],
  ["[[:space:]]\\+", "[[:space:]]+"],
  ["^a", "^a"],
  ["a$", "a$"],
  ["^$", "^$"],
  ["x*", "x*"],
  ["b*", "b*"],
  ["a*", "a*"],
  ["[0-9]\\?", "[0-9]?"],
  [".", "."],
  [".*", ".*"],
  ["a.c", "a.c"],
  ["[^a]", "[^a]"],
  ["[]a]", "[]a]"],
  ["[^]a]", "[^]a]"],
  ["[a-c]\\+", "[a-c]+"],
  ["[a-]", "[a-]"],
  ["\\(a\\)\\(b\\)", "(a)(b)"],
  ["\\(a*\\)\\(a*\\)", "(a*)(a*)"],
  ["\\(.\\)\\(.\\)", "(.)(.)"],
  ["\\(a\\)", "(a)"],
  ["a\\?[ab]\\?b\\{0,2\\}", "a?[ab]?b{0,2}"],
  ["\\w\\+", "\\w+"],
  ["\\W", "\\W"],
  ["\\s", "\\s"],
  ["\\S\\+", "\\S+"],
  ["\\bfoo", "\\bfoo"],
  ["\\Bar", "\\Bar"],
  ["\\<bar\\>", "\\<bar\\>"],
  ["o\\+", "o+"],
  ["a^b", "a\\^b"],
  ["a$b", "a\\$b"],
  ["{", "\\{"],
  ["a{2}", "a\\{2\\}"],
  ["(a)", "\\(a\\)"],
  ["a+", "a\\+"],
  ["a?", "a\\?"],
  ["\\.", "\\."],
  ["[.]", "[.]"],
  ["\\*", "\\*"],
  ["\\\\", "\\\\"],
  ["caf.", "caf."],
  ["[^a-z ]", "[^a-z ]"],
  ["\\`a", "\\`a"],
  ["a\\'", "a\\'"],
  ["^\\(.\\)", "^(.)"],
  ["\\(.\\)$", "(.)$"],
  ["l.*e", "l.*e"],
  ["o.*o.*o", "o.*o.*o"],
]
const replacements = ["X", "", "[&]", "<\\1>", "\\2\\1", "\\n", "\\t", "$1", "&&", "\\&", "a b", "\\\\", "-\\1-\\2-", "$&"]
const flags = ["", "", "g", "g", "2", "3", "2g", "3g", "I", "i", "Ig", "gI", "g2"]
const addresses = ["", "", "", "1", "2", "3", "$", "/a/", "/^b/", "/c$/", "2,3", "2,$", "1,1", "4,2", "3,5", "1,$", "$"]

// A fixed seed, so a failure is reproducible and the corpus is the same on every machine.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

type Row = { label: string; options: string[]; scripts: string[]; files: number[] }

function corpus() {
  const next = random(0xc0ffee)
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]
  const rows: Row[] = []
  // Measured cases from the spec, each with the file that shows it.
  const hand: Array<[string[], string[], number[]]> = [
    [[], ["s/x*/-/g"], [1]],
    [[], ["s/b*/-/g"], [1]],
    [["-E"], ["s/[0-9]?/X/g"], [9]],
    [[], ["s/b*/-/2"], [1]],
    [[], ["s/b*/-/3"], [1]],
    [[], ["s/b*/-/2g"], [1]],
    [[], ["s/a*/-/2"], [12]],
    [[], ["s/a/-/2"], [12]],
    [[], ["s/a/-/3g"], [12]],
    [[], ["s/x*/-/g"], [15]],
    [[], ["s/./X/g"], [8]],
    [[], ["s/\\s/X/g;s/\\S/Y/"], [14]],
    [[], ["s/^/x/"], [2]],
    [[], ["s/^/x/"], [14]],
    [[], ["s/a^b/X/"], [7]],
    [[], ["s/a$b/X/"], [7]],
    [[], ["s/a{2}/X/"], [7]],
    [["-E"], ["s/a\\{2\\}/X/"], [7]],
    [[], ["s/b/$1/"], [1]],
    [[], ["$d"], [4]],
    [[], ["$d"], [0]],
    [[], ["s/a/b/"], [3]],
    [[], ["/b/d;2,3s/./X/"], [0]],
    [[], ["/b/d;/c/d;2,3s/./X/"], [0]],
    [[], ["4,2d"], [0]],
    [[], ["/d/d;4,2s/./X/"], [0]],
    [[], ["/b/d;2,$s/./X/"], [0]],
    [[], ["5,$d"], [4]],
    [[], ["s/a/x\\ny/;/y/d"], [0]],
    [[], ["/b/s/b/B/;/B/d"], [0]],
    [[], ["$d", "1d"], [0, 4]],
    [[], ["2,3d"], [0, 6]],
    [[], ["s/a/aa/"], [1, 6]],
    [["-E"], ["s/(ab)/X/"], [1]],
    [[], ["s|a\\|b|X|g"], [10]],
  ]
  for (const [options, scripts, indexes] of hand) rows.push({ label: `${options.join(" ")} ${scripts.join(" ; ")}`, options, scripts, files: indexes })
  for (let count = 0; count < 1500; count++) {
    const extended = next() < 0.4
    const scripts = Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
      const address = pick(addresses)
      if (next() < 0.2) return `${address}d`
      const [bre, ere] = pick(patterns)
      const delimiter = pick(["/", "/", "/", "#", "|"])
      const pattern = (extended ? ere : bre).replaceAll("/", `\\${delimiter}`)
      if (delimiter !== "/" && pattern.includes(delimiter)) return `${address}s/x/y/`
      const replacement = pick(replacements)
      return `${address}s${delimiter}${pattern}${delimiter}${replacement}${delimiter}${pick(flags)}`
    })
    const first = Math.floor(next() * files.length)
    const second = (first + 1 + Math.floor(next() * (files.length - 1))) % files.length
    rows.push({ label: "generated", options: extended ? ["-E"] : [], scripts, files: next() < 0.2 ? [first, second] : [first] })
  }
  return rows
}

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
const directories: string[] = []
afterAll(() => directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))

describe("SedScript against GNU sed", () => {
  test.skipIf(!gnu)(
    "the emulator writes the bytes GNU sed writes",
    () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sed-gnu-"))
      directories.push(directory)
      let compared = 0
      let refused = 0
      const mismatches: string[] = []
      for (const [index, row] of corpus().entries()) {
        const names = row.files.map((file) => `f${file}.txt`)
        const words = ["-i", ...row.options, ...(row.scripts.length === 1 && index % 2 === 0 ? [row.scripts[0]] : row.scripts.flatMap((script) => ["-e", script])), ...names]
        const planned = SedScript.plan(bash(["sed", ...words].map(quote).join(" ")), "gnu")
        if (!planned.ok) {
          refused++
          continue
        }
        const texts = row.files.map((file) => files[file])
        const applied = texts.map((text) => SedScript.apply(text, planned.edit))
        if (applied.some((result) => !result.ok)) {
          refused++
          continue
        }
        names.forEach((name, position) => fs.writeFileSync(path.join(directory, name), texts[position]))
        // The scripts go in a file: the MSYS runtime re-parses a command line's backslashes and braces, and -e scripts are
        // joined with newlines by sed anyway, so `-f` runs the same program.
        fs.writeFileSync(path.join(directory, "script.sed"), row.scripts.join("\n") + "\n")
        const real = Bun.spawnSync([sed!, "-i", ...row.options, "-f", "script.sed", ...names], { cwd: directory, env })
        const expected = names.map((name) => fs.readFileSync(path.join(directory, name)))
        const got = applied.map((result) => Buffer.from(result.ok ? result.text : "", "utf8"))
        const same = real.exitCode === 0 && expected.every((bytes, position) => bytes.equals(got[position]))
        if (!same) mismatches.push(`${JSON.stringify(words)} on ${JSON.stringify(texts)} -> sed(${real.exitCode}) ${JSON.stringify(expected.map(String))} emulator ${JSON.stringify(got.map(String))}`)
        compared++
      }
      expect(mismatches).toEqual([])
      // The test must not pass because `plan` started refusing everything (class 14).
      expect(compared).toBeGreaterThanOrEqual(500)
      expect(refused).toBeLessThan(compared)
      expect(compared + refused).toBe(1535)
    },
    240_000,
  )

  test("the corpus is fixed", () => {
    const rows = corpus()
    expect(rows).toHaveLength(1535)
    expect(rows[40]).toEqual(corpus()[40])
  })
})
