export * as ShellReadOnly from "./readonly.js"

import type { ShellAnalysis } from "./analysis.js"
import { SedScript } from "./sed.js"

// Read-only is an allowlist. A head that has no entry here is never read-only, and neither is a flag that an entry does
// not list. "any" is used only for tools that read and print and have no flag that writes, runs a program or changes
// the machine. A false read-only verdict is a security bug, so every doubt is a refusal: a refusal costs one question.

export type Verdict = { ok: true; reads: string[] } | { ok: false; reason: string }

const refuse = (reason: string): Verdict => ({ ok: false, reason })

// `pattern` is the search pattern, `patterns` a file of them (read, and the pattern is given); `optional` is a value only when written `--flag=value`; `enum:a|b` and `literal:text`
// accept only what they list.
type Value = "string" | "number" | "char" | "path" | "pattern" | "patterns" | "optional" | `enum:${string}` | `literal:${string}`
type Spec = {
  // "any" passes every flag. Otherwise a flag must be listed; "" means it takes no value.
  flags: "any" | Record<string, Value | "">
  // "any" specs only: options that take values, so the value is not taken for an operand. The value is skipped only
  // before the first operand: a tool that stops option parsing at its first operand reads the rest as files.
  values?: Record<string, number>
  // "any" specs only: options whose value is a file that the tool reads, written `--opt=file` or `--opt file`.
  filePaths?: string[]
  // Operands are read paths from `skip` on, unless `read` is false. `default` is read when there is no operand.
  operands?: { max?: number; min?: number; read?: boolean; skip?: number; default?: string }
  // A search tool: the first operand is the pattern unless a flag gave one, and the rest are read paths.
  search?: "grep" | "rg" | "fd"
  // `-A20` for `-A 20` (grep and rg only).
  fused?: true
  // Option parsing ends at the first operand, which starts the command that the tool runs.
  stop?: true
  exact?: true
  doubleDash?: false
  // Returns true to refuse.
  check?: (args: string[]) => boolean
}

// "-b --brief -f=path --exclude= -n=number": a name, then `=` and the kind of value when it takes one.
function table(text: string): Record<string, Value | ""> {
  return Object.fromEntries(
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((token): [string, Value | ""] => {
        const index = token.indexOf("=")
        if (index < 0) return [token, ""]
        const kind = token.slice(index + 1)
        const known = ["path", "patterns", "number", "char", "pattern", "optional"].includes(kind) || kind.startsWith("enum:") || kind.startsWith("literal:")
        return [token.slice(0, index), known ? (kind as Value) : "string"]
      }),
  )
}

function values(text: string): Record<string, number> {
  return Object.fromEntries(
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((token): [string, number] => {
        const index = token.indexOf("*")
        return index < 0 ? [token, 1] : [token.slice(0, index), Number(token.slice(index + 1))]
      }),
  )
}

const reading = { read: true } as const
const quiet = { read: false } as const

