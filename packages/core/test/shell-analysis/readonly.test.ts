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
  "git status",
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
    expect(bash("tree --filelimit=5").readOnly).toBe(true)
    expect(bash("tree -L=2").readOnly).toBe(false)
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

// Search and transform tools (shell-safety-4).
const searchReadOnly = [
  "rg -n foo src",
  "rg foo",
  "rg -e a -e b src",
  "rg -A20 foo src",
  "rg -i -g '*.ts' foo",
  "grep -rn x .",
  "grep -rn x",
  "grep -l foo a b",
  "grep -e x a",
  "grep --color=always x a",
  "grep --color always /etc/passwd",
  "grep -c 'x$' a",
  "grep -E 'a|b' a",
  "grep -d recurse x .",
  "grep --directories=skip x a",
  "grep -e5 a",
  "grep -m5 x a",
  "grep --version",
  "fd foo",
  "fd -e ts foo src",
  "fd -t f -0 foo",
  "fdfind foo .",
  "fd --hyperlink pat src",
  "find .",
  "find . -name '*.ts'",
  "find -O3 src -type f",
  "find . \\( -name a -o -name b \\) -print",
  "find . -newer stamp",
  "find . -path ./node_modules -prune -o -print",
  "find -L . -name a",
  "find . -executable -follow",
  "find . -name foo-exec",
  "find -D tree /etc -name x",
  "sed -n '1,20p' file",
  "sed -n 1p a",
  "sed -n '1p;3p' a b",
  "sed -nE 5p a",
  "sed -n -- 5p a",
  "sed 's/a/b/g'",
  "sed -E 's/x/y/2'",
  "sed 's/x/hello world/'",
  "sed 's/yes/no/'",
  "sed 's/#{;}!/b/'",
  "sort -n a",
  "sort -u a b",
  "echo a b | xargs echo",
  "ls | xargs",
  "find . -name '*.ts' -type f -print0 | xargs -0 grep -n foo",
  "find src -type f -print0 | xargs -0 wc -l",
  "find . -type f -print0 2>/dev/null | xargs -0 -I {} head {}",
  "find . -type f -print0 | xargs -0 -n 5 -P 2 tail",
]

