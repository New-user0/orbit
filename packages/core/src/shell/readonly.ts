export * as ShellReadOnly from "./readonly.js"

import type { ShellAnalysis } from "./analysis.js"

// Read-only is an allowlist. A head that has no entry here is never read-only, and neither is a flag that an entry does
// not list. "any" is used only for tools that read and print and have no flag that writes, runs a program or changes
// the machine. A false read-only verdict is a security bug, so every doubt is a refusal: a refusal costs one question.

export type Verdict = { ok: true; reads: string[] } | { ok: false; reason: string }

const refuse = (reason: string): Verdict => ({ ok: false, reason })

type Value = "string" | "number" | "char" | "path"
type Spec = {
  // "any" passes every flag. Otherwise a flag must be listed; "" means it takes no value.
  flags: "any" | Record<string, Value | "">
  // "any" specs only: options that take values, so the value is not taken for an operand.
  values?: Record<string, number>
  // Operands are read paths from `skip` on, unless `read` is false. `default` is read when there is no operand.
  operands?: { max?: number; min?: number; read?: boolean; skip?: number; default?: string }
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
        return [
          token.slice(0, index),
          kind === "path" ? "path" : kind === "number" ? "number" : kind === "char" ? "char" : "string",
        ]
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
  diff: { flags: "any", values: values("-U -C -L --label --unified --context -W --width -x --exclude -X --exclude-from"), operands: reading },
  tsort: { flags: "any", operands: reading },
  pr: { flags: "any", values: values("-h -l -w -o -N -s --header --length --width"), operands: reading },
  df: { flags: "any", values: values("-t -x --type --exclude-type --output -B --block-size"), operands: reading },
  du: { flags: "any", values: values("-d --max-depth -B --block-size -t --threshold -X --exclude-from --exclude"), operands: { read: true, default: "." } },
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
  return !value.startsWith("-")
}

// Walks `args` against a flag table. Returns the operands and the paths that flags read, or undefined for a refusal.
function scanFlags(spec: Spec, args: string[]) {
  const operands: string[] = []
  const reads: string[] = []
  const table = spec.flags === "any" ? undefined : spec.flags
  let ends = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (ends || !isFlag(token)) {
      operands.push(token)
      continue
    }
    if (token === "--") {
      if (spec.doubleDash === false) return undefined
      ends = true
      continue
    }
    const equals = token.indexOf("=")
    const name = equals < 0 ? token : token.slice(0, equals)
    if (!table) {
      // Unknown options take no value; an extra operand only adds a read path.
      const count = equals < 0 ? (spec.values?.[name] ?? 0) : 0
      index += count
      continue
    }
    const kind = Object.hasOwn(table, name) ? table[name] : undefined
    if (kind === undefined) {
      if (token.startsWith("--") || equals >= 0 || token.length < 3) return undefined
      // A bundle of single-letter flags passes only when every letter is known and takes no value.
      const bundle = [...token.slice(1)].every((letter) => Object.hasOwn(table, `-${letter}`) && table[`-${letter}`] === "")
      if (!bundle) return undefined
      continue
    }
    if (kind === "") {
      if (equals >= 0) return undefined
      continue
    }
    const value = equals >= 0 ? token.slice(equals + 1) : args[++index]
    if (value === undefined || (equals < 0 && isFlag(value)) || !valid(value, kind)) return undefined
    if (kind === "path") reads.push(value)
  }
  return { operands, reads }
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
const UNC = /(?<!:)(?:\\\\|\/\/|\/\\|\\\/)[^\s\\/]|[\\/]\?\?[\\/]/
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
export function bash(command: ShellAnalysis.Command, ctx: ShellAnalysis.Context): Verdict {
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
  if (!Object.hasOwn(BASH, head)) return refuse("head:unlisted")
  const spec = BASH[head]
  if (spec.exact) return args.length === 0 ? { ok: true, reads: redirected.reads } : refuse("args")
  const scanned = scanFlags(spec, args)
  if (!scanned) return refuse("flag")
  if (spec.check?.(args)) return refuse("check")
  const limits = spec.operands
  if (limits?.max !== undefined && scanned.operands.length > limits.max) return refuse("operands")
  if (limits?.min !== undefined && scanned.operands.length < limits.min) return refuse("operands")
  const operands = limits?.read ? scanned.operands : []
  const paths = [...scanned.reads, ...(operands.length === 0 && limits?.default && limits.read ? [limits.default] : operands)]
  return { ok: true, reads: [...paths.map((path) => expandHome(path, ctx)), ...redirected.reads] }
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
function namedProvider(text: string) {
  return /^(?:env|hklm|hkcu|function|alias|variable|cert|wsman|registry):/i.test(unquote(text).replace(/^[\w.]+\\(?=[\w.]+:)/, ""))
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
    if (arg.kind === "ArrayLiteralAst") {
      if (/[$(@{[]/.test(arg.text)) return refuse("argument")
      // The reads of an array in a path position cannot be told apart from one relative path, so they are not validated.
      if (pending === "path" || (pending === undefined && spec.reads)) return refuse("array:path")
      if (arg.text.split(",").some((item) => namedProvider(item) || share(item, ctx))) return refuse("provider")
    } else if (!CONSTANT.has(arg.kind) || arg.value === undefined) return refuse("argument")
    const text = arg.value ?? arg.text
    if (namedProvider(text) || share(text, ctx)) return refuse("provider")
    if ((pending === "path" || (pending === undefined && spec.reads)) && drive(text)) return refuse("provider")
    if (spec.native && (text.startsWith("-") || (ctx.platform === "win32" && text.startsWith("/")))) {
      // `/s:host` is `/s` with a value: the flag is what comes before the colon.
      if (spec.flags !== "any" && (spec.flags === "none" || !spec.flags.has(text.toLowerCase().split(":")[0]))) return refuse("flag")
      continue
    }
    if (spec.flags === "none" && !spec.native) return refuse("flag")
    if (spec.native) {
      if (spec.positional === false) return refuse("positional")
      if (spec.first && positional === 0 && text.toLowerCase() !== spec.first) return refuse("positional")
    }
    positional++
    if (pending === "path") reads.push(text)
    else if (pending === undefined && spec.reads) reads.push(text)
    pending = undefined
  }
  if (spec.first && positional === 0) return refuse("positional")
  if (spec.reads && reads.length === 0 && spec.default) reads.push(spec.default)
  return { ok: true, reads: reads.map((path) => expandHome(path, ctx)) }
}