const BASH: Record<string, Spec> = {
  cat: { flags: "any", operands: reading },
  head: { flags: "any", values: values("-n -c --lines --bytes"), operands: reading },
  tail: { flags: "any", values: values("-n -c --lines --bytes --pid -s --sleep-interval"), operands: reading },
  wc: { flags: "any", operands: reading },
  stat: { flags: "any", values: values("-c --format --printf -t"), operands: reading },
  strings: { flags: "any", values: values("-n --bytes -t --radix -e --encoding -T --target"), operands: reading },
  hexdump: { flags: "any", values: values("-A -j -N -t -e -n -s -L"), operands: reading },
  od: { flags: "any", values: values("-A -j -N -t -S -w --width --skip-bytes --read-bytes --format --address-radix"), operands: reading },
  nl: { flags: "any", values: values("-s -w -v -i -b -f -h -l -n -d"), operands: reading },
  cut: { flags: "any", values: values("-d -f -b -c --delimiter --fields --bytes --characters --output-delimiter"), operands: reading },
  paste: { flags: "any", values: values("-d --delimiters"), operands: reading },
  column: { flags: "any", values: values("-s -c -o -N -R -n -W -l --table-columns --output-separator"), operands: reading },
  tac: { flags: "any", values: values("-s --separator"), operands: reading },
  rev: { flags: "any", operands: reading },
  fold: { flags: "any", values: values("-w --width"), operands: reading },
  expand: { flags: "any", values: values("-t --tabs"), operands: reading },
  unexpand: { flags: "any", values: values("-t --tabs"), operands: reading },
  fmt: { flags: "any", values: values("-w -p -s -t --width --prefix"), operands: reading },
  comm: { flags: "any", values: values("--output-delimiter"), operands: reading },
  cmp: { flags: "any", values: values("-i -n --ignore-initial --bytes"), operands: reading },
  diff: { flags: "any", values: values("-U -C -L --label --unified --context -W --width -x --exclude"), filePaths: ["-X", "--exclude-from", "--from-file", "--to-file"], operands: reading },
  tsort: { flags: "any", operands: reading },
  pr: { flags: "any", values: values("-h -l -w -o -N -s --header --length --width"), operands: reading },
  df: { flags: "any", values: values("-t -x --type --exclude-type --output -B --block-size"), operands: reading },
  du: { flags: "any", values: values("-d --max-depth -B --block-size -t --threshold --exclude"), filePaths: ["-X", "--exclude-from"], operands: { read: true, default: "." } },
  ls: { flags: "any", values: values("-w --width -T --tabsize -I --ignore --hide --block-size --color --sort --time --format --indicator-style"), operands: { read: true, default: "." } },
  realpath: { flags: "any", values: values("--relative-to --relative-base"), operands: reading },
  readlink: { flags: "any", operands: reading },
  test: { flags: "any", operands: reading, check: (args) => args.some((arg) => arg === "-v" || arg === "-R") },
  tr: { flags: "any", operands: quiet },
  numfmt: { flags: "any", values: values("--from --to --field --format --padding --suffix --unit-size --header"), operands: quiet },
  basename: { flags: "any", values: values("-s --suffix"), operands: quiet },
  dirname: { flags: "any", operands: quiet },
  id: { flags: "any", operands: quiet },
  uname: { flags: "any", operands: quiet },
  free: { flags: "any", values: values("-s -c --seconds --count"), operands: quiet },
  locale: { flags: "any", operands: quiet },
  groups: { flags: "any", operands: quiet },
  nproc: { flags: "any", values: values("--ignore"), operands: quiet },
  cal: { flags: "any", operands: quiet },
  uptime: { flags: "any", operands: quiet },
  getconf: { flags: "any", operands: quiet },
  expr: { flags: "any", operands: quiet },
  seq: { flags: "any", values: values("-f -s -t --format --separator"), operands: quiet },
  sleep: { flags: "any", operands: quiet },
  which: { flags: "any", operands: quiet },
  type: { flags: "any", operands: quiet },
  true: { flags: "any", operands: quiet },
  false: { flags: "any", operands: quiet },
  echo: { flags: "any", operands: quiet },
  pwd: { flags: "any", exact: true },
  whoami: { flags: "any", exact: true },
  alias: { flags: "any", exact: true },
  uniq: { flags: "any", values: values("-f -s -w --skip-fields --skip-chars --check-chars --group --all-repeated"), operands: { max: 0 } },
  history: { flags: "any", operands: { max: 1, read: false }, check: (args) => args.some((arg) => !/^\d+$/.test(arg)) },
  arch: { flags: table("-h --help"), operands: { max: 0 } },
  ifconfig: { flags: table(""), operands: { max: 1, read: false }, check: (args) => args.some((arg) => !/^[A-Za-z]/.test(arg)) },
  ip: { flags: table(""), operands: { min: 1, max: 1, read: false }, check: (args) => args[0] !== "addr" },
  node: { flags: table("-v --version"), operands: { max: 0 }, check: (args) => args.length !== 1 },
  python: { flags: table("--version"), operands: { max: 0 }, check: (args) => args.length !== 1 },
  python3: { flags: table("--version"), operands: { max: 0 }, check: (args) => args.length !== 1 },
  file: {
    // Never -C or --compile, which write the compiled magic file.
    flags: table(
      "-b --brief -i --mime --mime-type --mime-encoding --apple -c --check-encoding --exclude= --exclude-quiet= -0 --print0 -f=path -F= --separator= --help -v --version -h --no-dereference -L --dereference -m=path --magic-file=path -k --keep-going -l --list -n --no-buffer -p --preserve-date -r --raw -s --special-files -z --uncompress",
    ),
    operands: reading,
    // -m and --magic-file take a colon-separated list and each element is opened, so `x.mgc://host/share/m` reaches a
    // share and `x.mgc:/etc/y` a file outside the folder.
    check: (args) =>
      args.some((arg, index) =>
        arg === "-m" || arg === "--magic-file" ? args[index + 1]?.includes(":") === true : arg.startsWith("--magic-file=") && arg.includes(":", 13),
      ),
  },
  sort: {
    // Never -o or --output, -T, --compress-program (runs a program) or --files0-from.
    flags: table(
      "-b --ignore-leading-blanks -d --dictionary-order -f --ignore-case -g --general-numeric-sort -h --human-numeric-sort -i --ignore-nonprinting -M --month-sort -n --numeric-sort -R --random-sort -r --reverse -s --stable -u --unique -V --version-sort -z --zero-terminated -c --check -C -m --merge --sort= -k= --key= -t= --field-separator= -S= --buffer-size= --parallel=number --batch-size=number --help --version",
    ),
    operands: reading,
  },
  // No egrep or fgrep. No -R or --dereference-recursive, which follow every link inside the tree. --color is a value only
  // with `=`: GNU grep reads `--color always` as the flag and a file named `always`. -f and --exclude-from are read.
  grep: {
    flags: table(
      "-e=pattern --regexp=pattern -f=patterns --file=patterns -F --fixed-strings -G --basic-regexp -E --extended-regexp -P --perl-regexp -i --ignore-case --no-ignore-case -v --invert-match -w --word-regexp -x --line-regexp -c --count --color=optional --colour=optional -L --files-without-match -l --files-with-matches -m=number --max-count=number -o --only-matching -q --quiet --silent -s --no-messages -b --byte-offset -H --with-filename -h --no-filename --label= -n --line-number -T --initial-tab -u --unix-byte-offsets -Z --null -z --null-data -A=number --after-context=number -B=number --before-context=number -C=number --context=number --group-separator= --no-group-separator -a --text --binary-files= -D=enum:read|skip --devices=enum:read|skip -d=enum:read|skip|recurse --directories=enum:read|skip|recurse --exclude= --exclude-from=path --exclude-dir= --include= -r --recursive --line-buffered -U --binary --help -V --version",
    ),
    search: "grep",
    fused: true,
    check: (args) => args.some((arg) => /[\r\n]/.test(arg)),
  },
  // No --pre or --pre-glob (they run a program per file), no -L or --follow (they follow links inside the tree), no
  // --files, -0, -r, -P, --sort or --type-add.
  rg: {
    flags: table(
      "-e=pattern --regexp=pattern -f=patterns -i --ignore-case -S --smart-case -F --fixed-strings -w --word-regexp -v --invert-match -c --count -l --files-with-matches --files-without-match -n --line-number -o --only-matching -A=number --after-context=number -B=number --before-context=number -C=number --context=number -H -h --heading --no-heading -q --quiet --column -g= --glob= -t= --type= -T= --type-not= --type-list --hidden --no-ignore -u -m=number --max-count=number -d=number --max-depth=number -a --text -z --color= --json --stats --help --version --debug",
    ),
    search: "rg",
    fused: true,
    check: (args) => args.some((arg) => /[\r\n]/.test(arg)),
  },
  // No -x, --exec, -X, --exec-batch (they run a program), no -l or --list-details (it starts ls through PATH), no -u.
  fd: {
    flags: table(
      "-h --help -V --version -H --hidden -I --no-ignore --no-ignore-vcs --no-ignore-parent -s --case-sensitive -i --ignore-case -g --glob --regex -F --fixed-strings -a --absolute-path -L --follow -p --full-path -0 --print0 -1 -q --quiet --show-errors --strip-cwd-prefix --one-file-system --prune --no-require-git -d=number --max-depth=number --min-depth=number --exact-depth=number -j=number --threads=number --max-results=number --batch-size=number -t= --type= -e= --extension= -S= --size= --changed-within= --changed-before= -o= --owner= -E= --exclude= --ignore-file=path -c= --color= --max-buffer-time= --search-path=path --base-directory=path --path-separator= --hyperlink=optional --and= --format=",
    ),
    search: "fd",
  },
  fdfind: {
    flags: table(
      "-h --help -V --version -H --hidden -I --no-ignore --no-ignore-vcs --no-ignore-parent -s --case-sensitive -i --ignore-case -g --glob --regex -F --fixed-strings -a --absolute-path -L --follow -p --full-path -0 --print0 -1 -q --quiet --show-errors --strip-cwd-prefix --one-file-system --prune --no-require-git -d=number --max-depth=number --min-depth=number --exact-depth=number -j=number --threads=number --max-results=number --batch-size=number -t= --type= -e= --extension= -S= --size= --changed-within= --changed-before= -o= --owner= -E= --exclude= --ignore-file=path -c= --color= --max-buffer-time= --search-path=path --base-directory=path --path-separator= --hyperlink=optional --and= --format=",
    ),
    search: "fd",
  },
  // The options that run a program through PATH or start another process are absent: -i, -e and -l take an optional value
  // that must be attached, so written apart xargs runs the next word, not what a validator expects. Options end at the
  // first word that is not one, and that word is the command.
  xargs: { flags: table("-I=literal:{} -E=literal:EOF -n=number -P=number -L=number -s=number -d=char -0 -t -r -x"), stop: true },
  sha256sum: { flags: table("-b --binary -t --text -c --check --ignore-missing --quiet --status --strict -w --warn --tag -z --zero --help --version"), operands: reading },
  sha1sum: { flags: table("-b --binary -t --text -c --check --ignore-missing --quiet --status --strict -w --warn --tag -z --zero --help --version"), operands: reading },
  md5sum: { flags: table("-b --binary -t --text -c --check --ignore-missing --quiet --status --strict -w --warn --tag -z --zero --help --version"), operands: reading },
  tree: {
    // Never -o or --output, which write, and never -R, which with -H writes 00Tree.html into subfolders.
    flags: table(
      "-a -d -l -f -x -L=number -P= -I= --gitignore --ignore-case --matchdirs --metafirst --prune --noreport --charset= --filelimit=number -q -N -Q -p -u -g -s -h --si --du -D --timefmt= -F --inodes --device -v -t -c -U -r --dirsfirst --filesfirst --sort= -i -A -S -n -C -X -J -H= --hintro=path --houtro=path -T= --scheme= --authority= --fromfile --fromtabfile --gitfile=path --infofile=path --nolinks --help --version",
    ),
    operands: { read: true, default: "." },
  },
  date: {
    flags: table(
      "-d= --date= -r=path --reference=path -u --utc --universal -I -Idate -Ihours -Iminutes -Iseconds -Ins --iso-8601= -R --rfc-email --rfc-3339= --debug --help --version",
    ),
    operands: { read: false },
    // MMDDhhmm sets the clock, so every positional must be a +FORMAT.
    check: (args) => positionals(args, table("-d= -r= --date= --reference= --iso-8601= --rfc-3339=")).some((arg) => !arg.startsWith("+")),
  },
  hostname: {
    flags: table("-f --fqdn --long -s --short -i --ip-address -I --all-ip-addresses -a --alias -d --domain -A --all-fqdns -v --verbose -h --help -V --version"),
    operands: { max: 0 },
  },
  ps: {
    flags: table(
      "-A -a -d -e -N -T -f -F -l -y -j -c -L -m -w -H -V --version --help --info --forest --no-headers --headers --width= -n= --sort= -C= -G= -g= -p= --pid= -q= --quick-pid= -s= --sid= -t= --tty= -U= -u= --user=",
    ),
    // A BSD word with an e prints the environment of every process. Digits are included (`e1`), which is stricter than
    // letters only.
    check: (args) => positionals(args, table("-n= -C= -G= -g= -p= -q= -s= -t= -U= -u= --width= --sort= --pid= --quick-pid= --sid= --tty= --user=")).some((arg) => /^[A-Za-z0-9]+$/.test(arg) && arg.includes("e")),
    operands: { read: false },
  },
  base64: {
    flags: table("-d -D --decode -b=number --break=number -w=number --wrap=number -i=path --input=path --ignore-garbage -h --help --version"),
    doubleDash: false,
    operands: reading,
  },
  man: { flags: table("-a --all -d -f --whatis -h -k --apropos -l=path -w -S= -s="), operands: quiet },
  help: { flags: table("-d -m -s"), operands: quiet },
  info: {
    flags: table("-f= --file= -d= --directory= -n= --node= -a --all -k= --apropos= -w --where --location --show-options --vi-keys --subnodes -h --help --usage --version"),
    operands: quiet,
  },
  netstat: { flags: table("-a -L -l -n -g -i -s -r -m -v -f= -I="), operands: quiet },
  lsof: {
    flags: table("-? -h -v -a -b -C -l -n -N -O -P -Q -R -t -U -V -X -H -E -F -g -i -K -L -o -r -s -S -T -x -A= -c= -d= -e= -k= -p= -u="),
    operands: reading,
    check: (args) => args.some((arg) => arg.startsWith("+m")),
  },
  pgrep: {
    flags: table(
      "-a -c -f -i -l -n -o -v -w -x -d= --delimiter= -g= --pgroup= -G= --group= -O= --older= -P= --parent= -s= --session= -t= --terminal= -u= --euid= -U= --uid= -F=path --pidfile=path -r= --runstates= --ns= --nslist= --count --full --list-name --list-full --newest --oldest --inverse --exact --ignore-case --lightweight --help -V --version",
    ),
    operands: quiet,
  },
  tput: {
    flags: table("-T= -V -x"),
    operands: quiet,
    check: (args) =>
      args.some((arg) =>
        [
          "init", "reset", "rs1", "rs2", "rs3", "is1", "is2", "is3", "iprog", "if", "rf", "clear", "flash", "mc0", "mc4", "mc5",
          "mc5i", "mc5p", "pfkey", "pfloc", "pfx", "pfxl", "smcup", "rmcup",
        ].includes(arg),
      ),
  },
  ss: {
    // Never -K or --kill, -D or --diag, -F or --filter, -N or --net.
    flags: table(
      "-n --numeric -r --resolve -a --all -l --listening -o --options -e --extended -m --memory -p --processes -i --info -s --summary -t --tcp -u --udp -d --dccp -w --raw -x --unix -S --sctp -0 --packet -4 --ipv4 -6 --ipv6 -H --no-header -O --oneline -b --bpf -E --events -T --threads -Z --context -z --contexts -f= --family= -A= --query= --socket= -h --help -V --version",
    ),
    operands: quiet,
  },
}

