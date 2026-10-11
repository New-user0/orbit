import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { Duration, Effect, Layer, PlatformError, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { SedScript } from "../../src/shell/sed"
import { bash } from "./helper"

// plan() decides which in-place sed commands Orbit computes itself; apply() computes one file's new text. Every refusal
// is a fixed reason code. The differential test against real GNU sed is test/shell-sed-gnu.test.ts.

function planned(command: string, flavor: SedScript.Flavor = "gnu") {
  return SedScript.plan(bash(command), flavor)
}

function edit(command: string, flavor: SedScript.Flavor = "gnu") {
  const result = planned(command, flavor)
  if (!result.ok) throw new Error(`refused (${result.reason}): ${command}`)
  return result.edit
}

// The text of `sed -i <script>` applied to `text`, or the refusal reason.
function run(script: string, text: string, options = "") {
  const result = SedScript.apply(text, edit(`sed -i ${options} '${script.replaceAll("'", "'\\''")}' f`))
  return result.ok ? result.text : result.reason
}

describe("SedScript.plan accepts", () => {
  const rows: Array<[string, string, SedScript.Flavor, string[]]> = [
    ["a plain substitution", "sed -i 's/a/b/' f", "gnu", ["f"]],
    ["--in-place, two -e scripts, two files", "sed --in-place -e 's/a/b/' -e '3d' f g", "gnu", ["f", "g"]],
    ["-Ei", "sed -Ei 's/a+/b/' f", "gnu", ["f"]],
    ["-ri", "sed -ri 's/a+/b/' f", "gnu", ["f"]],
    ["-si", "sed -si 's/a/b/' f", "gnu", ["f"]],
    ["-Esi", "sed -Esi 's/a+/b/' f", "gnu", ["f"]],
    ["--expression=", "sed -i --expression=s/a/b/ f", "gnu", ["f"]],
    ["--expression with a separate script", "sed -i --expression 's/a/b/' f", "gnu", ["f"]],
    ["a file named like an option after --", "sed -i -- 's/a/b/' -x", "gnu", ["-x"]],
    ["-E before -i", "sed -E -i 's/(a)b/\\1/' f", "gnu", ["f"]],
    ["--regexp-extended", "sed --regexp-extended -i 's/a+/b/' f", "gnu", ["f"]],
    ["BSD -i ''", "sed -i '' 's/a/b/' f", "bsd", ["f"]],
    ["BSD -i '' -e", "sed -i '' -e 's/a/b/' f", "bsd", ["f"]],
    ["BSD -Ei ''", "sed -Ei '' 's/a+/b/' f", "bsd", ["f"]],
    ["BSD -E -i ''", "sed -E -i '' 's/a+/b/' f", "bsd", ["f"]],
  ]
  test.each(rows)("%s", (_, command, flavor, files) => {
    expect(edit(command, flavor).files).toEqual(files)
  })

  test("-E, -r and --regexp-extended switch the syntax", () => {
    expect(edit("sed -Ei 's/a/b/' f").extended).toBe(true)
    expect(edit("sed -i -r 's/a/b/' f").extended).toBe(true)
    expect(edit("sed -i 's/a/b/' f").extended).toBe(false)
  })
})

describe("SedScript.plan refuses", () => {
  const rows: Array<[string, string, SedScript.Flavor, string]> = [
    // Flavor
    ["an unknown flavor", "sed -i 's/a/b/' f", "unknown", "sed-edit:flavor"],
    ["GNU -i.bak", "sed -i.bak 's/a/b/' f", "gnu", "sed-edit:backup"],
    ["GNU --in-place=.bak", "sed --in-place=.bak 's/a/b/' f", "gnu", "sed-edit:backup"],
    ["GNU --in-place= (an empty suffix)", "sed --in-place= 's/a/b/' f", "gnu", "sed-edit:backup"],
    ["GNU -ie (the suffix e)", "sed -ie 's/a/b/' f", "gnu", "sed-edit:backup"],
    ["GNU -iE (the suffix E)", "sed -iE 's/a/b/' f", "gnu", "sed-edit:backup"],
    ["GNU long option abbreviation", "sed --in-pl 's/a/b/' f", "gnu", "sed-edit:option"],
    ["GNU abbreviated --exp=", "sed -i --exp=s/a/b/ f", "gnu", "sed-edit:option"],
    ["GNU -i '' (the empty script)", "sed -i '' 's/a/b/' f", "gnu", "sed-edit:syntax"],
    ["BSD -i with the script as the suffix", "sed -i 's/a/b/' f", "bsd", "sed-edit:backup"],
    ["BSD -i -e (-e as the suffix)", "sed -i -e 's/a/b/' f", "bsd", "sed-edit:backup"],
    ["BSD -i'' (the quotes vanish)", "sed -i'' 's/a/b/' f", "bsd", "sed-edit:backup"],
    ["BSD --in-place", "sed --in-place 's/a/b/' f", "bsd", "sed-edit:option"],
    ["BSD -si", "sed -si '' 's/a/b/' f", "bsd", "sed-edit:option"],
    ["BSD -i with a suffix", "sed -i .bak 's/a/b/' f", "bsd", "sed-edit:backup"],
    // Options
    ["-n", "sed -n -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["-z", "sed -z -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["--posix", "sed --posix -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["-f", "sed -i -f s.sed f", "gnu", "sed-edit:option"],
    ["--follow-symlinks", "sed --follow-symlinks -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["-u", "sed -u -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["-l 5", "sed -l 5 -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["-b", "sed -b -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["--sandbox", "sed --sandbox -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["--debug", "sed --debug -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["--null-data", "sed --null-data -i 's/a/b/' f", "gnu", "sed-edit:option"],
    ["--version", "sed --version", "gnu", "sed-edit:option"],
    ["-eSCRIPT attached", "sed -i -es/a/b/ f", "gnu", "sed-edit:option"],
    ["an option after an operand", "sed 's/a/b/' -i f", "gnu", "sed-edit:option"],
    ["a missing -e script", "sed -i -e", "gnu", "sed-edit:option"],
    ["not in place", "sed 's/a/b/' f", "gnu", "sed-edit:option"],
    // Operands
    ["no file", "sed -i 's/a/b/'", "gnu", "sed-edit:operand"],
    ["no file with -e", "sed -i -e 's/a/b/'", "gnu", "sed-edit:operand"],
    ["- as a file", "sed -i 's/a/b/' -", "gnu", "sed-edit:operand"],
    ["an empty file name", "sed -i 's/a/b/' ''", "gnu", "sed-edit:operand"],
    ["the same file twice", "sed -i 's/a/b/' f f", "gnu", "sed-edit:operand"],
    ["a glob", "sed -i 's/a/b/' *.txt", "gnu", "sed-edit:operand"],
    ["a tilde", "sed -i 's/a/b/' ~/f", "gnu", "sed-edit:operand"],
    ["a tilde after = (bash expands it)", "sed -i 's/a/b/' f=~/x", "gnu", "sed-edit:operand"],
    ["a tilde after a : in an assignment-like word", "sed -i 's/a/b/' g=a:~/y", "gnu", "sed-edit:operand"],
    // The analysis itself calls these opaque or non-literal, so they are refused as a shape.
    ['a variable "$f"', 'sed -i \'s/a/b/\' "$f"', "gnu", "sed-edit:shape"],
    ["a brace expansion", "sed -i 's/a/b/' {a,b}.txt", "gnu", "sed-edit:shape"],
    ["a command substitution operand", "sed -i 's/a/b/' $(cat x)", "gnu", "sed-edit:shape"],
    ["a backslash in a file name", "sed -i 's/a/b/' a\\ b", "gnu", "sed-edit:shape"],
    // Shape
    ["a redirect", "sed -i 's/a/b/' f > out", "gnu", "sed-edit:shape"],
    ["a null redirect", "sed -i 's/a/b/' f 2>/dev/null", "gnu", "sed-edit:shape"],
    ["a pipe after", "sed -i 's/a/b/' f | cat", "gnu", "sed-edit:shape"],
    ["a pipe before", "cat f | sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["a following command", "sed -i 's/a/b/' f && echo done", "gnu", "sed-edit:shape"],
    ["a preceding command", "echo hi; sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["a background job", "sed -i 's/a/b/' f &", "gnu", "sed-edit:shape"],
    ["a negation", "! sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["an environment prefix", "LC_ALL=C sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["env", "env sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["command", "command sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["an absolute path", "/usr/bin/sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["a relative path", "./sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["a subshell", "(sed -i 's/a/b/' f)", "gnu", "sed-edit:shape"],
    ["a loop", "for x in a; do sed -i 's/a/b/' f; done", "gnu", "sed-edit:shape"],
    ["a herestring", "sed -i 's/a/b/' f <<< x", "gnu", "sed-edit:shape"],
    ["a variable assignment before", "x=1; sed -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    ["a command that is not sed", "echo -i 's/a/b/' f", "gnu", "sed-edit:shape"],
    // Commands
    ["p", "sed -i 'p' f", "gnu", "sed-edit:command"],
    ["q", "sed -i 'q' f", "gnu", "sed-edit:command"],
    ["=", "sed -i '=' f", "gnu", "sed-edit:command"],
    ["l", "sed -i 'l' f", "gnu", "sed-edit:command"],
    ["n", "sed -i 'n' f", "gnu", "sed-edit:command"],
    ["y", "sed -i 'y/a/b/' f", "gnu", "sed-edit:command"],
    ["a", "sed -i 'a x' f", "gnu", "sed-edit:command"],
    ["w", "sed -i 'w out' f", "gnu", "sed-edit:command"],
    ["e", "sed -i 'e id' f", "gnu", "sed-edit:command"],
    ["r", "sed -i 'r f' f", "gnu", "sed-edit:command"],
    ["R", "sed -i 'R f' f", "gnu", "sed-edit:command"],
    ["W", "sed -i 'W f' f", "gnu", "sed-edit:command"],
    ["a block", "sed -i '1{d}' f", "gnu", "sed-edit:block"],
    ["negation", "sed -i '1!d' f", "gnu", "sed-edit:negation"],
    ["a newline in the script", "sed -i 's/a/b/\nd' f", "gnu", "sed-edit:newline"],
    ["an ANSI-C quoted script", "sed -i $'s/a/b/\\nd' f", "gnu", "sed-edit:shape"],
    // Flags
    ["s///w", "sed -i 's/a/b/w out' f", "gnu", "sed-edit:flag"],
    ["s///e", "sed -i 's/a/b/e' f", "gnu", "sed-edit:flag"],
    ["s///p", "sed -i 's/a/b/p' f", "gnu", "sed-edit:flag"],
    ["s///m", "sed -i 's/a/b/m' f", "gnu", "sed-edit:flag"],
    ["s///M", "sed -i 's/a/b/M' f", "gnu", "sed-edit:flag"],
    ["s///G (sed rejects it)", "sed -i 's/a/b/G' f", "gnu", "sed-edit:flag"],
    ["s///P (sed rejects it)", "sed -i 's/a/b/P' f", "gnu", "sed-edit:flag"],
    ["s///2P", "sed -i 's/a/b/2P' f", "gnu", "sed-edit:flag"],
    ["BSD s///G", "sed -i '' 's/a/b/G' f", "bsd", "sed-edit:flag"],
    ["BSD s///P", "sed -i '' 's/a/b/P' f", "bsd", "sed-edit:flag"],
    ["BSD s///2g (BSD rejects a number with g)", "sed -i '' 's/a/b/2g' f", "bsd", "sed-edit:flag"],
    ["BSD s///g2", "sed -i '' 's/a/b/g2' f", "bsd", "sed-edit:flag"],
    // Addresses
    ["a range that starts with a regex", "sed -i '/x/,$d' f", "gnu", "sed-edit:address"],
    ["a range that starts at $", "sed -i '$,3d' f", "gnu", "sed-edit:address"],
    ["first~step", "sed -i '1~2d' f", "gnu", "sed-edit:address"],
    ["0,/re/", "sed -i '0,/x/d' f", "gnu", "sed-edit:address"],
    ["addr,+N", "sed -i '2,+1d' f", "gnu", "sed-edit:address"],
    ["/re/I", "sed -i '/x/Id' f", "gnu", "sed-edit:address"],
    ["N,/re/", "sed -i '2,/x/d' f", "gnu", "sed-edit:address"],
    // Regular expressions
    ["BRE alternation", "sed -i 's/a\\|b/x/' f", "gnu", "sed-edit:regex"],
    ["ERE alternation", "sed -Ei 's/a|b/x/' f", "gnu", "sed-edit:regex"],
    ["a quantified BRE group", "sed -i 's/\\(ab\\)*/x/' f", "gnu", "sed-edit:regex"],
    ["a quantified ERE group", "sed -Ei 's/(ab)+/x/' f", "gnu", "sed-edit:regex"],
    ["an interval on a group", "sed -Ei 's/(a){2}/x/' f", "gnu", "sed-edit:regex"],
    ["a back-reference in a pattern", "sed -i 's/\\(a\\)\\1/x/' f", "gnu", "sed-edit:regex"],
    ["an equivalence class", "sed -i 's/[[=a=]]/x/' f", "gnu", "sed-edit:regex"],
    ["a collating symbol", "sed -i 's/[[.a.]]/x/' f", "gnu", "sed-edit:regex"],
    ["the empty regex", "sed -i 's//x/' f", "gnu", "sed-edit:regex"],
    ["an empty address regex", "sed -i '//d' f", "gnu", "sed-edit:regex"],
    ["a stacked quantifier a*\\?", "sed -i 's/a*\\?/x/' f", "gnu", "sed-edit:regex"],
    ["a stacked quantifier a**", "sed -i 's/a**/x/' f", "gnu", "sed-edit:regex"],
    ["an interval after a star", "sed -i 's/a*\\{2\\}/x/' f", "gnu", "sed-edit:regex"],
    ["a quantifier on an anchor", "sed -Ei 's/^*a/x/' f", "gnu", "sed-edit:regex"],
    ["a quantifier on a word boundary", "sed -i 's/\\b*a/x/' f", "gnu", "sed-edit:regex"],
    ["a leading star", "sed -i 's/*a/x/' f", "gnu", "sed-edit:regex"],
    ["a star after ^", "sed -i 's/^*a/x/' f", "gnu", "sed-edit:regex"],
    ["an interval with no minimum", "sed -i 's/a\\{,2\\}/x/' f", "gnu", "sed-edit:regex"],
    ["an interval with min above max", "sed -i 's/a\\{3,2\\}/x/' f", "gnu", "sed-edit:regex"],
    ["an interval above RE_DUP_MAX", "sed -i 's/a\\{40000\\}/x/' f", "gnu", "sed-edit:regex"],
    ["an unclosed interval", "sed -i 's/a\\{2/x/' f", "gnu", "sed-edit:regex"],
    ["a bare { in ERE", "sed -Ei 's/a{/x/' f", "gnu", "sed-edit:regex"],
    ["an unbalanced group", "sed -i 's/\\(a/x/' f", "gnu", "sed-edit:regex"],
    ["an unmatched close", "sed -Ei 's/a)/x/' f", "gnu", "sed-edit:regex"],
    ["a backslash in brackets", "sed -i 's/[\\n]/x/' f", "gnu", "sed-edit:regex"],
    ["an unterminated bracket", "sed -i 's/[a/x/' f", "gnu", "sed-edit:regex"],
    ["a reversed range", "sed -i 's/[z-a]/x/' f", "gnu", "sed-edit:regex"],
    ["an unknown class", "sed -i 's/[[:nope:]]/x/' f", "gnu", "sed-edit:regex"],
    ["a class named like an Object.prototype key", "sed -i 's/[[:constructor:]]/x/' f", "gnu", "sed-edit:regex"],
    ["a class named __proto__", "sed -i 's/[[:__proto__:]]/x/' f", "gnu", "sed-edit:regex"],
    ["a class named toString", "sed -i 's/[[:toString:]]/x/' f", "gnu", "sed-edit:regex"],
    ["a range that mixes cases (locale dependent)", "sed -i 's/[A-c]/x/' f", "gnu", "sed-edit:regex"],
    ["a range that mixes digits and letters", "sed -i 's/[0-z]/x/' f", "gnu", "sed-edit:regex"],
    ["a punctuation range (locale dependent)", "sed -i 's/[ -~]/x/' f", "gnu", "sed-edit:regex"],
    ["\\r", "sed -i 's/\\r//' f", "gnu", "sed-edit:regex"],
    ["\\x41", "sed -i 's/\\x41/x/' f", "gnu", "sed-edit:regex"],
    ["\\n in a pattern", "sed -i 's/\\n/x/' f", "gnu", "sed-edit:regex"],
    ["\\t in a pattern", "sed -i 's/\\t/x/' f", "gnu", "sed-edit:regex"],
    ["an escaped letter with no meaning", "sed -i 's/\\q/x/' f", "gnu", "sed-edit:regex"],
    ["an escaped | in ERE", "sed -Ei 's/a\\|b/x/' f", "gnu", "sed-edit:regex"],
    ["a bare } in ERE", "sed -Ei 's/a}/x/' f", "gnu", "sed-edit:regex"],
    // Delimiters
    ["an escaped . delimiter", "sed -i 's.a\\.b.X.' f", "gnu", "sed-edit:delimiter"],
    ["an escaped * delimiter", "sed -i 's*a\\*b*X*' f", "gnu", "sed-edit:delimiter"],
    ["an escaped | delimiter in ERE", "sed -Ei 's|a\\|b|X|' f", "gnu", "sed-edit:delimiter"],
    ["an escaped letter delimiter", "sed -i 'sxa\\xbxXx' f", "gnu", "sed-edit:delimiter"],
    ["an escaped & delimiter in the replacement", "sed -i 's&a&b\\&c&' f", "gnu", "sed-edit:delimiter"],
    // Replacements
    ["\\U", "sed -i 's/a/\\U&/' f", "gnu", "sed-edit:replacement"],
    ["\\L", "sed -i 's/a/\\L&/' f", "gnu", "sed-edit:replacement"],
    ["\\0", "sed -i 's/a/\\0/' f", "gnu", "sed-edit:replacement"],
    ["a group the pattern does not have", "sed -i 's/a/\\1/' f", "gnu", "sed-edit:replacement"],
    ["a group above the count", "sed -i 's/\\(a\\)/\\2/' f", "gnu", "sed-edit:replacement"],
    ["\\r in a replacement", "sed -i 's/a/\\r/' f", "gnu", "sed-edit:replacement"],
    ["an escaped letter in a replacement", "sed -i 's/a/\\q/' f", "gnu", "sed-edit:replacement"],
    ["an escaped / when the delimiter is #", "sed -i 's#a#\\/#' f", "gnu", "sed-edit:replacement"],
    // BSD limits
    ["BSD \\+", "sed -i '' 's/a\\+/x/' f", "bsd", "sed-edit:regex"],
    ["BSD \\?", "sed -i '' 's/a\\?/x/' f", "bsd", "sed-edit:regex"],
    ["BSD \\w", "sed -i '' 's/\\w/x/' f", "bsd", "sed-edit:regex"],
    ["BSD \\b", "sed -i '' 's/\\bx/x/' f", "bsd", "sed-edit:regex"],
    ["BSD \\<", "sed -i '' 's/\\<x/x/' f", "bsd", "sed-edit:regex"],
    ["BSD \\n in a replacement", "sed -i '' 's/a/x\\ny/' f", "bsd", "sed-edit:replacement"],
    ["BSD \\t in a replacement", "sed -i '' 's/a/x\\ty/' f", "bsd", "sed-edit:replacement"],
  ]
  test.each(rows)("%s", (_, command, flavor, reason) => {
    const result = planned(command, flavor)
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.reason).toBe(reason)
  })

  test("a refusal never carries script, file or option text", () => {
    const secret = "SECRET_TOKEN_9f3a"
    const commands = [`sed -i 's/${secret}/b\\q/' f`, `sed -i.${secret} 's/a/b/' f`, `sed -i '${secret}' f`, `sed -i 's/a/b/' ${secret}.txt ${secret}.txt`]
    for (const command of commands) {
      const result = planned(command)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(result.ok ? "" : result.reason).toMatch(/^sed-edit:[a-z-]+$/)
    }
  })
})

describe("SedScript.plan escaped delimiters", () => {
  // Measured against GNU sed: the escaped delimiter becomes the bare character before the pattern is compiled.
  const rows: Array<[string, string, string, string, string]> = [
    ["| in BRE is a literal |", "s|a\\|b|X|g", "", "a|b a", "X a"],
    ["# is a literal #", "s#a\\#b#X#", "", "a#b", "X"],
    ["a comma", "s,a\\,b,X,", "", "a,b", "X"],
    ["a colon", "s:a\\:b:X:", "", "a:b", "X"],
    ["- is a literal -", "s-a\\-b-X-", "", "a-b", "X"],
    ["a delimiter that is never escaped", "sxaxbx", "", "aaa", "baa"],
    ["a delimiter in the replacement", "s,a,x\\,y,", "", "a", "x,y"],
    ["| in the replacement of an ERE", "s|a|x\\|y|", "-E", "a", "x|y"],
  ]
  test.each(rows)("%s", (_, script, options, text, expected) => {
    expect(run(script, text, options)).toBe(expected)
  })
})

describe("SedScript.apply substitutions", () => {
  // The first nine rows are measured results of GNU sed 4.9.
  const rows: Array<[string, string, string, string, string]> = [
    ["an empty match everywhere", "s/x*/-/g", "", "abc", "-a-b-c-"],
    ["no empty match right after a match", "s/b*/-/g", "", "abc", "-a-c-"],
    ["an optional ERE atom", "s/[0-9]?/X/g", "-E", "a1", "XaX"],
    ["the 2nd empty-or-not match", "s/b*/-/2", "", "abc", "a-c"],
    ["the 3rd match, after the text", "s/b*/-/3", "", "abc", "abc-"],
    ["Ng from the 2nd", "s/b*/-/2g", "", "abc", "a-c-"],
    ["the 2nd match at the end", "s/a*/-/2", "", "ab", "ab-"],
    ["the 2nd literal", "s/a/-/2", "", "aXa", "aX-"],
    ["3g", "s/a/-/3g", "", "aaaa", "aa--"],
    ["g2 is 2g", "s/a/-/g2", "", "aaaa", "a---"],
    ["the first match only", "s/a/b/", "", "aaa", "baa"],
    ["g", "s/a/b/g", "", "aaa", "bbb"],
    ["a number past the matches", "s/a/b/5", "", "aaa", "aaa"],
    ["I", "s/abc/X/I", "", "ABC", "X"],
    ["i", "s/abc/X/i", "", "ABC", "X"],
    ["I and g", "s/b/X/Ig", "", "aBb", "aXX"],
    ["BRE \\+", "s/a\\+/X/", "", "baaa", "bX"],
    ["ERE +", "s/a+/X/", "-E", "baaa", "bX"],
    ["BRE \\? and \\{n\\}", "s/ab\\?c\\{2\\}/X/", "", "xaccy", "xXy"],
    ["BRE \\{2\\}", "s/a\\{2\\}/X/", "", "aaa", "Xa"],
    ["ERE {2}", "s/a{2}/X/", "-E", "aaa", "Xa"],
    ["ERE {2,}", "s/a{2,}/X/", "-E", "aaaa", "X"],
    ["ERE {1,2}", "s/a{1,2}/X/g", "-E", "aaaaa", "XXX"],
    ["BRE a{2} is literal", "s/a{2}/X/", "", "aa a{2}", "aa X"],
    ["ERE a\\{2\\} is literal", "s/a\\{2\\}/X/", "-E", "aa a{2}", "aa X"],
    ["BRE (a) is literal", "s/(a)/X/", "", "a (a)", "a X"],
    ["ERE \\(a\\) is literal", "s/\\(a\\)/X/", "-E", "a (a)", "a X"],
    ["BRE + and ? are literal", "s/a+b?/X/", "", "aab a+b?", "aab X"],
    ["BRE | is literal", "s/a|b/X/", "", "a|b", "X"],
    ["a mid-pattern ^ is literal in BRE", "s/a^b/X/", "", "a^b", "X"],
    ["a mid-pattern $ is literal in BRE", "s/a$b/X/", "", "a$b", "X"],
    ["^ anchors at the start", "s/^a/X/g", "", "aaa", "Xaa"],
    ["$ anchors at the end", "s/a$/X/g", "", "aaa", "aaX"],
    ["^ after \\( anchors", "s/\\(^a\\)/X/", "", "aa", "Xa"],
    ["$ before \\) anchors", "s/\\(a$\\)/X/", "", "aa", "aX"],
    ["\\` is the start", "s/\\`a/X/g", "", "aaa", "Xaa"],
    ["\\' is the end", "s/a\\'/X/g", "", "aaa", "aaX"],
    ["]a at the start of a bracket", "s/[]a]/X/g", "", "]ab", "XXb"],
    ["[^]a]", "s/[^]a]/X/g", "", "]ab", "]aX"],
    ["[[:digit:]]", "s/[[:digit:]]\\+/N/g", "", "a12b3", "aNbN"],
    ["[a-c]", "s/[a-c]/X/g", "", "abcd", "XXXd"],
    ["a - last in brackets", "s/[a-]/X/g", "", "a-b", "XXb"],
    ["a - first in brackets", "s/[-a]/X/g", "", "a-b", "XXb"],
    ["[[:alpha:][:digit:]]", "s/[[:alpha:][:digit:]]/X/g", "", "a1-", "XX-"],
    ["a [ inside brackets", "s/[[]/X/g", "", "a[b", "aXb"],
    ["\\w\\+", "s/\\w\\+/X/g", "", "ab_1 cd", "X X"],
    ["\\W", "s/\\W/X/g", "", "a b", "aXb"],
    ["\\s", "s/\\s/X/g", "", "a b\tc", "aXbXc"],
    ["\\S", "s/\\S/X/g", "", "a b", "X X"],
    ["\\b", "s/\\bbar/X/g", "", "bar foobar bar", "X foobar X"],
    ["\\<\\>", "s/\\<bar\\>/X/g", "", "bar foobar bar", "X foobar X"],
    ["& is the match", "s/b\\+/[&]/", "", "abbc", "a[bb]c"],
    ["\\& is a literal &", "s/b/\\&/", "", "abc", "a&c"],
    ["a group", "s/\\(b\\)/<\\1>/", "", "abc", "a<b>c"],
    ["a swap", "s/\\(a\\)\\(b\\)/\\2\\1/", "", "xaby", "xbay"],
    ["ERE groups", "s/(a)(b)/\\2\\1/", "-E", "xaby", "xbay"],
    ["a group that did not take part", "s/\\(a*\\)\\(b\\)/[\\1\\2]/", "", "b", "[b]"],
    ["adjacent unquantified groups", "s/\\(a*\\)\\(a*\\)/\\2\\1-/", "", "aaa", "aaa-"],
    ["\\n in a replacement", "s/b/\\n/", "", "abc", "a\nc"],
    ["\\t in a replacement", "s/b/\\t/", "", "abc", "a\tc"],
    ["\\\\ in a replacement", "s/b/\\\\/", "", "abc", "a\\c"],
    ["\\/ in a replacement", "s/b/\\//", "", "abc", "a/c"],
    ["$1 is literal", "s/b/$1/", "", "abc", "a$1c"],
    ["$ before & is a literal $", "s/b/$&/", "", "abc", "a$bc"],
    ["$$ is literal", "s/b/$$/", "", "abc", "a$$c"],
    ["a dollar in the pattern", "s/\\$/D/", "", "a$b", "aDb"],
    ["an escaped slash in the pattern", "s/a\\/b/X/", "", "a/b", "X"],
    ["a backslash in the pattern", "s/\\\\/X/", "", "a\\b", "aXb"],
    ["escaped syntax characters", "s/\\.\\*\\[\\]\\^/X/", "", "a.*[]^", "aX"],
    ["a dot is any character", "s/./X/g", "", "a.é", "XXX"],
    ["a dot after an inserted newline", "s/b/\\n/;s/./X/g", "", "abc", "XXX"],
    ["an empty replacement", "s/b//", "", "abc", "ac"],
    ["an empty match at the end of a line", "s/$/!/", "", "a\nb", "a!\nb!"],
    ["an empty match at the start of a line", "s/^/> /", "", "a\nb", "> a\n> b"],
    // Measured: GNU sed 4.9 copies one byte after an empty match, so it writes half of a multi-byte character. The
    // emulator never writes invalid UTF-8; it refuses instead.
    ["an empty match before a surrogate pair is refused", "s/x*/-/g", "", "😀", "sed-edit:content"],
    ["an empty match before a 2-byte character is refused", "s/x*/-/g", "", "é", "sed-edit:content"],
    ["a rejected adjacent empty match before a non-ASCII character is refused", "s/b*/-/g", "", "bé", "sed-edit:content"],
    ["a skipped empty match before a non-ASCII character is refused", "s/x*/-/3", "", "aé", "sed-edit:content"],
    ["the Nth empty match before non-ASCII text needs no step", "s/x*/-/2", "", "aé", "a-é"],
    ["a replaced empty match that stops there needs no step", "s/x*/-/", "", "é", "-é"],
    ["a first match before non-ASCII text needs no step", "s/a/-/g", "", "aé", "-é"],
    ["an empty match after the last non-ASCII character", "s/$/!/g", "", "é", "é!"],
    ["g with ^ before a byte order mark is refused", "s/^/x/g", "", "﻿a", "sed-edit:content"],
    ["a dot matches a whole code point", "s/./X/g", "", "😀a", "XX"],
    ["a negated bracket on non-ASCII text", "s/[^a]/X/", "", "éa", "Xa"],
  ]
  test.each(rows)("%s", (_, script, options, text, expected) => {
    expect(run(script, text, options)).toBe(expected)
  })
})

describe("SedScript.apply lines and addresses", () => {
  const rows: Array<[string, string, string, string]> = [
    ["a line number", "2d", "a\nb\nc\n", "a\nc\n"],
    ["$", "$d", "a\nb\nc\n", "a\nb\n"],
    ["a regex address", "/b/d", "a\nb\nc\n", "a\nc\n"],
    ["a regex address on a substitution", "/b/s/./X/", "a\nb\nc\n", "a\nX\nc\n"],
    ["N,M", "2,3d", "a\nb\nc\nd\n", "a\nd\n"],
    ["N,$", "2,$d", "a\nb\nc\nd\n", "a\n"],
    ["N,$ past the end changes nothing", "5,$d", "a\nb\n", "a\nb\n"],
    ["a range that ends before it starts is one line", "4,2d", "a\nb\nc\nd\ne\n", "a\nb\nc\ne\n"],
    ["a range with equal ends is one line", "2,2d", "a\nb\nc\n", "a\nc\n"],
    ["a range of substitutions", "2,3s/./X/", "a\nb\nc\nd\n", "a\nX\nX\nd\n"],
    ["a numeric range is entered even when d skipped its start", "/b/d;2,3s/./X/", "a\nb\nc\nd\ne\nf\n", "a\nX\nd\ne\nf\n"],
    ["a skipped range start and end", "/b/d;/c/d;2,3s/./X/", "a\nb\nc\nd\ne\nf\n", "a\nd\ne\nf\n"],
    ["a degenerate range after d changes nothing", "/d/d;4,2s/./X/", "a\nb\nc\nd\ne\n", "a\nb\nc\ne\n"],
    ["N,$ after d", "/b/d;2,$s/./X/", "a\nb\nc\nd\ne\nf\n", "a\nX\nX\nX\nX\n"],
    ["a regex address sees the changed pattern space", "s/a/x\\ny/;/y/d", "a\nb\n", "b\n"],
    ["a regex address after a substitution", "/b/s/b/B/;/B/d", "a\nb\nc\n", "a\nc\n"],
    ["d skips the later commands", "d;s/a/b/", "a\n", ""],
    ["deleting the last line keeps the previous terminator", "$d", "a\nb", "a\n"],
    ["deleting the only line", "d", "a", ""],
    ["deleting an unterminated last line among others", "2d", "a\nb\nc", "a\nc"],
    ["a missing final newline stays missing", "s/a/b/", "a", "b"],
    ["a final newline stays", "s/a/b/", "a\n", "b\n"],
    ["empty text stays empty under s/^/x/", "s/^/x/", "", ""],
    ["a lone newline is one empty line", "s/^/x/", "\n", "x\n"],
    ["empty lines are kept", "s/a/b/", "a\n\n\na\n", "b\n\n\nb\n"],
    ["CRLF keeps its CRs", "s/a/b/", "a\r\na\r\n", "b\r\nb\r\n"],
    ["$ sees a CRLF line without its CR", "s/x$/Z/", "x\r\n", "Z\r\n"],
    ["a dot does not match the CR of CRLF", "s/./X/g", "ab\r\n", "XX\r\n"],
    ["mixed endings are kept per line", "s/a/b/", "a\r\na\na\r\n", "b\r\nb\nb\r\n"],
    ["a lone CR is content", "s/a$/b/", "a\r", "a\r"],
    ["a lone CR mid-line is content", "s/\\(.\\)/[\\1]/g", "a\rb\n", "[a][\r][b]\n"],
    ["a newline inserted into a CRLF line is CRLF", "s/b/\\n/", "abc\r\n", "a\r\nc\r\n"],
    ["a newline inserted into an LF line is LF", "s/b/\\n/", "abc\n", "a\nc\n"],
    ["a CRLF line deleted among LF lines", "2d", "a\nb\r\nc\n", "a\nc\n"],
    ["the byte order mark stays on line 1", "s/^/x/", "﻿a\n", "x﻿a\n"],
    ["a mark does not stop a \\w edit", "s/\\w/X/", "﻿a\n", "﻿X\n"],
    // JavaScript's own \s matches U+FEFF; the POSIX space set does not.
    ["\\s is not the byte order mark", "s/\\s/X/g", "﻿a b\n", "﻿aXb\n"],
    ["\\S is the byte order mark", "s/\\S/X/g", "﻿a b\n", "XX X\n"],
  ]
  test.each(rows)("%s", (_, script, text, expected) => {
    expect(run(script, text)).toBe(expected)
  })

  test("line numbers and $ start fresh on every call", () => {
    const result = edit("sed -i -e '1s/a/X/' -e '$s/z/Y/' -e '2d' f g")
    expect(SedScript.apply("a\nb\nz\n", result)).toEqual({ ok: true, text: "X\nz\n".replace("z", "Y") })
    expect(SedScript.apply("a\nb\nz\n", result)).toEqual({ ok: true, text: "X\nY\n" })
  })

  test("-e scripts run in order on the same pattern space", () => {
    const result = edit("sed -i -e 's/a/b/' -e 's/b/c/' f")
    expect(SedScript.apply("a\n", result)).toEqual({ ok: true, text: "c\n" })
  })
})

describe("SedScript.apply content rule", () => {
  const rows: Array<[string, string]> = [
    ["\\w", "s/\\w/X/"],
    ["\\W", "s/\\W/X/"],
    ["\\s", "s/\\s/X/"],
    ["\\b", "s/\\bx/X/"],
    ["\\<", "s/\\<x/X/"],
    ["[[:alpha:]]", "s/[[:alpha:]]/X/"],
    ["the I flag", "s/x/X/I"],
    ["an address regex with a class", "/[[:alpha:]]/d"],
  ]
  test.each(rows)("%s refuses non-ASCII text", (_, script) => {
    expect(run(script, "café\n")).toBe("sed-edit:content")
  })

  test("a dot, a negated bracket and a literal keep code-point meaning on non-ASCII text", () => {
    expect(run("s/./X/g", "café\n")).toBe("XXXX\n")
    expect(run("s/[^a]/X/g", "café\n")).toBe("XaXX\n")
    expect(run("s/f/F/", "café\n")).toBe("caFé\n")
  })

  test("a leading byte order mark alone is not non-ASCII", () => {
    expect(run("s/\\w/X/", "﻿a\n")).toBe("﻿X\n")
    expect(run("s/\\w/X/", "﻿﻿a\n")).toBe("sed-edit:content")
  })
})

describe("SedScript.apply limits", () => {
  test("text over the size cap is refused before any regex runs", () => {
    expect(run("s/a/b/", "a".repeat(SedScript.MAX_TEXT + 1))).toBe("sed-edit:limit")
    expect(run("s/a/b/", "a".repeat(SedScript.MAX_TEXT))).toBe("b" + "a".repeat(SedScript.MAX_TEXT - 1))
  })

  test("a long line is refused when the pattern has two unbounded quantifiers", () => {
    expect(run("s/.*x.*y/Z/", "x".repeat(2000) + "\n")).toBe("sed-edit:limit")
    expect(run("s/.*x/Z/", "x".repeat(2000) + "\n")).toBe("Z\n")
  })

  test("a very long line is refused when the pattern has one unbounded quantifier", () => {
    expect(run("s/a*b/Z/", "a".repeat(20_000) + "\n")).toBe("sed-edit:limit")
    // A small bounded quantifier is not counted: the cost of a match does not grow with the line.
    expect(run("s/a\\{1,3\\}b/Z/", "a".repeat(20_000) + "\n")).toBe("a".repeat(20_000) + "\n")
  })

  test("a large interval counts as unbounded, and stacked quantifiers shrink the line limit", () => {
    expect(run("s/.\\{0,32767\\}x/Z/", "a".repeat(20_000) + "\n")).toBe("sed-edit:limit")
    expect(run("s/.*.*.*x/Z/", "a".repeat(999) + "\n")).toBe("sed-edit:limit")
  })

  test("a range of letters is a content rule: non-ASCII text is refused", () => {
    expect(run("s/[a-z]/X/", "caf\u00e9\n")).toBe("sed-edit:content")
    expect(run("s/[a-z]/X/", "abc\n")).toBe("Xbc\n")
  })

  test("a replacement that grows the text past the cap is refused", () => {
    const twenty = "&".repeat(20)
    const edits = edit(`sed -i -e 's/./${twenty}/g' -e 's/./${twenty}/g' f`)
    expect(SedScript.apply("x".repeat(100) + "\n", edits)).toEqual({ ok: true, text: "x".repeat(40_000) + "\n" })
    expect(SedScript.apply("x".repeat(12_000) + "\n", edits)).toEqual({ ok: false, reason: "sed-edit:limit" })
  })

  // A synchronous loop blocks the event loop and the runner's timeout never fires, so this runs in a child process.
  test("adversarial patterns finish inside a deadline", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "sed-apply-limits-child.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: path.join(import.meta.dir, "..", ".."),
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    const output = await new Response(child.stdout).text()
    clearTimeout(timer)
    expect(await child.exited).toBe(0)
    expect(JSON.parse(output)).toEqual(Array(6).fill("sed-edit:limit"))
  }, 15_000)
})

describe("SedScript.classify", () => {
  const rows: Array<[string, { stdout: string; code: number | null }, NodeJS.Platform, SedScript.Flavor]> = [
    ["GNU on linux", { stdout: "sed (GNU sed) 4.9\nCopyright", code: 0 }, "linux", "gnu"],
    ["GNU on win32", { stdout: "sed (GNU sed) 4.9\n", code: 0 }, "win32", "gnu"],
    ["GNU that prints the path it was started by", { stdout: "/usr/bin/sed (GNU sed) 4.9\n", code: 0 }, "win32", "gnu"],
    ["a program that only ends in sed (GNU sed)", { stdout: "mysed (GNU sed) 4.9\n", code: 0 }, "linux", "unknown"],
    ["GNU on darwin", { stdout: "sed (GNU sed) 4.8\n", code: 0 }, "darwin", "gnu"],
    ["busybox on linux", { stdout: "This is not GNU sed version 4.0\n", code: 0 }, "linux", "unknown"],
    ["busybox that mentions GNU", { stdout: "usage: not sed (GNU sed)\n", code: 1 }, "linux", "unknown"],
    ["BSD, which has no --version", { stdout: "", code: 1 }, "darwin", "bsd"],
    ["BSD usage text", { stdout: "usage: sed script [-Ealnru]\n", code: 1 }, "darwin", "bsd"],
    ["no output on win32", { stdout: "", code: 1 }, "win32", "unknown"],
    ["no output on linux", { stdout: "", code: 1 }, "linux", "unknown"],
    ["a timeout on darwin", { stdout: "", code: null }, "darwin", "bsd"],
    ["a timeout on linux", { stdout: "", code: null }, "linux", "unknown"],
    ["GNU text after a failing exit", { stdout: "sed (GNU sed) 4.9\n", code: 1 }, "linux", "unknown"],
    ["the GNU text on the second line", { stdout: "\nsed (GNU sed) 4.9\n", code: 0 }, "linux", "unknown"],
    ["BSD on freebsd", { stdout: "", code: 1 }, "freebsd", "unknown"],
  ]
  test.each(rows)("%s", (_, output, platform, expected) => {
    expect(SedScript.classify(output, platform)).toBe(expected)
  })
})

describe("SedScript.flavor", () => {
  type Step = { exit?: number; out?: string; fail?: true; hang?: true }
  function fake(step: Step) {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string; stdin?: unknown; env?: unknown; extendEnv?: boolean }> = []
    const spawner = make((command) => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("piped command")
      calls.push({ command: command.command, args: command.args, cwd: command.options.cwd, stdin: command.options.stdin, env: command.options.env, extendEnv: command.options.extendEnv })
      if (step.fail)
        return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn", description: "no shell" }))
      return Effect.succeed(
        makeHandle({
          pid: ProcessId(calls.length),
          exitCode: step.hang ? Effect.never : Effect.succeed(ExitCode(step.exit ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: step.hang ? Stream.never : Stream.fromEffect(Effect.succeed(new TextEncoder().encode(step.out ?? ""))),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    })
    const probe = (shell: string, env: Record<string, string | undefined>) =>
      Effect.runPromise(SedScript.flavor(shell, env).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner, spawner))))
    return { calls, probe }
  }

  test("two calls with the same shell and PATH start one process", async () => {
    const host = fake({ out: "sed (GNU sed) 4.9\n" })
    expect(await host.probe("/fake/bash-cache", { PATH: "/a" })).toBe("gnu")
    expect(await host.probe("/fake/bash-cache", { PATH: "/a" })).toBe("gnu")
    expect(host.calls).toHaveLength(1)
  })

  test("another PATH or another shell starts another process", async () => {
    const host = fake({ out: "sed (GNU sed) 4.9\n" })
    await host.probe("/fake/bash-keys", { PATH: "/a" })
    await host.probe("/fake/bash-keys", { PATH: "/b" })
    await host.probe("/fake/other-keys", { PATH: "/a" })
    expect(host.calls).toHaveLength(3)
  })

  test("the probe runs the shell with a fixed script, no input, the given environment and the temp folder", async () => {
    const host = fake({ out: "sed (GNU sed) 4.9\n" })
    await host.probe("/fake/bash-shape", { PATH: "/a", HOME: "/h", EMPTY: undefined })
    expect(host.calls[0].command).toBe("/fake/bash-shape")
    expect(host.calls[0].args).toEqual(["-c", "sed --version"])
    expect(host.calls[0].cwd).toBe(os.tmpdir())
    expect(host.calls[0].stdin).toBe("ignore")
    expect(host.calls[0].env).toEqual({ PATH: "/a", HOME: "/h" })
    expect(host.calls[0].extendEnv).toBe(false)
  })

  test("a non-zero exit is classified like no output and is remembered", async () => {
    const host = fake({ exit: 1, out: "sed (GNU sed) 4.9\n" })
    expect(await host.probe("/fake/bash-exit", { PATH: "/a" })).toBe(process.platform === "darwin" ? "bsd" : "unknown")
    await host.probe("/fake/bash-exit", { PATH: "/a" })
    expect(host.calls).toHaveLength(1)
  })

  test("a shell that cannot start is classified like no output and is tried again", async () => {
    const host = fake({ fail: true })
    expect(await host.probe("/fake/bash-fail", { PATH: "/a" })).toBe(process.platform === "darwin" ? "bsd" : "unknown")
    await host.probe("/fake/bash-fail", { PATH: "/a" })
    expect(host.calls).toHaveLength(2)
  })

  test("a probe that hangs ends at its deadline as no output", async () => {
    const host = fake({ hang: true })
    const started = performance.now()
    expect(await host.probe("/fake/bash-hang", { PATH: "/a" })).toBe(process.platform === "darwin" ? "bsd" : "unknown")
    expect(performance.now() - started).toBeLessThan(Duration.toMillis(Duration.seconds(8)))
  }, 10_000)
})