const searchNotReadOnly = [
  // find
  "find . -name x -exec rm {} \\;",
  "find . -delete",
  "find . -execdir x \\;",
  "find . -ok rm {} \\;",
  "find . -okdir rm {} \\;",
  "find . -fprint out",
  "find . -fprint0 out",
  "find . -fprintf out x",
  "find . -fls out",
  "find -files0-from list",
  "find . -files0-from list",
  "find . -name -delete",
  "find . -Bmin 5",
  "find . -name *.ts",
  "find . -H",
  "find . -name",
  "find -D",
  // fd
  "fd x -x rm",
  "fd x --exec rm",
  "fd x -X rm",
  "fd x --exec-batch rm",
  "fd -l x",
  "fd -u x",
  "fdfind x -x rm",
  // rg
  "rg --pre 'sh -c' x",
  "rg --pre-glob '*' --pre x y",
  "rg -L foo",
  "rg --follow foo",
  "rg --files",
  "rg -r x foo",
  "rg -0 foo",
  "rg -P foo",
  "rg --sort path foo",
  'rg "a\nb" f',
  "RIPGREP_CONFIG_PATH=x rg foo",
  "RIPGREP_CONFIG_PATH=x; rg foo",
  // grep
  "grep -R x .",
  "grep --dereference-recursive x .",
  "grep -5 x a",
  "egrep x a",
  "fgrep x a",
  "grep -d bogus x a",
  "grep -D bogus x a",
  "grep -rR x .",
  'grep "a\nb" f',
  "grep -e",
  // sort
  "sort -o out a",
  "sort --output=out a",
  "sort --compress-program=sh a",
  "sort -T /tmp a",
  "sort --files0-from=l",
  "sort -k2 a",
  // sed
  "sed -n 'w out' a",
  "sed 's/a/b/e' a",
  "sed -i s/a/b/ a",
  "sed --in-place s/a/b/ a",
  "sed -f s.sed a",
  "sed -n -e 1p a",
  "sed 's/a/b/' f",
  "sed -n 's/a/b/p'",
  "sed -n '$p' a",
  "sed -n '/x/p' a",
  "sed 1d a",
  "sed y/a/b/",
  "sed -s -n 1p a",
  "sed --debug -n 1p a",
  "sed -n 1pw a",
  "sed",
  "sed -n",
  "sed 's|a|b|'",
  "sed 's/a/b/w out'",
  // xargs: unlisted targets and options
  "xargs rm",
  "xargs sh -c 'x'",
  "xargs ls",
  "cat list.txt | xargs cat",
  "xargs -p cat",
  "xargs -i echo",
  "xargs -e EOF echo",
  "xargs -l 5 echo",
  "xargs -a f echo",
  "xargs --null echo",
  "xargs -E= EOF echo",
  "xargs -rI echo sh",
  "xargs -I x echo",
  "xargs -n5 echo",
  "xargs -o echo",
  "xargs /bin/echo",
  // xargs: items that are not known
  "cat list | xargs head",
  "find . -name '*.ts' | xargs grep -n foo",
  "find . -type f | xargs head",
  "find . -type f -print0 | xargs head",
  "find . -print0 | xargs -0 head",
  "find . -print0 -type f | xargs -0 head",
  "find -L . -type f -print0 | xargs -0 head",
  "find . -follow -type f -print0 | xargs -0 head",
  "find . -type f -o -name x -print0 | xargs -0 head",
  "find . -type f -print0 -print | xargs -0 head",
  "find . -type f -print0 -ls | xargs -0 head",
  "find . ! -type f -print0 | xargs -0 head",
  "find . -type f -print0 | xargs -0 -d x head",
  "find . -type f -print0 |& xargs -0 head",
  "find . -type f -print0 | xargs -0 head < l",
  "find . -type f -print0 | xargs -0 head <<< x",
  "find . -type f -print0 | xargs -0 -I {} head {}/../x",
  "find -type f -print0 | xargs -0 head",
  "fd -0 -t f . | xargs -0 head",
  "find . -type f -print0 | xargs -0 grep -R x",
  "find . -type f -print0 | xargs -0 wc --files0-from=l",
  "(find . -type f -print0) | xargs -0 head",
  "find . -type f -print0 | cat | xargs -0 head",
  "find . -type f -delete -print0 | xargs -0 head",
]