// Natives and cmdlets of PowerShell. `flags` lists lower case names without the dash; "any" passes every flag.
type PsSpec = {
  flags: "any" | "none" | ReadonlySet<string>
  native?: true
  // The first word of the arguments must be this, and arguments after it are free (route print).
  first?: string
  // Parameters whose value is a path that is read, and parameters whose value is some other value.
  paths?: ReadonlySet<string>
  other?: ReadonlySet<string>
  // Positional arguments are read paths.
  reads?: true
  default?: string
  positional?: false | "any"
  // Select-String: positionals bind to the pattern, then the path, after the named parameters are known.
  binding?: true
  // findstr: its /C: /G: /D: values and positional words are read after the loop.
  findstr?: true
}

const names = (text: string) => new Set(text.toLowerCase().split(/\s+/).filter(Boolean))
const PS_PATHS = names("path literalpath")

const cmdlet = (flags: string, more: Partial<PsSpec> = {}): PsSpec => ({ flags: names(flags), ...more })
const file = (flags: string, other = "", more: Partial<PsSpec> = {}): PsSpec => ({
  flags: names(flags),
  paths: PS_PATHS,
  other: names(other),
  reads: true,
  ...more,
})

const POWERSHELL: Record<string, PsSpec> = {
  "get-childitem": file("path literalpath filter include exclude recurse depth name force attributes directory file hidden readonly system", "filter include exclude depth attributes", { default: "." }),
  "get-content": file("path literalpath totalcount head tail raw encoding delimiter readcount", "totalcount head tail encoding delimiter readcount"),
  "get-item": file("path literalpath force stream", "stream"),
  "get-itemproperty": file("path literalpath name", "name"),
  "get-itempropertyvalue": file("path literalpath name", "name"),
  "test-path": file("path literalpath pathtype filter include exclude isvalid newerthan olderthan", "pathtype filter include exclude newerthan olderthan"),
  "resolve-path": file("path literalpath relative"),
  "get-filehash": file("path literalpath algorithm inputstream", "algorithm"),
  "get-acl": file("path literalpath audit filter include exclude", "filter include exclude"),
  "format-hex": file("path literalpath inputobject encoding count offset", "inputobject encoding count offset"),
  "convert-path": file("path literalpath"),
  "set-location": file("path literalpath passthru stackname", "stackname"),
  "push-location": file("path literalpath passthru stackname", "stackname"),
  "pop-location": cmdlet("passthru stackname"),
  "join-path": cmdlet("path childpath additionalchildpath"),
  "split-path": cmdlet("path literalpath qualifier noqualifier parent leaf leafbase extension isabsolute"),
  "convertto-json": cmdlet("inputobject depth compress enumsasstrings asarray"),
  "convertfrom-json": cmdlet("inputobject depth ashashtable noenumerate"),
  "convertto-csv": cmdlet("inputobject delimiter notypeinformation noheader usequotes"),
  "convertfrom-csv": cmdlet("inputobject delimiter header useculture"),
  "convertto-xml": cmdlet("inputobject depth as notypeinformation"),
  "convertto-html": cmdlet("inputobject property head title body pre post as fragment"),
  "join-string": cmdlet("inputobject property separator outputprefix outputsuffix singlequote doublequote formatstring"),
  "get-member": cmdlet("inputobject membertype name static view force"),
  "get-unique": cmdlet("inputobject asstring caseinsensitive ontype"),
  "compare-object": cmdlet("referenceobject differenceobject property syncwindow casesensitive culture excludedifferent includeequal passthru"),
  "get-random": cmdlet("inputobject minimum maximum count setseed shuffle"),
  "select-object": { flags: "any" },
  "sort-object": { flags: "any" },
  "group-object": { flags: "any" },
  "where-object": { flags: "any" },
  "measure-object": { flags: "any" },
  "format-table": { flags: "any" },
  "format-list": { flags: "any" },
  "format-wide": { flags: "any" },
  "format-custom": { flags: "any" },
  "out-string": { flags: "any" },
  "out-host": { flags: "any" },
  "out-null": { flags: "none" },
  "write-output": cmdlet("inputobject noenumerate"),
  "write-host": cmdlet("object nonewline separator foregroundcolor backgroundcolor"),
  "start-sleep": cmdlet("seconds milliseconds duration"),
  "get-process": cmdlet("name id module fileversioninfo includeusername"),
  "get-service": cmdlet("name displayname dependentservices requiredservices include exclude"),
  "get-date": cmdlet("date format uformat displayhint asutc"),
  "get-location": cmdlet("psprovider psdrive stack stackname"),
  "get-psdrive": cmdlet("name psprovider scope"),
  "get-psprovider": cmdlet("psprovider"),
  "get-module": cmdlet("name listavailable all fullyqualifiedname psedition"),
  "get-alias": cmdlet("name definition scope exclude"),
  "get-history": cmdlet("id count"),
  "get-timezone": cmdlet("name id listavailable"),
  "get-hotfix": cmdlet("id description"),
  "get-computerinfo": { flags: "any" },
  "get-host": { flags: "any" },
  "get-culture": { flags: "any" },
  "get-uiculture": { flags: "any" },
  "get-uptime": { flags: "any" },
  "get-netadapter": cmdlet("name interfacedescription interfaceindex physical"),
  "get-netipaddress": cmdlet("interfaceindex interfacealias addressfamily type"),
  "get-netipconfiguration": cmdlet("interfaceindex interfacealias detailed all"),
  "get-netroute": cmdlet("interfaceindex interfacealias addressfamily destinationprefix"),
  "get-dnsclientcache": cmdlet("entry name type status section data"),
  "get-dnsclient": cmdlet("interfaceindex interfacealias"),
  "get-eventlog": cmdlet("logname newest after before entrytype index instanceid message source username asbaseobject list"),
  "get-winevent": cmdlet("logname listlog listprovider providername path maxevents filterxpath force oldest", {
    paths: names("path"),
    other: names("logname listprovider providername maxevents filterxpath"),
  }),
  // -Include, -Exclude and -Culture are not listed.
  "select-string": cmdlet("path literalpath pattern inputobject simplematch casesensitive quiet list notmatch allmatches encoding context raw noemphasis", {
    paths: PS_PATHS,
    other: names("pattern inputobject encoding context"),
    binding: true,
  }),
  // Never /F: (a list of files read from a file), /OFF, or /S, which follows directory links and junctions inside the tree.
  findstr: { flags: names("/b /e /l /r /i /x /v /n /m /o /p /c /g /d /a"), native: true, positional: "any", findstr: true },
  "get-cimclass": cmdlet("classname namespace methodname propertyname qualifiername"),
  ipconfig: { flags: names("/all /displaydns /allcompartments"), native: true, positional: false },
  netstat: { flags: names("-a -b -e -f -n -o -p -q -r -s -t -x -y"), native: true, positional: "any" },
  systeminfo: { flags: names("/fo /nh"), native: true, positional: "any" },
  tasklist: { flags: names("/m /svc /v /fi /fo /nh"), native: true, positional: "any" },
  "where.exe": { flags: "any", native: true, positional: "any" },
  hostname: { flags: names("-a -d -f -i -I -s -y -A"), native: true, positional: false },
  whoami: { flags: names("/user /groups /claims /priv /logonid /all /fo /nh"), native: true, positional: "any" },
  arp: { flags: names("-a -g -v -N"), native: true, positional: "any" },
  route: { flags: names("-4 -6"), native: true, first: "print" },
  getmac: { flags: names("/fo /nh /v"), native: true, positional: "any" },
  // Never -C, --compile, -m or --magic-file.
  file: {
    flags: names("-b --brief -i --mime --mime-type --mime-encoding --apple --help -v --version -L -h"),
    native: true,
    reads: true,
  },
  tree: { flags: names("/f /a /q /l"), native: true, reads: true, default: "." },
}

