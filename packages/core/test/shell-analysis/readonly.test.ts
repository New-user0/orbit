import { describe, expect, test } from "bun:test"
import { bash, linux, powershell, pwsh, pwshLinux, windows } from "./helper"
import { notReadOnly as psNotReadOnly, platform as psPlatform, readOnly as psReadOnly } from "./powershell-cases"

// Read-only is an allowlist: a head, a flag or an operand that is not listed is a question for the person. A false
// verdict is a security bug, so the "no" rows are the ones that matter. Each row is a text and its verdict.
const readOnly = [
  "ls -la | wc -l",
  "cat a 2>/dev/null",
  "cat a 2>&1",
  "cat a >/dev/stdout",
  "ls -la > /dev/null 2>&1",
  "head -n 5 a",
  "tail -f log",
  "wc -l a b",
  "stat a",
  "strings bin",
  "od -c a",
  "hexdump -C a",
  "nl a",
  "cut -d, -f1 a",
  "tr a-z A-Z",
  "paste a b",
  "column -t a",
  "tac a",
  "rev a",
  "fold -w 80 a",
  "fmt a",
  "expand a",
  "unexpand a",
  "comm a b",
  "cmp a b",
  "diff a b",
  "numfmt --to=iec 1024",
  "basename a/b",
  "dirname a/b",
  "realpath a",
  "readlink -f a",
  "id",
  "uname -a",
  "whoami",
  "pwd",
  "hostname -f",
  "date +%Y",
  "date -u",
  "date -r a",
  "cal",
  "uptime",
  "free -h",
  "df -h",
  "du -sh .",
  "nproc",
  "locale",
  "groups",
  "getconf PAGESIZE",
  "which git",
  "type ls",
  "true",
  "false",
  "seq 3",
  "sleep 1",
  "expr 1 + 2",
  "test -f a",
  "echo hi",
  "echo 'a b' \"c\"",
  "file -b a",
  "tree -L 2",
  "sort -n a",
  "sha256sum a",
  "md5sum -c sums",
  "uniq -c",
  "jq .x a.json",
  "jq -r '.a[]' f",
  "ps aux",
  "ps -ef",
  "base64 a",
  "base64 -d a",
  "man -k ls",
  "info -f x",
  "lsof -i",
  "pgrep -f x",
  "tput cols",
  "ss -tln",
  "netstat -an",
  "history 10",
  "alias",
  "arch",
  "ip addr",
  "ifconfig eth0",
  "node -v",
  "python3 --version",
  'ls "a b"',
  "cat 'x y'",
  "D=src && ls $D",
  "X=1; ls",
  "cd src",
  "cat < a",
  "ls -- -x",
  "! test -f a",
  "(cat a; cat b)",
  "if test -f a; then cat a; fi",
]

const notReadOnly = [
  // Writes
  "cat a > out",
  "cat a >> out",
  "ls >&out",
  "cat a | tee out",
  "> f",
  "cat a &> out",
  "cat a >| out",
  // Clock and identity
  "date -s now",
  "date 01011200",
  "date --set=x",
  "hostname newname",
  "hostname -F f",
  // Flags that write, and flags that are not listed
  "file -C",
  "tree -o out",
  "tree -R -H . -L 2",
  "sort -o out a",
  "sort --compress-program=sh a",
  "sort -T /tmp a",
  "uniq a",
  "uniq a b",
  "base64 -o out a",
  "base64 -- a",
  "info -o out x",
  "man -P sh ls",
  "lsof +m/tmp/x",
  "tput reset",
  "tput -S",
  "ss -K",
  "ps e",
  "ps axe",
  "ps --bogus",
  "sha256sum --bogus a",
  "md5sum -bx a",
  // Prefix environment
  "PATH=. ls",
  "LANG=C ls",
  "env",
  "env A=1 ls",
  // Environment dumps
  "printenv",
  "printenv HOME",
  "set",
  "export -p",
  "declare -p",
  "declare -x",
  "typeset -p",
  // Opaque input
  "f() { :; }; ls",
  "$cmd x",
  "cat $(rm x)",
  "echo $(ls)",
  "echo ${HOME}",
  "echo $HOME",
  // Unknown values
  'echo "home $HOME"',
  'cat "$HOME/.ssh/id_rsa"',
  'for f in a b; do cat "x$f"; done',
  "printf -v x y",
  "printf hi",
  "test -v x",
  "test -R x",
  "[ -f a ]",
  "[[ -f a ]]",
  "xxd -r a b",
  "xxd a",
  // Globs and arithmetic
  "ls *.ts",
  "cat a?",
  "ls [ab]",
  "echo $((1+1))",
  "cat x(e:'id':)",
  // Wrappers
  "timeout 5 cat x",
  "nice cat x",
  "nohup cat x",
  "time cat x",
  "stdbuf -o0 cat x",
  "command cat x",
  "builtin echo x",
  "sudo cat x",
  // Paths and heads
  "/bin/cat a",
  "./ls",
  "CAT a",
  "cd src && cat a",
  "cd a; cd b",
  "cat /proc/self/environ",
  "cat < /proc/1/environ",
  "cat /proc/1/environ",
  "cat < /dev/tcp/10.0.0.1/80",
  "cat /dev/udp/h/53",
  // jq
  "jq 'import \"a\" as a; .' f",
  "jq 'include \"a\"; .' f",
  "jq -f prog.jq a",
  "jq --rawfile x f .",
  "jq 'system(\"id\")'",
  "jq env",
  "jq '$ENV.X'",
  "jq -L dir .",
  "jq",
  // Heads that other tasks own: pinned so they flip on purpose
  "grep x a",
  "git status",
  "find .",
  "sed -n 1p a",
  "xargs ls",
  "curl x",
  "rm a",
  "python -c 1",
  "node a.js",
  // Empty
  "",
  "   ",
  "# comment",
]