describe("search and transform tools", () => {
  test.each(searchReadOnly)("ro: %s", (text) => {
    expect(bash(text).readOnly).toBe(true)
  })
  test.each(searchNotReadOnly)("no: %j", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test("xargs is never read-only on Windows", () => {
    expect(bash("echo a b | xargs echo").readOnly).toBe(true)
    expect(bash("echo a b | xargs echo", windows()).readOnly).toBe(false)
    expect(bash("find . -type f -print0 | xargs -0 head", windows()).readOnly).toBe(false)
  })
  test("a program in the working folder is not the xargs target", () => {
    expect(bash("echo a | xargs echo", linux({ local: (head) => head === "echo" })).readOnly).toBe(false)
    expect(bash("echo a | xargs echo", linux({ env: { PATH: ".:/usr/bin" } })).readOnly).toBe(false)
  })
  test("an exec in a quoted name is a name, an exec predicate is not", () => {
    expect(bash("find . -name '-delete'").readOnly).toBe(false)
    expect(bash("find . -name foo-exec").readOnly).toBe(true)
  })
})

describe("search read paths", () => {
  const rows: Array<[string, string[]]> = [
    ["rg -n foo src", ["src"]],
    ["rg foo", ["."]],
    ["rg -e foo a b", ["a", "b"]],
    ["rg -f pats a", ["pats", "a"]],
    ["rg -e5 a", ["a"]],
    ["rg -f5 a", ["5", "a"]],
    ["grep foo a b", ["a", "b"]],
    ["grep -e x /etc/passwd", ["/etc/passwd"]],
    ["grep -e5 /etc/passwd", ["/etc/passwd"]],
    ["grep --regexp=x /etc/passwd", ["/etc/passwd"]],
    ["grep -f /etc/pats a", ["/etc/pats", "a"]],
    ["grep --file=/etc/pats a", ["/etc/pats", "a"]],
    ["grep --color always /etc/passwd", ["/etc/passwd"]],
    ["grep --exclude-from=/x/l -r y", ["/x/l", "."]],
    ["grep x", []],
    ["grep -- -x f", ["f"]],
    ["grep -rn x ~/src", ["/home/u/src"]],
    ["fd foo /etc", ["/etc"]],
    ["fd --search-path /etc foo", ["/etc"]],
    ["fd --base-directory /srv foo sub", ["/srv", "/srv/sub"]],
    ["fd --base-directory /srv foo", ["/srv", "/srv"]],
    ["find . ')' -print", [".", ")"]],
    ["find . ',' -print", [".", ","]],
    ["find . '(' -name x ')'", ["."]],
    ["diff -X/etc/x -r a b", ["/etc/x", "a", "b"]],
    ["diff -rX /etc/x a b", ["/etc/x", "a", "b"]],
    ["du -X/etc/x .", ["/etc/x", "."]],
    ["fd --ignore-file /etc/ign foo", ["/etc/ign", "."]],
    ["fd --hyperlink pat /etc", ["/etc"]],
    ["fd", ["."]],
    ["find -O3 /etc -name x", ["/etc"]],
    ["find -D tree /etc", ["/etc"]],
    ["find . -newer /etc/x", [".", "/etc/x"]],
    ["find . -path '*/node_modules' -prune", [".", "*/node_modules"]],
    ["find a b -type f", ["a", "b"]],
    ["find -type f", ["."]],
    ["find ~ -name x", ["/home/u"]],
    ["find -- a -name x", ["a", "a", "-name", "x"]],
    ["sed -n 1p a b", ["a", "b"]],
    ["sed -n 1p -- -x", ["-x"]],
    ["sed -n 1p", []],
    ["sed s/a/b/", []],
    ["find src -type f -print0 | xargs -0 grep -f p x", ["src", "p", "x"]],
    ["find src -type f -print0 | xargs -0 -I {} head {}", ["src"]],
    ["diff --from-file=/etc/x /dev/null", ["/etc/x", "/dev/null"]],
    ["diff --to-file /etc/x a", ["/etc/x", "a"]],
    ["diff -X /etc/x a b", ["/etc/x", "a", "b"]],
    ["diff --exclude='*.o' a b", ["a", "b"]],
    ["du --exclude-from=/etc/x .", ["/etc/x", "."]],
    ["head a -c /etc/passwd", ["a", "/etc/passwd"]],
    ["head -n 5 a", ["a"]],
  ]
  test.each(rows)("%s", (text, expected) => {
    expect(bash(text).readPaths).toEqual(expected)
  })
  test("a file list that wc or du reads is dynamic and refuses, whatever the spelling", () => {
    for (const text of ["wc --files0-from=l", "wc --files0-from l", "du --files0-from=l", "wc --files0=l", "wc --f=l"])
      expect(bash(text).readOnly).toBe(false)
  })
})

describe("PowerShell search read paths (pwsh on win32)", () => {
  const rows: Array<[string, string[]]> = [
    ["Select-String foo a.txt", ["a.txt"]],
    ["sls foo a.txt", ["a.txt"]],
    ["Select-String -Pattern foo -Path a.txt", ["a.txt"]],
    ["Select-String -Pattern foo a.txt", ["a.txt"]],
    ["Select-String -Path a.txt foo", ["a.txt"]],
    ["Select-String C:\\x -Pattern foo", ["C:\\x"]],
    ["Get-Content a | Select-String foo", ["a"]],
    ["Select-String -Pattern a,b x", ["x"]],
    ["Select-String foo -Context 2,3 a", ["a"]],
    ["findstr /I foo *.ts", ["*.ts"]],
    ["findstr /C:foo a b", ["a", "b"]],
    ["findstr /G:pats.txt a", ["pats.txt", "a"]],
  ]
  test.each(rows)("%s", (text, expected) => {
    expect(powershell(text, pwsh()).readPaths).toEqual(expected)
  })
  test("findstr /D: joins each folder onto each file, and reads the file as written too", () => {
    expect(powershell("findstr '/D:x;y' foo f", pwsh()).readPaths.toSorted()).toEqual(["f", "x", "x\\f", "y", "y\\f"])
  })
  // findstr opens a file with a drive or a root as written, whatever /D: says (class 4).
  test.each(["C:\\x\\f", "\\x\\f", "C:x"])("findstr /D:sub foo %s reads the file as written", (file) => {
    expect(powershell(`findstr /D:sub foo ${file}`, pwsh()).readPaths).toContain(file)
  })
})

// Option-shape class (class 4): an option that takes no value, or only an attached one, must not swallow the next word,
// because the word is then a file that is read and never recorded. Each row is a GNU spelling that was seen to read.
describe("an option with no value or an attached value leaves the next word to be read", () => {
  const rows: Array<[string, string[]]> = [
    ["fmt -s /etc/x", ["/etc/x"]],
    ["fmt -t /etc/x", ["/etc/x"]],
    ["od -w /etc/x", ["/etc/x"]],
    ["od --width /etc/x", ["/etc/x"]],
    ["pr -s /etc/x", ["/etc/x"]],
    ["diff --unified /etc/x a", ["/etc/x", "a"]],
    ["diff --context /etc/x a", ["/etc/x", "a"]],
    ["ls --color /etc", ["/etc"]],
    ["stat -t /etc/x", ["/etc/x"]],
    ["df --output /etc/x", ["/etc/x"]],
    ["hexdump -C -L /etc/x", ["/etc/x"]],
  ]
  test.each(rows)("%s", (text, expected) => {
    const verdict = bash(text)
    expect(verdict.readOnly).toBe(true)
    expect(verdict.readPaths).toEqual(expected)
  })
  // uniq takes no file operand here, so the word after an optional-value option makes it ask instead of being skipped.
  test.each(["uniq --group /etc/x", "uniq --all-repeated /etc/x"])("%s asks", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test.each(["date --iso-8601 0101000025", "date --iso-8601 -u 0101000025", "date -I 0101000025"])("%s sets the clock, so it asks", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test("date --iso-8601=seconds and +FORMAT stay read-only", () => {
    expect(bash("date --iso-8601=seconds").readOnly).toBe(true)
    expect(bash("date --iso-8601 +%s").readOnly).toBe(true)
    expect(bash("date --iso-8601").readOnly).toBe(true)
    expect(bash("date -I").readOnly).toBe(true)
  })
  // BSD ls takes no value for -w, -T and -I, BSD fmt none for -p: the next word is a file that is read.
  test.each([
    ["ls -w /etc", ["/etc"]],
    ["ls -T /etc", ["/etc"]],
    ["ls -I /etc", ["/etc"]],
    ["fmt -p /etc/x", ["/etc/x"]],
  ])("%s keeps its next word as a read path", (text, expected) => {
    const verdict = bash(text)
    expect(verdict.readOnly).toBe(true)
    expect(verdict.readPaths).toEqual(expected)
  })
  // binutils strings expands @FILE into arguments read from FILE, so neither FILE nor its contents are checked.
  test.each(["strings @x", "strings -- @x", "strings bin @/etc/x", "strings -n 4 @x"])("%s asks", (text) => {
    expect(bash(text).readOnly).toBe(false)
  })
  test("a second --base-directory asks, whichever order", () => {
    expect(bash("fd --base-directory src --base-directory .. -t f .").readOnly).toBe(false)
    expect(bash("fdfind --base-directory .. --base-directory src x").readOnly).toBe(false)
    expect(bash("fd --base-directory=src --base-directory .. x").readOnly).toBe(false)
    expect(bash("fd --base-directory src x").readOnly).toBe(true)
  })
})