const COMMON = names("verbose debug erroraction warningaction informationaction progressaction errorvariable warningvariable informationvariable outvariable outbuffer pipelinevariable")
const COMMON_VALUED = new Set([...COMMON].filter((name) => name !== "verbose" && name !== "debug"))

function isFlag(token: string) {
  return token.length > 1 && token[0] === "-" && /[A-Za-z0-9_-]/.test(token[1])
}

// The operands of a command whose flag table is known, for a `check`. Values of value-taking flags are skipped.
function positionals(args: string[], valued: Record<string, Value | "">) {
  const result: string[] = []
  let ends = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (ends || !isFlag(token)) {
      result.push(token)
      continue
    }
    if (token === "--") {
      ends = true
      continue
    }
    if (!token.includes("=") && valued[token]) index++
  }
  return result
}

function valid(value: string, kind: Value) {
  if (kind === "number") return /^\d+$/.test(value)
  if (kind === "char") return [...value].length === 1
  if (kind.startsWith("enum:")) return kind.slice(5).split("|").includes(value)
  if (kind.startsWith("literal:")) return value === kind.slice(8)
  return !value.startsWith("-")
}

type Seen = { name: string; value?: string }

// Walks `args` against a flag table. Returns the operands, the paths that flags read, whether a flag gave the search
// pattern, every flag seen (a bundle counts each letter) and, for a `stop` spec, the words from the first operand on.
// Undefined is a refusal.
function scanFlags(spec: Spec, args: string[]) {
  const operands: string[] = []
  const reads: string[] = []
  const seen: Seen[] = []
  let pattern = false
  let rest: string[] | undefined
  const table = spec.flags === "any" ? undefined : spec.flags
  let ends = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (ends || !isFlag(token)) {
      if (spec.stop) {
        rest = args.slice(index)
        break
      }
      operands.push(token)
      continue
    }
    if (token === "--") {
      if (spec.doubleDash === false) return undefined
      if (spec.stop) {
        rest = args.slice(index + 1)
        break
      }
      ends = true
      continue
    }
    const equals = token.indexOf("=")
    let name = equals < 0 ? token : token.slice(0, equals)
    let inline = equals < 0 ? undefined : token.slice(equals + 1)
    // A single-letter flag written `-m=x` hands the tool `=x`, not `x`, so the recorded read path is never what it opens.
    if (table && equals >= 0 && !token.startsWith("--")) return undefined
    if (!table) {
      // GNU tools take any unambiguous prefix of a long option, so `--files0` is `--files0-from`: a list of files read.
      if (name.length > 2 && "--files0-from".startsWith(name)) return undefined
      const files = spec.filePaths?.some((option) => option === name || (option.startsWith("--") && !spec.values?.[name] && name.startsWith("--") && name.length > 2 && option.startsWith(name)))
      if (files) {
        const value = inline ?? args[index + 1]
        if (value === undefined) return undefined
        if (inline === undefined) index++
        reads.push(value)
        continue
      }
      // Unknown options take no value; an extra operand only adds a read path.
      if (equals < 0 && operands.length === 0) index += spec.values?.[name] ?? 0
      continue
    }
    let kind = Object.hasOwn(table, name) ? table[name] : undefined
    if (kind === undefined) {
      const fused = spec.fused ? /^(-[A-Za-z])(\d+)$/.exec(token) : null
      if (fused && Object.hasOwn(table, fused[1]) && table[fused[1]] !== "") {
        name = fused[1]
        inline = fused[2]
        kind = table[name]
      } else {
        if (token.startsWith("--") || equals >= 0 || token.length < 3) return undefined
        // A bundle of single-letter flags passes only when every letter is known and takes no value.
        const bundle = [...token.slice(1)].every((letter) => Object.hasOwn(table, `-${letter}`) && table[`-${letter}`] === "")
        if (!bundle) return undefined
        for (const letter of token.slice(1)) seen.push({ name: `-${letter}` })
        continue
      }
    }
    if (kind === "") {
      if (inline !== undefined) return undefined
      seen.push({ name })
      continue
    }
    // An optional value is only the text after `=`; bare, the next word stays an operand.
    if (kind === "optional") {
      seen.push({ name, value: inline })
      continue
    }
    const value = inline ?? args[++index]
    if (value === undefined || (inline === undefined && isFlag(value)) || !valid(value, kind)) return undefined
    if (kind === "path" || kind === "patterns") reads.push(value)
    if (kind === "pattern" || kind === "patterns") pattern = true
    seen.push({ name, value })
  }
  return { operands, reads, pattern, seen, rest }
}