describe("bash read-only rows", () => {
  test.each(readOnly)("ro: %s", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
  test.each(notReadOnly)("no: %j", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test("the table has at least 100 rows", () => {
    expect(readOnly.length + notReadOnly.length).toBeGreaterThanOrEqual(100)
  })
})

describe("PowerShell read-only rows (pwsh on win32)", () => {
  test.each(psReadOnly)("ro: %s", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(true)
  })
  test.each(psNotReadOnly)("no: %j", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(false)
  })
  test("platform-dependent rows", () => {
    expect(powershell("ps e", pwshLinux()).readOnly).toBe(false)
    expect(powershell("ps e", pwsh()).readOnly).toBe(true)
    expect(powershell("sleep 60", pwshLinux()).readOnly).toBe(false)
    expect(powershell("sleep 60", pwsh()).readOnly).toBe(true)
    expect(powershell("Start-Sleep 60", pwshLinux()).readOnly).toBe(true)
    expect(powershell("Get-Content `$x", pwsh()).readOnly).toBe(true)
  })
  test("recorded texts all exist", () => {
    for (const text of psPlatform) expect(() => powershell(text, pwsh())).not.toThrow()
  })
})

describe("read paths, with quotes removed", () => {
  const rows: Array<[string, string[]]> = [
    ['cat "a b" \'c\'', ["a b", "c"]],
    ["head -n 5 a", ["a"]],
    ["ls", ["."]],
    ["cat -- -x", ["-x"]],
    ["date -r f", ["f"]],
    ["jq --arg a b .x f", ["f"]],
    ["cat < in", ["in"]],
    ["cd src", ["src"]],
    ["cd", ["/home/u"]],
    ["cat ~/a", ["/home/u/a"]],
    ["du", ["."]],
    ["file -f list a", ["list", "a"]],
    ["base64 -i in", ["in"]],
    ["diff a b", ["a", "b"]],
    ["cmp -n 5 a b", ["a", "b"]],
    ["tail -n 3 a", ["a"]],
    ["echo a b", []],
    ["tr a b", []],
  ]
  test.each(rows)("%s", (text, expected) => {
    expect(bash(text).readPaths).toEqual(expected)
  })
  test("PowerShell paths", () => {
    expect(powershell("Get-Content -LiteralPath 'a b'", pwsh()).readPaths).toEqual(["a b"])
    expect(powershell("Get-ChildItem src", pwsh()).readPaths).toEqual(["src"])
    expect(powershell("Get-Content a -Tail 5", pwsh()).readPaths).toEqual(["a"])
    expect(powershell("Get-Content a -ErrorAction SilentlyContinue", pwsh()).readPaths).toEqual(["a"])
  })
  test("the read paths of a text that is not read-only are not an allowance", () => {
    expect(bash("cat a > out").readOnly).toBe(false)
  })
})

describe("environment dumps are never read-only", () => {
  test.each(["printenv", "env", "set", "export", "export -p", "declare -p", "declare -x", "typeset -x", "typeset -p", "local"])(
    "%s",
    (text) => {
      expect(bash(text).readOnly).toBe(false)
    },
  )
})

describe("the allowlist shape", () => {
  test("a flag that is not listed refuses, one that is listed passes", () => {
    expect(bash("sort -n a").readOnly).toBe(true)
    expect(bash("sort --bogus a").readOnly).toBe(false)
  })
  test("a bundle passes only when every letter is known and takes no value", () => {
    expect(bash("ps -ef").readOnly).toBe(true)
    expect(bash("ps -efp 1").readOnly).toBe(false)
    expect(bash("tree -aL 2").readOnly).toBe(false)
  })
  test("a flag value is taken from =, or from the next token when that is not a flag", () => {
    expect(bash("tree -L 2").readOnly).toBe(true)
    expect(bash("tree -L=2").readOnly).toBe(true)
    expect(bash("tree -L").readOnly).toBe(false)
    expect(bash("tree -L -a").readOnly).toBe(false)
    expect(bash("tree -L x").readOnly).toBe(false)
  })
  test("a flag that takes no value refuses an =", () => {
    expect(bash("sort -n=1 a").readOnly).toBe(false)
  })
  test("after -- every word is an operand", () => {
    expect(bash("sort -- -o").readOnly).toBe(true)
    expect(bash("sort -- -o").readPaths).toEqual(["-o"])
  })
  test("a string value that starts with - is refused", () => {
    expect(bash("date -d -1day").readOnly).toBe(false)
  })
  test("windows heads: a .exe is stripped only there", () => {
    expect(bash("sort.exe -n a", windows()).readOnly).toBe(true)
    expect(bash("sort.exe -n a", linux()).readOnly).toBe(false)
  })
})