function jq(args: string[]): Verdict {
  const operands: string[] = []
  let ends = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    // system( and env reach the machine; import and include load module files from disk.
    if (/\bsystem\s*\(|\benv\b|\$ENV|\b(?:import|include)\b/.test(token)) return refuse("jq:program")
    if (ends || !isFlag(token)) {
      operands.push(token)
      continue
    }
    if (token === "--") {
      ends = true
      continue
    }
    // A token that contains --from-file or --library-path is refused whatever follows it (`--from-file=x`); so is a
    // short bundle that holds f or L.
    if (
      ["--rawfile", "--slurpfile", "--run-tests"].includes(token) ||
      token.includes("--from-file") ||
      token.includes("--library-path") ||
      /^-[A-Za-z0-9]*[fL]/.test(token)
    )
      return refuse("jq:file")
    if (token === "--arg" || token === "--argjson") index += 2
    else if (token === "--indent") index += 1
  }
  if (operands.length === 0) return refuse("jq:filter")
  return { ok: true, reads: operands.slice(1) }
}

/** `~` and `~/x` through the injected path module; undefined for a word that is not a plain path. */
export function expandHome(value: string, ctx: ShellAnalysis.Context) {
  if (value === "~") return ctx.home
  if (value.startsWith("~/") || (ctx.platform === "win32" && value.startsWith("~\\"))) return ctx.path.join(ctx.home, value.slice(2))
  return value
}

// Anywhere in the word, so `--from-file=//host/share/x` counts. `scheme://` does not: a colon before the slashes.
// `\??\UNC\host\share` is the NT spelling of the same share, in either separator. A host starts with a non-space, so
// the jq operator in `.a // "x"` is not one.
const UNC = /\\\\[^\s\\/]|(?<!:)(?:\/\/|\/\\|\\\/)[^\s\\/]|[\\/]\?\?[\\/]/
const WEBDAV = /@SSL@\d+|@\d+@SSL|DavWWWRoot/i

/** A word that names a network share on Windows, or a WebDAV marker. */
export function networkPath(value: string) {
  return UNC.test(value) || WEBDAV.test(value)
}

/**
 * Git Bash maps /proc/sys onto the NT namespace, so /proc/sys/Device/Mup/host/share opens the same share. Separators
 * fold, `.` and empty components drop and `..` pops, so `/proc/./sys`, `/proc//sys`, `/proc/self/root/proc/sys` and a
 * relative climb to the root all land here.
 */
function procSys(value: string) {
  const parts: string[] = []
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part.toLowerCase())
  }
  return parts.some((part, index) => part === "proc" && parts[index + 1] === "sys")
}

/** A word that opens the network on Windows by any spelling: a share, a WebDAV marker, or the /proc/sys view of the NT namespace. */
export function windowsShare(value: string) {
  return networkPath(value) || procSys(value)
}

/** Files that are not files: another process's environment, and the network through bash's /dev/tcp and /dev/udp. */
export function special(value: string) {
  return /\/proc\/.*\/environ|\/dev\/(?:tcp|udp)\//.test(value.replaceAll("\\", "/"))
}

/** True when a bare head could be a program in the working folder: a relative PATH entry, or the locator says so. */
export function projectLocal(head: string, ctx: ShellAnalysis.Context) {
  const entry = ctx.platform === "win32" ? Object.keys(ctx.env).find((key) => key.toLowerCase() === "path") : "PATH"
  const raw = entry ? ctx.env[entry] : undefined
  if (raw !== undefined) {
    const delimiter = ctx.platform === "win32" ? ";" : ":"
    const relative = raw
      .split(delimiter)
      .map((item) => item.replace(/^"(.*)"$/, "$1"))
      .some((item) => item === "" || item === "." || !ctx.path.isAbsolute(item))
    if (relative) return true
  }
  return ctx.local?.(head) === true
}

/** Whether one bash command is read-only, and the paths it reads. */
export function bash(command: ShellAnalysis.Command, ctx: ShellAnalysis.Context, producer?: ShellAnalysis.Command): Verdict {
  if (command.argv.length === 0) return refuse("empty")
  if (command.env.length > 0) return refuse("env")
  if (command.dynamicHead) return refuse("head:dynamic")
  const head = command.head
  if (/[\\/]/.test(head)) return refuse("head:path")
  if (command.argv.some((word) => !word.literal || word.glob || word.arithmetic)) return refuse("word:expansion")
  if (command.argv.some((word) => special(word.value))) return refuse("special")
  if (ctx.platform === "win32" && command.argv.some((word) => windowsShare(word.value))) return refuse("unc")
  if (projectLocal(head, ctx)) return refuse("head:local")
  const args = command.argv.slice(1).map((word) => word.value)
  const redirected = redirects(command, ctx)
  if (!redirected.ok) return redirected
  if (head === "cd") {
    if (args.length > 1 || args.some((arg) => isFlag(arg) || arg === "-")) return refuse("cd")
    return { ok: true, reads: [expandHome(args[0] ?? "~", ctx), ...redirected.reads] }
  }
  if (head === "jq") {
    const verdict = jq(args)
    return verdict.ok ? { ok: true, reads: [...verdict.reads.map((path) => expandHome(path, ctx)), ...redirected.reads] } : verdict
  }
  const verdict = tool(head, args, ctx, command, producer)
  return verdict.ok ? { ok: true, reads: [...verdict.reads, ...redirected.reads] } : verdict
}

// The verdict of one listed program on its own arguments. `command` and `producer` are set only for the command the
// shell runs, never for the target that xargs starts.
function tool(head: string, args: string[], ctx: ShellAnalysis.Context, command?: ShellAnalysis.Command, producer?: ShellAnalysis.Command): Verdict {
  if (head === "find") return find(args, ctx)
  if (head === "sed") return sed(args, ctx)
  if (head === "xargs") return command ? xargs(args, ctx, command, producer) : refuse("xargs:nested")
  if (!Object.hasOwn(BASH, head)) return refuse("head:unlisted")
  const spec = BASH[head]
  if (spec.exact) return args.length === 0 ? { ok: true, reads: [] } : refuse("args")
  const scanned = scanFlags(spec, args)
  if (!scanned) return refuse("flag")
  if (spec.check?.(args)) return refuse("check")
  if (spec.search) return { ok: true, reads: searched(spec.search, scanned, ctx).map((path) => expandHome(path, ctx)) }
  const limits = spec.operands
  if (limits?.max !== undefined && scanned.operands.length > limits.max) return refuse("operands")
  if (limits?.min !== undefined && scanned.operands.length < limits.min) return refuse("operands")
  const operands = limits?.read ? scanned.operands : []
  const paths = [...scanned.reads, ...(operands.length === 0 && limits?.default && limits.read ? [limits.default] : operands)]
  return { ok: true, reads: paths.map((path) => expandHome(path, ctx)) }
}

// grep, rg and fd: the first operand is the pattern unless a flag gave one, and every other operand is a path.
function searched(kind: "grep" | "rg" | "fd", scanned: NonNullable<ReturnType<typeof scanFlags>>, ctx: ShellAnalysis.Context) {
  const files = scanned.pattern ? scanned.operands : scanned.operands.slice(1)
  const base = scanned.seen.find((item) => item.name === "--base-directory")?.value
  // fd changes into its base directory first, so every relative path is under it.
  const under = (path: string) => {
    if (base === undefined || path === base) return path
    const home = expandHome(path, ctx)
    return ctx.path.isAbsolute(home) ? home : ctx.path.join(expandHome(base, ctx), home)
  }
  const reads = [...scanned.reads.map(under), ...files.map(under)]
  if (files.length > 0 || scanned.seen.some((item) => item.name === "--search-path")) return reads
  // grep reads stdin without a path, unless it recurses.
  const recursive = scanned.seen.some(
    (item) => item.name === "-r" || item.name === "--recursive" || ((item.name === "-d" || item.name === "--directories") && item.value === "recurse"),
  )
  if (kind === "grep" && !recursive) return reads
  return [...reads, base ?? "."]
}

const FIND_DENIED = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls", "-files0-from"])
const FIND_OPERATORS = new Set(["(", ")", "!", ",", "-not", "-a", "-and", "-o", "-or"])
const FIND_PLAIN = new Set(
  "-depth -mount -xdev -noleaf -ignore_readdir_race -noignore_readdir_race -daystart -follow -warn -nowarn -empty -executable -readable -writable -nogroup -nouser -true -false -print -print0 -ls -prune -quit -help --help -version --version"
    .split(" "),
)
const FIND_VALUE = new Set(
  "-maxdepth -mindepth -regextype -amin -atime -cmin -ctime -mmin -mtime -used -fstype -gid -uid -group -user -inum -links -name -iname -regex -iregex -perm -size -type -xtype -context -printf"
    .split(" "),
)
// A value that names a file, or a pattern that is read as a path (mirrored on purpose).
const FIND_PATH = new Set(["-newer", "-anewer", "-cnewer", "-samefile", "-path", "-wholename", "-ipath", "-iwholename", "-lname", "-ilname"])

type Find = { leading: string[]; starts: string[]; expression: { name: string; value?: string }[]; reads: string[] }

// find is an allowlist: an option or a primary that is not listed refuses. Arguments are read in GNU find's own order,
// so a leading `-O3` or `-D tree` does not hide the start points.
function findParse(args: string[]): Find | undefined {
  if (args.some((arg) => FIND_DENIED.has(arg))) return undefined
  const leading: string[] = []
  let index = 0
  let dashes = false
  for (; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-H" || arg === "-L" || arg === "-P") leading.push(arg)
    else if (arg === "-D") {
      if (args[index + 1] === undefined) return undefined
      index++
    } else if (/^-O\d+$/.test(arg)) continue
    else if (arg === "--") {
      dashes = true
      index++
      break
    } else break
  }
  const after = index
  const starts: string[] = []
  for (; index < args.length; index++) {
    const arg = args[index]
    if ((arg.length > 1 && arg.startsWith("-")) || FIND_OPERATORS.has(arg)) break
    starts.push(arg)
  }
  const expression: Find["expression"] = []
  const reads = starts.length > 0 ? [...starts] : ["."]
  while (index < args.length) {
    const arg = args[index++]
    if (FIND_OPERATORS.has(arg) || FIND_PLAIN.has(arg)) {
      expression.push({ name: arg })
      continue
    }
    const path = FIND_PATH.has(arg) || /^-newer[aBcmt][aBcmt]$/.test(arg)
    if (!path && !FIND_VALUE.has(arg)) return undefined
    const value = args[index++]
    if (value === undefined) return undefined
    expression.push({ name: arg, value })
    if (path) reads.push(value)
  }
  // After `--` the reference collects every word as a path, predicates included, and so does this.
  if (dashes) reads.push(...args.slice(after))
  return { leading, starts, expression, reads }
}

function find(args: string[], ctx: ShellAnalysis.Context): Verdict {
  const parsed = findParse(args)
  return parsed ? { ok: true, reads: parsed.reads.map((path) => expandHome(path, ctx)) } : refuse("find")
}

const SUBSTITUTE_FLAGS = /^[gpiImM]*[1-9]?[gpiImM]*$/

// Two shapes only. A: print lines, `sed -n 5p file`. B: substitute stdin, `sed s/a/b/`. Any other sed asks.
function sed(args: string[], ctx: ShellAnalysis.Context): Verdict {
  const flags: string[] = []
  const operands: string[] = []
  let ends = false
  for (const arg of args) {
    if (ends || !isFlag(arg)) operands.push(arg)
    else if (arg === "--") ends = true
    else flags.push(arg)
  }
  const quiet = flags.some((flag) => flag === "--quiet" || flag === "--silent" || /^-[nErz]*n[nErz]*$/.test(flag))
  const printing = flags.every((flag) => ["--quiet", "--silent", "--regexp-extended", "--zero-terminated", "--posix"].includes(flag) || /^-[nErz]+$/.test(flag))
  const substituting = flags.every((flag) => ["--regexp-extended", "--posix"].includes(flag) || /^-[Er]+$/.test(flag))
  if (printing && quiet && operands.length > 0) {
    const script = SedScript.parse(operands[0])
    // Only `p`, with no address, a line number or a line range: a `$` or regex address is not read-only.
    if (!script.ok || !script.commands.every((item) => item.name === "p" && item.addresses.every((address) => address.kind === "line"))) return refuse("sed:script")
    return { ok: true, reads: operands.slice(1).map((path) => expandHome(path, ctx)) }
  }
  if (substituting && operands.length === 1) {
    const script = SedScript.parse(operands[0])
    if (!script.ok || script.commands.length !== 1) return refuse("sed:script")
    const item = script.commands[0]
    if (item.name !== "s" || item.addresses.length > 0 || item.delimiter !== "/" || !SUBSTITUTE_FLAGS.test(item.flags)) return refuse("sed:script")
    return { ok: true, reads: [] }
  }
  return refuse("sed:shape")
}

const XARGS_TARGETS = new Set(["echo", "wc", "grep", "head", "tail"])

// xargs turns what it reads into arguments. Its items are known only when the producer cannot make an item that means
// something else, so a target that opens its arguments needs a NUL-separated stream of regular files from find.
function xargs(args: string[], ctx: ShellAnalysis.Context, command: ShellAnalysis.Command, producer?: ShellAnalysis.Command): Verdict {
  // A file whose content names a share would be opened by `cat list | xargs cat`, and a text check cannot see content.
  if (ctx.platform === "win32") return refuse("xargs:platform")
  // A redirect, heredoc or herestring replaces what xargs reads.
  if (command.redirects.some((item) => item.read || item.op.startsWith("<"))) return refuse("xargs:input")
  const scanned = scanFlags(BASH.xargs, args)
  if (!scanned) return refuse("flag")
  const rest = scanned.rest ?? []
  // No target runs echo.
  if (rest.length === 0) return { ok: true, reads: [] }
  const target = rest[0]
  if (!XARGS_TARGETS.has(target)) return refuse("xargs:target")
  // xargs finds the target through PATH, as the shell does.
  if (/[\\/]/.test(target) || projectLocal(target, ctx)) return refuse("head:local")
  const targetArgs = rest.slice(1)
  const verdict = tool(target, targetArgs, ctx)
  if (!verdict.ok) return verdict
  const replacing = scanned.seen.some((item) => item.name === "-I")
  // Under -I {}, an item replaces a `{}` only when the argument is exactly `{}`: `{}/../x` would climb out of the item.
  if (replacing && targetArgs.some((arg) => arg.includes("{}") && arg !== "{}")) return refuse("xargs:replace")
  const reads = replacing ? verdict.reads.filter((path) => path !== "{}") : verdict.reads
  if (target === "echo") return { ok: true, reads }
  const nul = scanned.seen.some((item) => item.name === "-0") && !scanned.seen.some((item) => item.name === "-d")
  if (!nul || !regularFiles(producer, ctx)) return refuse("xargs:items")
  return { ok: true, reads }
}

// The producer prints only regular files under its own start points, each ended by NUL. A name cannot hold NUL, so no
// item splits in two. Names in the folder are hostile: `a /etc/passwd` splits at the blank, a link is followed by the
// target, and a name that starts with `-` becomes an option. find lists every item under a start point that does not
// start with `-`, and `-type f` leaves out links.
function regularFiles(producer: ShellAnalysis.Command | undefined, ctx: ShellAnalysis.Context) {
  if (!producer || producer.head !== "find" || !bash(producer, ctx).ok) return false
  const parsed = findParse(producer.argv.slice(1).map((word) => word.value))
  if (!parsed || parsed.starts.length === 0 || parsed.starts.some((start) => start.startsWith("-")) || parsed.leading.includes("-L")) return false
  const refused = new Set(["-o", "-or", ",", "!", "-not", "(", ")", "-follow", "-print", "-ls", "-printf", "-help", "--help", "-version", "--version"])
  if (parsed.expression.some((item) => refused.has(item.name))) return false
  let typed = false
  let printed = false
  for (const item of parsed.expression) {
    if (item.name === "-type" && item.value === "f") typed = true
    // Everything before a -print0 holds, so a -print0 ahead of -type f prints the rest.
    if (item.name === "-print0") {
      if (!typed) return false
      printed = true
    }
  }
  return printed
}

const NULL_SINK = /^(?:\/dev\/(?:null|stdout|stderr)|\/dev\/fd\/\d+)$/

// Writes go only to null sinks; a read target is a read path, and a target that is not literal refuses.
function redirects(command: ShellAnalysis.Command, ctx: ShellAnalysis.Context): Verdict {
  const reads: string[] = []
  for (const item of command.redirects) {
    if (item.write && !item.nullSink) return refuse("redirect:write")
    if (item.target !== undefined && (!item.literal || item.glob)) return refuse("redirect:word")
    if (item.target !== undefined && special(item.target)) return refuse("special")
    if (item.target !== undefined && ctx.platform === "win32" && windowsShare(item.target)) return refuse("unc")
    if (item.read && item.target !== undefined) reads.push(expandHome(item.target, ctx))
  }
  return { ok: true, reads }
}

export function nullSink(target: string) {
  return NULL_SINK.test(target)
}

function unquote(text: string) {
  return text.replaceAll("`", "").replace(/^["']|["']$/g, "")
}

// The named providers, also module-qualified (`Microsoft.PowerShell.Core\Registry::HKLM`). Checked on every argument.
// Any "Name::" is a provider-qualified path (FileSystem::\\host\share) in whatever position it stands.
function namedProvider(text: string) {
  const plain = unquote(text).replace(/^[\w.]+\\(?=[\w.]+:)/, "")
  return /^(?:env|hklm|hkcu|function|alias|variable|cert|wsman|registry):/i.test(plain) || /^[\w.]+::/.test(plain)
}

// A UNC path or WebDAV marker, and on Windows the /proc/sys spelling. Checked on every argument.
function share(text: string, ctx: ShellAnalysis.Context) {
  const plain = unquote(text)
  return /^(?:\\\\|\/\/)/.test(plain) || (ctx.platform === "win32" ? windowsShare(plain) : networkPath(plain))
}

// A drive of two or more characters (`ab:\x`) is a provider, but only a path position reads it so: `-Format HH:mm` is a format.
function drive(text: string) {
  return /^[A-Za-z][A-Za-z0-9_.]+:/.test(unquote(text).replace(/^[\w.]+\\(?=[\w.]+:)/, ""))
}

const CONSTANT = new Set(["StringConstantExpressionAst", "ConstantExpressionAst"])

// Windows PowerShell 5.1 (and pwsh before 7.3) builds a native command line without escaping: a value with whitespace is
// wrapped in quotes, so an embedded `"` closes the wrapper early and a trailing `\` escapes its closing quote. The
// program's C runtime then splits the line again, so one judged value can arrive as several arguments.
function splits(value: string) {
  return value.includes('"') || (/\s/.test(value) && value.endsWith("\\"))
}

/** Whether one PowerShell command is allowlisted, and the paths it reads. `command.head` is the alias-resolved name. */
export function powershell(command: ShellAnalysis.Command, ctx: ShellAnalysis.Context, later: boolean): Verdict {
  const source = command.source
  if (!source || source.placeholder || source.operator || source.nested || command.dynamicHead) return refuse("command")
  if (command.application) return refuse("application")
  const head = command.head
  if (!Object.hasOwn(POWERSHELL, head)) return refuse("head:unlisted")
  const spec = POWERSHELL[head]
  if (spec.native && projectLocal(head, ctx)) return refuse("head:local")
  if (head === "out-null" && !later) return refuse("position")
  const reads: string[] = []
  // What the next positional argument is, after a parameter that takes a value.
  let pending: "path" | "other" | undefined
  let positional = 0
  // Select-String binds its positional arguments after all named ones are known: `Select-String C:\x -Pattern foo` gives
  // the path slot to `C:\x`, because -Pattern is named. Slot 1 is the pattern, slot 2 the path.
  const named = spec.binding
    ? new Set(source.arguments.filter((arg) => arg.kind === "CommandParameterAst").map((arg) => (arg.parameter ?? "").toLowerCase()))
    : undefined
  const slots = named
    ? [...(named.has("pattern") ? [] : ["pattern"]), ...(["path", "literalpath", "inputobject"].some((name) => named.has(name)) ? [] : ["path"])]
    : []
  let slot = 0
  // findstr: its words, and what its flags read.
  const words: string[] = []
  const found = { files: [] as string[], directories: [] as string[], search: false }
  for (const arg of source.arguments) {
    const bound = arg.bound
    // A parameter bound with a colon must have a constant value, and so must every other argument.
    if (arg.kind === "CommandParameterAst") {
      pending = undefined
      if (bound && !(CONSTANT.has(bound.kind) && bound.value !== undefined)) return refuse("bound")
      const name = (arg.parameter ?? "").toLowerCase()
      // The value of any colon-bound parameter is an argument like the rest: a share or provider path is refused here.
      if (bound?.value !== undefined && (namedProvider(bound.value) || share(bound.value, ctx))) return refuse("provider")
      if (spec.native) {
        if (bound?.value !== undefined && splits(bound.value)) return refuse("argument:split")
        // `-s:host` is the flag `-s` with a value (tasklist and getmac take a remote system that way), so the name is
        // checked bound or not.
        if (spec.flags === "any") continue
        if (spec.flags === "none" || !spec.flags.has(`-${name}`)) return refuse("flag")
        continue
      }
      if (spec.flags === "none") return refuse("flag")
      if (spec.flags !== "any" && !spec.flags.has(name) && !COMMON.has(name)) return refuse("flag")
      if (spec.paths?.has(name)) {
        if (bound?.value === undefined) pending = "path"
        else if (drive(bound.value)) return refuse("provider")
        else reads.push(bound.value)
      } else if (!bound && (spec.other?.has(name) || COMMON_VALUED.has(name))) pending = "other"
      continue
    }
    // What this argument is: a path that is read, some other value, or (a positional of a command that reads) a path.
    if (named && pending === undefined && slots[slot] === undefined) return refuse("positional")
    const role = pending ?? (named ? (slots[slot] === "path" ? "path" : "other") : spec.reads ? "path" : undefined)
    if (arg.kind === "ArrayLiteralAst") {
      // A native program may receive the elements as separate arguments (whitespace or a comment after a comma), so a flag in a later element would escape the flag rules.
      if (spec.native) return refuse("array:native")
      // Decided from the parser's elements, never from the array's text: a space, comment or continuation after a comma hides an element from a split.
      if (!arg.elements?.length || arg.elements.some((item) => !CONSTANT.has(item.kind) || item.value === undefined)) return refuse("argument")
      // The reads of an array in a path position cannot be told apart from one relative path, so they are not validated.
      if (role === "path") return refuse("array:path")
      if (arg.elements.some((item) => namedProvider(item.value!) || share(item.value!, ctx))) return refuse("provider")
    } else if (!CONSTANT.has(arg.kind) || arg.value === undefined) return refuse("argument")
    const text = arg.value ?? arg.text
    if (namedProvider(text) || share(text, ctx)) return refuse("provider")
    if (role === "path" && drive(text)) return refuse("provider")
    if (spec.native && splits(text)) return refuse("argument:split")
    if (spec.native && (text.startsWith("-") || (ctx.platform === "win32" && text.startsWith("/")))) {
      // `/s:host` is `/s` with a value: the flag is what comes before the colon.
      const flag = text.toLowerCase().split(":")[0]
      if (spec.flags !== "any" && (spec.flags === "none" || !spec.flags.has(flag))) return refuse("flag")
      if (spec.findstr) {
        const value = text.slice(flag.length + 1)
        // /G: names a file of patterns, /D: a list of folders, /C: the search text. The values are judged like any argument.
        if (flag === "/c") found.search = true
        if ((flag === "/g" || flag === "/d") && (text.length === flag.length || value === "")) return refuse("flag")
        if ((flag === "/g" || flag === "/d") && (namedProvider(value) || share(value, ctx) || drive(value))) return refuse("provider")
        if (flag === "/g") {
          found.search = true
          found.files.push(value)
        }
        if (flag === "/d") found.directories.push(...value.split(";").filter(Boolean))
      }
      continue
    }
    if (spec.flags === "none" && !spec.native) return refuse("flag")
    if (spec.native) {
      if (spec.positional === false) return refuse("positional")
      if (spec.first && positional === 0 && text.toLowerCase() !== spec.first) return refuse("positional")
    }
    positional++
    if (named && pending === undefined) slot++
    pending = undefined
    if (spec.findstr) {
      words.push(text)
      continue
    }
    if (role === "path") reads.push(text)
  }
  if (spec.findstr) {
    // With /C: or /G: every word is a file; otherwise the first word is the search text. A /D: list is each file's base.
    const files = found.search ? words : words.slice(1)
    reads.push(...found.files, ...found.directories, ...files.flatMap((item) => (found.directories.length > 0 ? found.directories.map((dir) => ctx.path.join(dir, item)) : [item])))
  }
  if (spec.first && positional === 0) return refuse("positional")
  if (spec.reads && reads.length === 0 && spec.default) reads.push(spec.default)
  return { ok: true, reads: reads.map((path) => expandHome(path, ctx)) }
}

