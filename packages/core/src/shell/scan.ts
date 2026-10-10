export * as ShellScan from "./scan.js"

export type OpaqueReason =
  | "command-substitution"
  | "compound-command"
  | "dynamic-command-name"
  | "dynamic-execution"
  | "heredoc"
  | "invalid-redirect"
  | "invalid-structure"
  | "unterminated-escape"
  | "unterminated-quote"

export type Command = {
  resource: string
  words: string[]
  rawWords: string[]
  // Exclusive raw-token ends relative to resource, for source-shaped permission prefixes.
  wordEnds?: number[]
  statementHead?: true
  declaration?: true
  // Words after a trailing redirect are destinations in the legacy command span.
  redirectWordCount?: number
}

// Opaque describes a parsing limitation, not a permission decision.
export type Result = { kind: "scanned"; commands: Command[] } | { kind: "opaque"; reason: OpaqueReason }

// limit: size, depth or budget bound; syntax: bash would reject the text; unsupported: valid or unknown text this scanner declines.
export type OpaqueClass = "limit" | "syntax" | "unsupported"
// substitution and heredoc are Bash; subexpression and block are PowerShell. group is both.
export type Origin = "substitution" | "heredoc" | "group" | "subexpression" | "block"
export type WordFlags = {
  // Expansions seen unquoted or inside double quotes.
  parameter?: true
  command?: true
  arithmetic?: true
  process?: true
  // Unquoted pathname patterns and brace lists.
  glob?: true
  brace?: true
  // An unquoted leading ~ (or one after = or : in an assignment value) that bash replaces with a home folder.
  tilde?: true
  // A $'...' that bash decodes differently from the word shown here (see bashAnsiQuote), so its value is not known.
  undecoded?: true
}
export type Redirect = {
  operator: string
  // A file descriptor written before the operator, such as 2 in 2>f.
  fd?: string
  // Unquoted target word. Absent for fd duplications (2>&1, >&-) and heredocs.
  target?: string
  raw: string
  write: boolean
  // The target contains an expansion, glob or brace list, so its value is not known statically.
  dynamic: boolean
  nullSink: boolean
}
export type Assignment = { name: string; value: string; raw: string; append: boolean; flags: WordFlags }
export type Heredoc = { delimiter: string; quoted: boolean; tabs: boolean; body: string }
export type Features = { assignment: boolean; functionDefinition: boolean; background: boolean }
export type Detail = Command & {
  assignments: Assignment[]
  // Parallel to words.
  flags: WordFlags[]
  redirects: Redirect[]
  // Heredocs whose operator belongs to this node.
  heredocs: Heredoc[]
  // Commands scanned out of this node's expansions, groups and heredoc bodies.
  nested: Detail[]
  origin?: Origin
  // A statement with no command word: assignments, redirects or a group only.
  commandless?: true
}
export type Inspection =
  | { kind: "scanned"; commands: Detail[]; statements: Detail[]; features: Features }
  | { kind: "opaque"; reason: OpaqueReason; class: OpaqueClass }

// A member call on a type or an expression, or a read of the env: drive, found outside any nested block.
export type Invocation =
  // [Type]::Member( ; dynamic when the type or member is not literal text, such as $type::Member( or [T]::$name(.
  | { kind: "static"; type: string; member: string; dynamic?: true }
  // <expression>.Member( ; dynamic when the member is computed, such as $x.$name( or $x.('a'+'b')(.
  | { kind: "instance"; member: string; dynamic?: true }
  // $env:NAME or ${env:NAME}, also inside double quotes and expandable here-strings, and %NAME% after --%.
  | { kind: "env"; name: string }
  // [Type]value, -as [Type] or [Type]$x = ...: converting runs the type's constructors and converters.
  | { kind: "conversion"; type: string }
  // <expression>.Member = value or [Type]::Member = value: a property setter runs code. dynamic when the member is computed.
  | { kind: "setter"; member: string; type?: string; dynamic?: true }
export type PowerShellDetail = Command & {
  // Parallel to words. Single-quoted text has no flags; ( ) and @( ) count as command, because their value is computed.
  flags: WordFlags[]
  // Redirects of this statement. A merge such as 2>&1 has operator ">&" and no target.
  redirects: Redirect[]
  invocations: Invocation[]
  // Commands scanned out of this node's groups, blocks and subexpressions.
  nested: PowerShellDetail[]
  origin?: Origin
  // An expression statement (a quoted string, a variable, a group, a type literal or a here-string) that has redirects or invocations.
  commandless?: true
}
export type PowerShellFeatures = {
  // $x = ..., += and the like.
  assignment: boolean
  // An assignment whose target is $env:NAME.
  envAssignment: boolean
  // --% was seen.
  stopParsing: boolean
  // & or . ahead of a command; dynamic when the target is a variable, a group or another computed word.
  callOperator: false | "literal" | "dynamic"
  // Set-Alias, New-Alias, sal or nal as a command.
  aliasDefinition: boolean
  // function or filter
  functionDefinition: boolean
}
export type PowerShellInspection =
  | { kind: "scanned"; commands: PowerShellDetail[]; statements: PowerShellDetail[]; features: PowerShellFeatures }
  | { kind: "opaque"; reason: OpaqueReason; class: OpaqueClass }

type Scanned = { kind: "scanned"; commands: Detail[]; roots: Detail[]; features: Features }
type Opaque = Extract<Inspection, { kind: "opaque" }>
type PowerShellScanned = {
  kind: "scanned"
  commands: PowerShellDetail[]
  roots: PowerShellDetail[]
  features: PowerShellFeatures
}
type PowerShellOpaque = Extract<PowerShellInspection, { kind: "opaque" }>

const BASH_REDIRECTS = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">&", ">|", ">>", ">", "<"]
const BASH_DECLARATIONS = new Set(["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"])
// Builtins whose assignment arguments skip globbing. Bash still globs the arguments of unset.
const BASH_ASSIGNING_DECLARATIONS = new Set(["declare", "typeset", "export", "readonly", "local"])
const MAX_INPUT_LENGTH = 64 * 1024
const MAX_SUBSTITUTION_DEPTH = 32

export function inspect(input: string, shell?: "bash"): Inspection
export function inspect(input: string, shell: "powershell"): PowerShellInspection
export function inspect(input: string, shell: "bash" | "powershell"): Inspection | PowerShellInspection
export function inspect(input: string, shell: "bash" | "powershell" = "bash"): Inspection | PowerShellInspection {
  if (shell === "powershell") {
    const result = inspectPowerShell(input)
    if (result.kind === "opaque") return result
    return {
      kind: "scanned",
      commands: result.roots.filter((root) => !root.commandless),
      statements: result.roots.filter((root) => root.commandless),
      features: result.features,
    }
  }
  const result = inspectBash(input)
  if (result.kind === "opaque") return result
  return {
    kind: "scanned",
    commands: result.roots.filter((root) => !root.commandless),
    statements: result.roots.filter((root) => root.commandless),
    features: result.features,
  }
}

// Flattens the detail pass to the legacy command list, in the order it has always been emitted.
export function scan(input: string): Result {
  const result = inspectBash(input)
  if (result.kind === "opaque") return { kind: "opaque", reason: result.reason }
  return { kind: "scanned", commands: result.commands.map(plain) }
}

function plain(detail: Command): Command {
  return {
    resource: detail.resource,
    words: detail.words,
    rawWords: detail.rawWords,
    ...(detail.wordEnds ? { wordEnds: detail.wordEnds } : {}),
    ...(detail.statementHead ? { statementHead: detail.statementHead } : {}),
    ...(detail.declaration ? { declaration: detail.declaration } : {}),
    ...(detail.redirectWordCount !== undefined ? { redirectWordCount: detail.redirectWordCount } : {}),
  }
}

// depthLimitHit is set when a nesting bound refuses text, so the failure that follows is classed as a limit and not as bad syntax.
type Budget = { remaining: number; depthLimitHit: boolean }

function inspectBash(input: string): Scanned | Opaque {
  return scanBash(input, 0, { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH, depthLimitHit: false })
}

function scanBash(input: string, depth: number, budget: Budget): Scanned | Opaque {
  // Bound both nesting and total source visited by expansion scans.
  budget.remaining -= input.length
  if (input.length > MAX_INPUT_LENGTH || budget.remaining < 0 || depth > MAX_SUBSTITUTION_DEPTH)
    return { kind: "opaque", reason: "invalid-structure", class: "limit" }
  const fail = (reason: OpaqueReason): Opaque => ({
    kind: "opaque",
    reason,
    class: budget.depthLimitHit || depth >= MAX_SUBSTITUTION_DEPTH ? "limit" : "syntax",
  })
  const syntax = (reason: OpaqueReason): Opaque => ({ kind: "opaque", reason, class: "syntax" })
  const unsupported = (reason: OpaqueReason): Opaque => ({ kind: "opaque", reason, class: "unsupported" })
  // commands is the flat legacy sequence; roots is the tree whose nodes own their nested commands.
  const commands: Detail[] = []
  const roots: Detail[] = []
  const features: Features = { assignment: false, functionDefinition: false, background: false }
  const nestedCommands: Detail[] = []
  const pendingNested: Detail[] = []
  const pendingGroups: Detail[] = []
  const wordFlags: WordFlags[] = []
  const redirects: Redirect[] = []
  let flags: WordFlags = {}
  // One entry per open unquoted brace in the current word; true once it holds a comma or a range.
  const braces: boolean[] = []
  // Bracket expression state of the current word: 0 none, 1 after "[", 2 after the negation, 3 inside the set.
  let bracket: 0 | 1 | 2 | 3 = 0
  // Set once the current word holds a character a variable name cannot, so the name test is not repeated: testing the
  // word flattens its string, which made a run of "[" quadratic.
  let wordNotName = false
  const nameWord = () => {
    if (wordNotName) return false
    const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)
    wordNotName = !name && word.length > 0
    return name
  }
  // True while the next character names the parameter of the unquoted "$" just read.
  let parameterName = false
  let redirectOperator: string | undefined
  let redirectFd: string | undefined
  const words: string[] = []
  const rawWords: string[] = []
  const assignmentWords: boolean[] = []
  // Index of the first word that is not an assignment, or -1 while the command has only prefix assignments.
  let commandName = -1
  let word = ""
  let wordStarted = false
  let wordStart = 0
  let wordEnd = 0
  let commandEnd = 0
  let resourceEnd: number | undefined
  let redirectWordCount: number | undefined
  let assignmentWord = false
  let assignmentHeadUnsafe = false
  let segment = 0
  let quote: "single" | "double" | undefined
  let invalidRedirect = false
  let invalidStructure: false | "syntax" | "unsupported" = false
  let separated = false
  let redirectTarget = false
  let hasRedirect = false
  let dangling = false
  let inList = false
  let compoundEnd = false
  const heredocs: Array<{
    delimiter: string
    quoted: boolean
    tabs: boolean
    command?: Command
    start?: number
    record: Heredoc
    node?: Detail
  }> = []
  let nodeHeredocs: typeof heredocs = []
  const structures: Array<{
    kind: "if" | "while" | "until" | "for" | "case"
    phase: "header" | "condition" | "pattern" | "body" | "do"
    count: number
    sawElse?: boolean
  }> = []

  const adopt = (result: Scanned, origin: Origin, target: Detail[]) => {
    result.roots.forEach((root) => (root.origin ??= origin))
    target.push(...result.roots)
    features.assignment ||= result.features.assignment
    features.functionDefinition ||= result.features.functionDefinition
    features.background ||= result.features.background
  }
  const addSubstitutions = (
    substitution: BashExpansion,
    target = pendingNested,
    origin: Origin = "substitution",
  ): Opaque | undefined => {
    for (const source of substitution.substitutions ?? [substitution.source]) {
      const result = scanBash(source, depth + 1, budget)
      if (result.kind === "opaque") return result
      nestedCommands.push(...result.commands)
      adopt(result, origin, target)
    }
  }
  const statement = () => {
    const structure = structures.at(-1)
    if (structure) structure.count++
  }
  const header = () => ["header", "pattern", "do"].includes(structures.at(-1)?.phase ?? "")

  // Only a prefix assignment or an argument of a declaration builtin is exempt from globbing and brace expansion.
  // Anywhere else an assignment-looking word (echo A=*) expands like any other argument.
  // Bash still brace-expands a declaration argument (export B={a,b} runs as export B=a B=b), so only the glob check
  // accepts a declaration builtin.
  const assignmentExempt = (brace: boolean) => {
    if (!assignmentWord || redirectTarget) return false
    return commandName < 0 || (!brace && BASH_ASSIGNING_DECLARATIONS.has(rawWords[commandName]))
  }

  // Feeds one literal character of the word to the bracket expression matcher. A set needs a member before its
  // closing "]", and a first "]" is that member ("[]a]"). Quoted characters are members and never close a set.
  const feedBracket = (char: string, quoted: boolean) => {
    if (bracket === 0) {
      if (!quoted && char === "[") bracket = 1
      return
    }
    if (bracket === 1 && !quoted && (char === "!" || char === "^")) bracket = 2
    else if (bracket < 3) bracket = 3
    else if (!quoted && char === "]") {
      bracket = 0
      if (!assignmentExempt(false)) flags.glob = true
    }
  }
  const finishWord = () => {
    if (!wordStarted) return
    braces.length = 0
    bracket = 0
    if (!redirectTarget) {
      words.push(word)
      // Unquoted trailing continuations are ignored syntax, not part of the raw token.
      rawWords.push(input.slice(wordStart, wordEnd))
      if (!assignmentWord && commandName < 0) commandName = words.length - 1
      assignmentWords.push(assignmentWord)
      wordFlags.push(flags)
      commandEnd = wordEnd
    } else if (redirectOperator) {
      // A file descriptor duplication (2>&1, >&-) names a descriptor, not a file.
      const duplication = (redirectOperator === ">&" || redirectOperator === "<&") && /^(?:\d+-?|-)$/.test(word)
      const dynamic = Object.keys(flags).length > 0
      redirects.push({
        operator: redirectOperator,
        ...(redirectFd ? { fd: redirectFd } : {}),
        ...(duplication ? {} : { target: word }),
        raw: input.slice(wordStart, wordEnd),
        write:
          [">", ">>", ">|", "&>", "&>>", "<>"].includes(redirectOperator) ||
          (redirectOperator === ">&" && !duplication),
        dynamic,
        nullSink: !duplication && !dynamic && /^\/dev\/(?:null|stdout|stderr|fd\/\d+)$/.test(word),
      })
    }
    redirectTarget = false
    redirectOperator = undefined
    redirectFd = undefined
    word = ""
    wordStarted = false
    assignmentWord = false
    assignmentHeadUnsafe = false
    flags = {}
  }
  const commandlessNode = (resource: string, assignments: Assignment[]): Detail => {
    const node: Detail = {
      resource,
      words: [],
      rawWords: [],
      assignments,
      flags: [],
      redirects: [...redirects],
      heredocs: [],
      nested: [],
      commandless: true,
    }
    roots.push(node)
    return node
  }
  const finishCommand = (boundary = false) => {
    finishWord()
    if (redirectTarget) invalidRedirect = true
    redirectTarget = false
    redirectOperator = undefined
    redirectFd = undefined
    if (compoundEnd && words.length > 0) invalidStructure = "syntax"
    const resource = input.slice(segment, resourceEnd ?? wordEnd).replace(/^[ \t\n]+|[ \t\n]+$/g, "")
    const name = assignmentWords.findIndex((assignment) => !assignment)
    // An empty command name is valid bash that fails at run time, so it is declined, not rejected.
    if (name >= 0 && !words[name]) invalidStructure ||= "unsupported"
    if (rawWords[name] === "}") invalidStructure = "syntax"
    const assignments = words.slice(0, name < 0 ? words.length : name).flatMap((text, position) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[\s\S]*\])?(\+?)=([\s\S]*)$/.exec(text)
      if (!match) return []
      return [
        {
          name: match[1],
          value: match[3],
          raw: rawWords[position],
          append: match[2] === "+",
          flags: wordFlags[position],
        },
      ]
    })
    let node: Detail | undefined
    if (resource && name >= 0 && !header()) {
      const command: Detail = {
        resource,
        words: words.slice(name),
        rawWords: rawWords.slice(name),
        assignments,
        flags: wordFlags.slice(name),
        redirects: [...redirects],
        heredocs: [],
        nested: [],
        ...(name === 0 && BASH_DECLARATIONS.has(rawWords[0]) && resource.startsWith(rawWords[0])
          ? { declaration: true as const }
          : {}),
        ...(redirectWordCount !== undefined && redirectWordCount < words.length
          ? { redirectWordCount: redirectWordCount - name }
          : {}),
      }
      if (name === 0 && rawWords[0] === "coproc") features.background = true
      commands.push(command)
      roots.push(command)
      node = command
      if (resourceEnd === undefined) {
        for (const heredoc of heredocs) {
          if (heredoc.command) continue
          heredoc.command = command
          heredoc.start = segment
        }
      }
    } else if (!header() && !compoundEnd && (hasRedirect || boundary || separated)) {
      const assignmentOnly = assignmentWords.length > 0 && assignmentWords.every(Boolean)
      if (!assignmentOnly && !hasRedirect) invalidStructure = "syntax"
    }
    if (!node && !header() && (assignments.length || redirects.length || pendingGroups.length || nodeHeredocs.length))
      node = commandlessNode(resource, assignments)
    if (node) {
      node.nested.push(...pendingGroups.splice(0))
      // Expansions with no command to own them become top-level entries.
      if (node.commandless) roots.push(...pendingNested.splice(0))
      else node.nested.push(...pendingNested.splice(0))
      for (const entry of nodeHeredocs) {
        entry.node = node
        node.heredocs.push(entry.record)
      }
    } else roots.push(...pendingNested.splice(0), ...pendingGroups.splice(0))
    if (assignments.length) features.assignment = true
    nodeHeredocs = []
    redirects.length = 0
    wordFlags.length = 0
    commands.push(...nestedCommands.splice(0))
    if (!header() && (words.length > 0 || hasRedirect)) statement()
    words.length = 0
    rawWords.length = 0
    assignmentWords.length = 0
    commandName = -1
    separated = true
    hasRedirect = false
    resourceEnd = undefined
    redirectWordCount = undefined
    compoundEnd = false
  }

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    // Every branch consumes the name guard, so it never reaches the next word or a redirect target.
    const afterParameter = parameterName
    parameterName = false
    if (!wordStarted) {
      wordStart = index
      wordNotName = false
    }
    if (!quote && !wordStarted) {
      if (char === " " || char === "\t") continue
      const structure = structures.at(-1)
      const token = /^[A-Za-z_][A-Za-z0-9_]*(?=[ \t\n;()<>]|$)/.exec(input.slice(index))?.[0]
      if (structure?.kind === "case" && structure.phase === "header" && token === "in") {
        finishCommand()
        structure.phase = "pattern"
        index += token.length - 1
        segment = index + 1
        continue
      }
      if (structure?.phase === "pattern" && (char === "(" || char === "|")) continue
      if (structure?.phase === "pattern" && char === ")") {
        finishCommand()
        structure.phase = "body"
        structure.count = 0
        segment = index + 1
        continue
      }
      if (structure?.kind === "for" && structure.phase === "header" && char === "(" && input[index + 1] !== "(") {
        const values = bashExpansion(budget, input, index, depth, "array")
        if (!values) return fail("compound-command")
        finishCommand()
        const failure = addSubstitutions(values, roots)
        if (failure) return failure
        commands.push(...nestedCommands.splice(0))
        // Zsh permits a sublist or brace group directly after the value list, without do/done.
        structure.phase = "do"
        if (!/^(?:[ \t\n;]|\\\n|#[^\n]*(?:\n|$))*do(?=[ \t\n;]|$)/.test(input.slice(values.end + 1))) structures.pop()
        index = values.end
        segment = index + 1
        continue
      }
      if (!words.length && !hasRedirect && !compoundEnd) {
        const definition = bashFunctionHead(input, index)
        if (definition && !header()) {
          features.functionDefinition = true
          index += definition.length - 1
          segment = index + 1
          continue
        }
        if (
          !header() &&
          (token === "if" ||
            token === "while" ||
            token === "until" ||
            token === "for" ||
            token === "select" ||
            token === "case")
        ) {
          if (depth + structures.length >= MAX_SUBSTITUTION_DEPTH)
            return { kind: "opaque", reason: "compound-command", class: "limit" }
          structures.push({
            kind: token === "select" ? "for" : token,
            phase: ["for", "select", "case"].includes(token) ? "header" : "condition",
            count: 0,
          })
          index += token.length - 1
          segment = index + 1
          inList = false
          continue
        }
        if (
          token &&
          ["then", "elif", "else", "fi", "do", "done", "esac"].includes(token) &&
          (!header() ||
            (token === "do" && structure?.phase === "do") ||
            (token === "esac" && structure?.phase === "pattern"))
        ) {
          if (!structure || dangling) return syntax("compound-command")
          if (token === "then") {
            if (structure.kind !== "if" || structure.phase !== "condition" || !structure.count)
              return syntax("compound-command")
            structure.phase = "body"
          } else if (token === "elif" || token === "else") {
            if (structure.kind !== "if" || structure.phase !== "body" || !structure.count || structure.sawElse)
              return syntax("compound-command")
            structure.phase = token === "elif" ? "condition" : "body"
            structure.sawElse = token === "else"
          } else if (token === "do") {
            if (
              !["for", "while", "until"].includes(structure.kind) ||
              !["condition", "do"].includes(structure.phase) ||
              (structure.kind !== "for" && !structure.count)
            )
              return syntax("compound-command")
            structure.phase = "body"
          } else {
            if (
              (token === "fi" && (structure.kind !== "if" || structure.phase !== "body" || !structure.count)) ||
              (token === "done" &&
                (!["for", "while", "until"].includes(structure.kind) ||
                  structure.phase !== "body" ||
                  !structure.count)) ||
              (token === "esac" && (structure.kind !== "case" || structure.phase === "header"))
            )
              return syntax("compound-command")
            structures.pop()
            statement()
            compoundEnd = true
            dangling = false
          }
          structure.count = 0
          index += token.length - 1
          segment = index + 1
          inList = false
          continue
        }
        if (
          !header() &&
          ((char === "!" && /[ \t\n]/.test(input[index + 1] ?? "")) ||
            (token === "coproc" &&
              /^coproc[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*[ \t]+)?(?:[{(]|(?:if|while|until|for|case)\b)/.test(
                input.slice(index),
              )) ||
            (token === "time" &&
              /^time[ \t]+(?:-p[ \t]+)?(?:[{(]|(?:if|while|until|for|case)\b)/.test(input.slice(index))))
        ) {
          index += token ? token.length - 1 : 0
          if (token === "time") index += /^[ \t]+-p\b/.exec(input.slice(index + 1))?.[0].length ?? 0
          if (token === "coproc") features.background = true
          if (token === "coproc")
            index +=
              /^[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+(?=[{(]|(?:if|while|until|for|case)\b)/.exec(
                input.slice(index + 1),
              )?.[0].length ?? 0
          segment = index + 1
          continue
        }
      }
      if (
        ((!words.length && !hasRedirect && !header()) || (structure?.kind === "for" && structure.phase === "header")) &&
        input.startsWith("((", index)
      ) {
        const expression = bashExpansion(budget, input, index, depth, "arithmetic")
        if (!expression) return fail("invalid-structure")
        const failure = addSubstitutions(expression, roots)
        if (failure) return failure
        commands.push(...nestedCommands.splice(0))
        statement()
        compoundEnd = !header()
        dangling = false
        index = expression.end
        segment = index + 1
        continue
      }
      if (
        !words.length &&
        !hasRedirect &&
        !header() &&
        (char === "(" || (char === "{" && /[ \t\n]/.test(input[index + 1] ?? "")))
      ) {
        const group = bashDelimited(budget, input, index, depth)
        if (!group || !group.source.trim()) return fail("invalid-structure")
        const result = scanBash(group.source, depth + 1, budget)
        if (result.kind === "opaque") return result
        commands.push(...result.commands)
        adopt(result, "group", pendingGroups)
        statement()
        compoundEnd = true
        dangling = false
        index = group.end
        segment = index + 1
        continue
      }
      if (!words.length && !hasRedirect && input.startsWith("[[", index)) {
        const expression = bashExpansion(budget, input, index, depth, "test")
        if (!expression) return fail("invalid-structure")
        const failure = addSubstitutions(expression, roots)
        if (failure) return failure
        commands.push(...nestedCommands.splice(0))
        statement()
        compoundEnd = true
        dangling = false
        index = expression.end
        segment = index + 1
        continue
      }
    }
    if (quote === "single") {
      wordStarted = true
      wordEnd = index + 1
      if (char === "'") quote = undefined
      else {
        feedBracket(char, true)
        word += char
      }
      continue
    }
    if (quote === "double") {
      wordStarted = true
      if (char === '"') quote = undefined
      else if (char === "\\" && index + 1 < input.length) {
        const next = input[index + 1]
        if ('$`"\\\n'.includes(next)) {
          index++
          if (next !== "\n") {
            feedBracket(next, true)
            word += next
          }
        } else {
          feedBracket(char, true)
          word += char
        }
      } else if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
        flags[expansionFlag(input, index)] = true
        const substitution = bashExpansion(budget, input, index, depth, undefined, true)
        if (!substitution || depth >= MAX_SUBSTITUTION_DEPTH) return fail("command-substitution")
        const failure = addSubstitutions(substitution)
        if (failure) return failure
        // A command substitution nested in another expansion is still a command.
        if (substitution.substitutions?.length) flags.command = true
        feedBracket("$", true)
        word += input.slice(index, substitution.end + 1)
        index = substitution.end
      } else {
        if (char === "$" && /[A-Za-z0-9_@*#?!$-]/.test(input[index + 1] ?? "")) flags.parameter = true
        feedBracket(char, true)
        word += char
      }
      wordEnd = index + 1
      continue
    }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return syntax("unterminated-quote")
      wordStarted = true
      if (!assignmentWord) assignmentHeadUnsafe = true
      if (literal.undecoded) flags.undecoded = true
      feedBracket("$", true)
      word += literal.value
      index = literal.end
      wordEnd = index + 1
      continue
    }
    if (char === "$" && input[index + 1] === '"') {
      quote = "double"
      wordStarted = true
      if (!assignmentWord) assignmentHeadUnsafe = true
      wordEnd = ++index + 1
      continue
    }
    if (char === "'") {
      quote = "single"
      wordStarted = true
      wordEnd = index + 1
      if (!assignmentWord) assignmentHeadUnsafe = true
      continue
    }
    if (char === '"') {
      quote = "double"
      wordStarted = true
      wordEnd = index + 1
      if (!assignmentWord) assignmentHeadUnsafe = true
      continue
    }
    if (char === "\\") {
      if (index + 1 >= input.length) return unsupported("unterminated-escape")
      if (input[index + 1] === "\n") index++
      else {
        wordStarted = true
        if (!assignmentWord) assignmentHeadUnsafe = true
        feedBracket(input[index + 1], true)
        word += input[++index]
        wordEnd = index + 1
      }
      continue
    }
    if (
      (char === "$" && "({[".includes(input[index + 1] ?? "\0")) ||
      char === "`" ||
      (char === "[" && nameWord() && /^\[[\s\S]*?\]\+?=/.test(input.slice(index))) ||
      (char === "(" && (assignmentWord || /[?*+@!]$/.test(word)))
    ) {
      if (char === "(") {
        if (!assignmentWord) flags.glob = true
      } else if (char === "[") {
        flags.arithmetic = true
        // Outside an assignment position bash does not read a[0]=x as an assignment, it globs it.
        if (redirectTarget || (commandName >= 0 && !BASH_ASSIGNING_DECLARATIONS.has(rawWords[commandName])))
          flags.glob = true
      } else flags[expansionFlag(input, index)] = true
      const substitution =
        char === "("
          ? bashExpansion(budget, input, index, depth, assignmentWord ? "array" : "pattern")
          : char === "["
            ? bashExpansion(budget, input, index, depth, "subscript")
            : bashExpansion(budget, input, index, depth)
      if (!substitution || depth >= MAX_SUBSTITUTION_DEPTH) return fail("command-substitution")
      const failure = addSubstitutions(substitution)
      if (failure) return failure
      // A command substitution nested in another expansion is still a command.
      if (substitution.substitutions?.length) flags.command = true
      // Array values are words of their own: they glob, brace-expand and substitute like arguments.
      if (char === "(" && assignmentWord) Object.assign(flags, arrayValueFlags(substitution.source))
      feedBracket("$", true)
      wordStarted = true
      word += input.slice(index, substitution.end + 1)
      index = substitution.end
      wordEnd = index + 1
      continue
    }
    if ((char === "<" || char === ">" || (char === "=" && !wordStarted)) && input[index + 1] === "(") {
      flags.process = true
      const substitution = bashDelimited(budget, input, index + 1, depth)
      if (!substitution || depth >= MAX_SUBSTITUTION_DEPTH) return fail("command-substitution")
      const failure = addSubstitutions(substitution)
      if (failure) return failure
      feedBracket("$", true)
      wordStarted = true
      word += input.slice(index, substitution.end + 1)
      index = substitution.end
      wordEnd = index + 1
      continue
    }
    if (char === "#" && !wordStarted) {
      const newline = input.indexOf("\n", index)
      if (words.length > 0 || hasRedirect) {
        finishCommand()
        dangling = false
        inList = false
      }
      if (newline === -1) break
      index = newline - 1
      segment = newline
      continue
    }
    const redirect = "<>&".includes(char)
      ? BASH_REDIRECTS.find((candidate) => input.startsWith(candidate, index))
      : undefined
    if (redirect) {
      hasRedirect = true
      if (redirectTarget) invalidRedirect = true
      if (wordStarted && !assignmentHeadUnsafe && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(word)) {
        // A continuation separates the legacy number token from the redirect descriptor.
        if (wordEnd < index) commandEnd = wordEnd
        redirectFd = word
        word = ""
        wordStarted = false
        flags = {}
        braces.length = 0
        bracket = 0
      } else finishWord()
      // Trailing redirects wrap a whole list/pipeline in the legacy grammar, not its last command.
      // Prefix redirects remain part of the command, and later words remain redirect destinations.
      if (redirectWordCount === undefined && assignmentWords.some((assignment) => !assignment)) {
        redirectWordCount = words.length
        if (inList) resourceEnd = commandEnd
      }
      if (redirect === "<<" || redirect === "<<-") {
        const delimiter = bashHeredocDelimiter(input, index)
        if (!delimiter) return syntax("invalid-redirect")
        const entry = {
          ...delimiter,
          record: { delimiter: delimiter.delimiter, quoted: delimiter.quoted, tabs: delimiter.tabs, body: "" },
        }
        heredocs.push(entry)
        nodeHeredocs.push(entry)
        redirects.push({
          operator: redirect,
          ...(redirectFd ? { fd: redirectFd } : {}),
          raw: input.slice(index, delimiter.end + 1),
          write: false,
          dynamic: false,
          nullSink: false,
        })
        redirectFd = undefined
        wordEnd = delimiter.end + 1
        index = delimiter.end
        redirectTarget = false
        continue
      }
      redirectTarget = true
      redirectOperator = redirect
      index += redirect.length - 1
      continue
    }
    if (structures.at(-1)?.phase === "pattern" && (char === ")" || char === "|")) {
      finishWord()
      index--
      continue
    }
    if ("()".includes(char)) return syntax("compound-command")
    if (/\s/.test(char) && !" \t\n".includes(char)) return unsupported("invalid-structure")
    if (char === " " || char === "\t") {
      finishWord()
      continue
    }
    const next = input[index + 1]
    const separator =
      (char === "&" && next === "&") || (char === "|" && (next === "|" || next === "&"))
        ? char + next
        : char === ";" || char === "|" || char === "&" || char === "\n"
          ? char
          : undefined
    if (separator) {
      const structure = structures.at(-1)
      if (char === ";" && structure?.kind === "case" && structure.phase === "body" && (next === ";" || next === "&")) {
        if (wordStarted || words.length || hasRedirect || compoundEnd) finishCommand()
        structure.phase = "pattern"
        index += input.startsWith(";;&", index) ? 2 : 1
        segment = index + 1
        inList = false
        continue
      }
      if (separator === "\n" && !wordStarted && words.length === 0 && !hasRedirect && !compoundEnd) {
        if (heredocs.length) {
          for (const heredoc of heredocs.splice(0)) {
            const body = bashHeredoc(input, index + 1, heredoc)
            if (!body) return unsupported("heredoc")
            if (heredoc.command) heredoc.command.resource = input.slice(heredoc.start, body.end).trim()
            heredoc.record.body = body.source
            if (!heredoc.quoted) {
              const expansion = bashExpansion(budget, body.source, 0, depth, "heredoc")
              if (!expansion) return fail("command-substitution")
              const failure = addSubstitutions(
                expansion,
                heredoc.node && !heredoc.node.commandless ? heredoc.node.nested : roots,
                "heredoc",
              )
              if (failure) return failure
              commands.push(...nestedCommands.splice(0))
            }
            index = body.end
          }
        }
        segment = index + 1
        continue
      }
      finishCommand(true)
      if (separator === "&") features.background = true
      if (structure?.kind === "for" && structure.phase === "header") structure.phase = "do"
      dangling = separator !== "&" && separator !== ";" && separator !== "\n"
      inList = dangling
      if (separator === "\n" && heredocs.length) {
        index--
        continue
      }
      index += separator.length - 1
      segment = index + 1
      continue
    }
    wordStarted = true
    if (char === "=" && !assignmentHeadUnsafe && /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?$/.test(word))
      assignmentWord = true
    feedBracket(char, false)
    // A "$" that is itself the name (the second one in $$) does not name the next character.
    if (char === "$" && !afterParameter && /[A-Za-z0-9_@*#?!$-]/.test(input[index + 1] ?? "")) {
      flags.parameter = true
      parameterName = true
    } else if (!afterParameter && !assignmentExempt(false) && (char === "*" || char === "?")) flags.glob = true
    else if (char === "~" && (index === wordStart || (assignmentWord && ":=".includes(input[index - 1]))))
      flags.tilde = true
    // Braces are tracked as a stack so every check stays linear in the word.
    else if (char === "{") braces.push(false)
    else if (char === "}" && braces.length) {
      if (braces.pop() && !assignmentExempt(true)) flags.brace = true
    } else if (braces.length && (char === "," || (char === "." && input[index + 1] === ".")))
      braces[braces.length - 1] = true
    word += char
    wordEnd = index + 1
  }

  if (quote) return syntax("unterminated-quote")
  if (heredocs.length) return unsupported("heredoc")
  if (wordStarted || words.length > 0 || hasRedirect) {
    finishCommand()
    dangling = false
  }
  if (pendingGroups.length) commandlessNode(input.slice(segment).trim(), []).nested.push(...pendingGroups.splice(0))
  if (dangling) invalidStructure = "syntax"
  if (invalidStructure)
    return invalidStructure === "syntax" ? syntax("invalid-structure") : unsupported("invalid-structure")
  if (invalidRedirect) return syntax("invalid-redirect")
  if (structures.length) return syntax("compound-command")
  return { kind: "scanned", commands, roots, features }
}

// Flags of the values in an array assignment, read lexically so a nested substitution is scanned only once, by
// addSubstitutions. It mirrors the word loop for the expansions bash performs on array values (parameter, command,
// arithmetic, process, glob with extglob, brace and tilde) and can over-report inside a substitution, which costs only
// an approval. Each branch below is pinned by a one-word cell in the array table.
function arrayValueFlags(source: string) {
  const flags: WordFlags = {}
  const braces: boolean[] = []
  let quote: "single" | "double" | undefined
  let wordStart = true
  // The unquoted character just before this one, for extglob patterns such as !(x).
  let last = ""
  // Whether the current element is a subscripted one ([1]=value), which expands ~ after = and :.
  let subscripted = false
  // Same states as the bracket matcher of the word loop.
  let bracket = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const before = last
    last = ""
    if (quote === "single") {
      if (char === "'") quote = undefined
      else if (bracket) bracket = 3
      continue
    }
    const quoted = quote === "double"
    if (wordStart && !quoted && !/\s/.test(char)) {
      // An element that opens with [ is subscripted, whatever the subscript holds; this only over-reports.
      subscripted = char === "["
    }
    if (char === "\\") {
      index++
      wordStart = false
      if (bracket) bracket = 3
      continue
    }
    if (char === "$" && !quoted && source[index + 1] === "'") {
      const literal = bashAnsiQuote(source, index + 1)
      if (literal) {
        if (literal.undecoded) flags.undecoded = true
        index = literal.end
        wordStart = false
        if (bracket) bracket = 3
        continue
      }
    }
    if (char === "$" || char === "`") {
      const next = source[index + 1] ?? ""
      if (char === "`" || "({[".includes(next)) flags[expansionFlag(source, index)] = true
      else if (/[A-Za-z0-9_@*#?!$-]/.test(next)) {
        flags.parameter = true
        index++
      }
      wordStart = false
      if (bracket) bracket = 3
      continue
    }
    if (char === '"') {
      quote = quoted ? undefined : "double"
      wordStart = false
      continue
    }
    if (!quoted && char === "'") {
      quote = "single"
      wordStart = false
      continue
    }
    if (!quoted && /\s/.test(char)) {
      wordStart = true
      braces.length = 0
      bracket = 0
      continue
    }
    if (!quoted && char === "~") {
      if (wordStart) flags.tilde = true
      else if ((before === "=" || before === ":") && subscripted) flags.tilde = true
    }
    if (!quoted && (char === "<" || char === ">") && source[index + 1] === "(") flags.process = true
    if (!quoted && char === "(" && "?*+@!".includes(before) && before) flags.glob = true
    if (!quoted) last = char
    wordStart = false
    if (bracket === 0) {
      if (!quoted && char === "[") bracket = 1
    } else if (bracket === 1 && !quoted && (char === "!" || char === "^")) bracket = 2
    else if (bracket < 3) bracket = 3
    else if (!quoted && char === "]") {
      bracket = 0
      flags.glob = true
    }
    if (quoted) continue
    if (char === "*" || char === "?") flags.glob = true
    else if (char === "{") braces.push(false)
    else if (char === "}" && braces.length) {
      if (braces.pop()) flags.brace = true
    } else if (braces.length && (char === "," || (char === "." && source[index + 1] === ".")))
      braces[braces.length - 1] = true
  }
  return flags
}

// Which expansion a backtick or dollar sign at index starts.
function expansionFlag(input: string, index: number): "parameter" | "command" | "arithmetic" {
  if (input[index] === "`") return "command"
  if (input.startsWith("$((", index) || input[index + 1] === "[") return "arithmetic"
  if (input[index + 1] === "{") return /^[ \t\n|]/.test(input.slice(index + 2, index + 3)) ? "command" : "parameter"
  return "command"
}

type BashExpansion = { source: string; end: number; substitutions?: string[] }

function bashFunctionHead(input: string, start: number) {
  // Share recognition with delimiter scanning so case patterns in function bodies do not close the outer group.
  // Names need not be variable identifiers. Zsh permits anonymous functions, including in an if condition.
  return /^(?!if(?:[ \t]|\\\n)*\()(?:function[ \t]+(?:\\\n[ \t]*)*[A-Za-z_][A-Za-z0-9_.:-]*(?:(?:[ \t]|\\\n)*\([ \t]*\))?|(?:[A-Za-z_][A-Za-z0-9_.:-]*(?:[ \t]|\\\n)*)?\([ \t]*\))(?:[ \t\n]|\\\n|#[^\n]*(?:\n|$))*(?=[{(]|\[\[(?=[ \t\n])|(?:if|while|until|for|select|case)[ \t\n])/.exec(
    input.slice(start),
  )?.[0]
}

function bashDelimited(budget: Budget, input: string, start: number, depth: number): BashExpansion | undefined {
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    budget.depthLimitHit = true
    return
  }
  const close = input[start] === "{" ? "}" : ")"
  const cases: Array<"header" | "pattern" | "body"> = []
  const heredocs: Array<{ delimiter: string; quoted: boolean; tabs: boolean }> = []
  let commandStart = true
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index]
    if (char === " " || char === "\t") continue
    if (char === "\\") {
      if (input[index + 1] !== "\n") commandStart = false
      index++
      continue
    }
    if (char === "'" || char === '"' || char === "`" || (char === "$" && "({['\"".includes(input[index + 1] ?? "\0"))) {
      commandStart = false
      if (char === "'" || input.startsWith("$'", index)) {
        const end = char === "'" ? input.indexOf("'", index + 1) : bashAnsiQuote(input, index + 1)?.end
        if (end === undefined || end < 0) return
        index = end
        continue
      }
      const nested =
        char === '"' || input.startsWith('$"', index)
          ? bashExpansion(budget, input, index + (char === "$" ? 1 : 0), depth + 1, "double")
          : bashExpansion(budget, input, index, depth + 1)
      if (!nested) return
      index = nested.end
      continue
    }
    const boundary = index === start + 1 || /[ \t\n;|&(){}]/.test(input[index - 1])
    const definition = commandStart && boundary ? bashFunctionHead(input, index) : undefined
    if (definition) {
      index += definition.length - 1
      continue
    }
    if (char === "#" && boundary) {
      const newline = input.indexOf("\n", index)
      if (newline < 0) return
      index = newline - 1
      continue
    }
    if (input.startsWith("<<<", index)) {
      index += 2
      continue
    }
    if (input.startsWith("<<", index)) {
      const delimiter = bashHeredocDelimiter(input, index)
      if (!delimiter) return
      heredocs.push(delimiter)
      index = delimiter.end
      continue
    }
    if (char === "\n" && heredocs.length) {
      for (const heredoc of heredocs.splice(0)) {
        const body = bashHeredoc(input, index + 1, heredoc)
        if (!body) return
        index = body.end
      }
      commandStart = true
      continue
    }
    const token = boundary ? /^[A-Za-z_][A-Za-z0-9_]*(?=[ \t\n;()<>]|$)/.exec(input.slice(index))?.[0] : undefined
    if (token === "case" && commandStart) cases.push("header")
    if (token === "in" && cases.at(-1) === "header") cases[cases.length - 1] = "pattern"
    if (token === "esac" && (commandStart || cases.at(-1) === "pattern")) cases.pop()
    if (token) {
      commandStart = commandStart && ["if", "while", "until", "then", "elif", "else", "do"].includes(token)
      index += token.length - 1
      continue
    }
    if (cases.length && char === ";" && /[;&]/.test(input[index + 1] ?? "")) cases[cases.length - 1] = "pattern"
    if (cases.at(-1) === "pattern" && char === "(") continue
    if (cases.at(-1) === "pattern" && char === ")") {
      cases[cases.length - 1] = "body"
      commandStart = true
      continue
    }
    if (input.startsWith("((", index)) {
      const nested = bashExpansion(budget, input, index, depth + 1, "arithmetic")
      if (!nested) return
      index = nested.end
      commandStart = false
      continue
    }
    if (char === "(" || (char === "{" && boundary && /[ \t\n]/.test(input[index + 1] ?? ""))) {
      const nested = bashDelimited(budget, input, index, depth + 1)
      if (!nested) return
      index = nested.end
      commandStart = false
      continue
    }
    if (char === close && (close === ")" || boundary)) return { source: input.slice(start + 1, index), end: index }
    if (/[\n;&|]/.test(char)) commandStart = true
    else if (!/[ \t]/.test(char)) commandStart = false
  }
}

function bashExpansion(
  budget: Budget,
  input: string,
  start: number,
  depth: number,
  mode?:
    | "arithmetic"
    | "arithmetic-group"
    | "subscript"
    | "array"
    | "pattern"
    | "double"
    | "test"
    | "heredoc"
    | "parameter",
  quoted = false,
): BashExpansion | undefined {
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    budget.depthLimitHit = true
    return
  }
  if (!mode && input[start] === "`") {
    let source = ""
    for (let index = start + 1; index < input.length; index++) {
      if (input[index] === "`") return { source, end: index }
      // Backticks remove one escape layer before their body is parsed as shell source.
      if (input[index] === "\\" && "$`\\\n".includes(input[index + 1] ?? "\0")) {
        if (input[++index] !== "\n") source += input[index]
        continue
      }
      source += input[index]
    }
    return
  }
  if (!mode && input.startsWith("$(", start) && !input.startsWith("$((", start))
    return bashDelimited(budget, input, start + 1, depth)
  if (!mode && /^\$\{[ \t\n|]/.test(input.slice(start))) {
    const nested = bashDelimited(budget, input, start + 1, depth)
    if (!nested) return
    return { ...nested, source: nested.source.startsWith("|") ? nested.source.slice(1) : nested.source }
  }
  const kind = mode ?? (input[start + 1] === "{" ? "parameter" : input[start + 1] === "[" ? "subscript" : "arithmetic")
  const arithmetic = ["arithmetic", "arithmetic-group", "subscript"].includes(kind)
  const offset = mode
    ? kind === "heredoc"
      ? 0
      : kind === "arithmetic" || kind === "test"
        ? 2
        : 1
    : kind === "arithmetic"
      ? 3
      : 2
  const close =
    kind === "heredoc"
      ? undefined
      : kind === "double"
        ? '"'
        : kind === "parameter"
          ? "}"
          : kind === "subscript"
            ? "]"
            : kind === "test"
              ? "]]"
              : kind === "arithmetic"
                ? "))"
                : ")"
  const substitutions: string[] = []
  for (let index = start + offset; index < input.length; index++) {
    const char = input[index]
    if (close && input.startsWith(close, index))
      return { source: input.slice(start + offset, index), end: index + close.length - 1, substitutions }
    if (char === "\\") {
      if ((kind !== "heredoc" && kind !== "double") || '$`\\\n"'.includes(input[index + 1] ?? "\0")) index++
      continue
    }
    if (
      (char === "'" || input.startsWith("$'", index)) &&
      kind !== "double" &&
      kind !== "heredoc" &&
      !arithmetic &&
      !(kind === "parameter" && quoted)
    ) {
      const end = char === "'" ? input.indexOf("'", index + 1) : bashAnsiQuote(input, index + 1)?.end
      if (end === undefined || end < 0) return
      index = end
      continue
    }
    if (char === '"' && kind !== "heredoc") {
      const nested = bashExpansion(budget, input, index, depth + 1, "double")
      if (!nested) return
      substitutions.push(...nested.substitutions!)
      index = nested.end
      continue
    }
    if (char === "`" || (char === "$" && "({[".includes(input[index + 1] ?? "\0"))) {
      const nested = bashExpansion(budget, input, index, depth + 1, undefined, kind === "double" || quoted)
      if (!nested) return
      substitutions.push(...(nested.substitutions ?? [nested.source]))
      index = nested.end
      continue
    }
    if (
      ((kind === "array" && "<>=".includes(char)) || (kind === "test" && "<>".includes(char))) &&
      input[index + 1] === "("
    ) {
      const nested = bashDelimited(budget, input, index + 1, depth + 1)
      if (!nested) return
      substitutions.push(nested.source)
      index = nested.end
      continue
    }
    if (
      ((arithmetic || kind === "array" || kind === "pattern") && (char === "(" || char === "[")) ||
      (kind === "parameter" && char === "[" && /^[!#]?[A-Za-z_][A-Za-z0-9_]*$/.test(input.slice(start + offset, index)))
    ) {
      const nested = bashExpansion(
        budget,
        input,
        index,
        depth + 1,
        char === "[" ? "subscript" : arithmetic ? "arithmetic-group" : kind,
      )
      if (!nested) return
      substitutions.push(...nested.substitutions!)
      index = nested.end
      continue
    }
    if (!mode && kind === "arithmetic" && char === ";") return
  }
  if (kind === "heredoc") return { source: input.slice(start), end: input.length - 1, substitutions }
}

// `undecoded` is set when bash reads an escape differently from this decoder: \x{..}, an escape that makes NUL (bash ends
// the string there), \c? (DEL), \c before a non-ASCII character (bash masks its first UTF-8 byte), and a numeric escape of
// 0x80 or more (the bytes of \u and \U depend on the locale; the other forms write a raw byte). The
// value stays as scan() has always read it; inspect() treats the word as dynamic and a heredoc delimiter is refused.
function bashAnsiQuote(input: string, start: number) {
  let value = ""
  let undecoded = false
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === "'") return { value, end: index, undecoded }
    if (input[index] !== "\\") {
      value += input[index]
      continue
    }
    const escaped = input[++index]
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    }
    if (escaped in simple) value += simple[escaped]
    else if (escaped === "c" && index + 1 < input.length) {
      // Bash's lexer ends the string at the first quote no backslash escapes, so \c' closes it and bash keeps \c.
      if (input[index + 1] === "'") {
        value += "\\c"
        continue
      }
      const control = input[++index]
      // A backslash control character swallows the next character in the lexer; the decoder drops it only when it is
      // a second backslash (\c\\ is one 0x1c) and otherwise keeps it as plain text.
      const code = control.toUpperCase().charCodeAt(0) & 31
      if (control === "?" || code === 0 || control > "\x7f") undecoded = true
      value += String.fromCharCode(code)
      if (control === "\\" && index + 1 < input.length) {
        index++
        if (input[index] !== "\\") value += input[index]
      }
    } else {
      if (escaped === "x" && input[index + 1] === "{") undecoded = true
      const digits =
        escaped === "x"
          ? /^[\da-fA-F]{1,2}/.exec(input.slice(index + 1))?.[0]
          : escaped === "u"
            ? /^[\da-fA-F]{1,4}/.exec(input.slice(index + 1))?.[0]
            : escaped === "U"
              ? /^[\da-fA-F]{1,8}/.exec(input.slice(index + 1))?.[0]
              : /[0-7]/.test(escaped ?? "")
                ? /^[0-7]{1,3}/.exec(input.slice(index))?.[0]
                : undefined
      if (!digits) value += `\\${escaped}`
      else {
        const octal = /[0-7]/.test(escaped)
        // Bash keeps one byte of an octal escape (\456 is "."). From 0x80 up \x and octal write that raw byte in every
        // locale; \u and \U write UTF-8 in a UTF-8 locale (a \U above U+10FFFF included) and keep the escape as text
        // under C or with LANG unset. This decoder writes neither, so the word is marked undecoded.
        const point = octal ? parseInt(digits, 8) & 0xff : parseInt(digits, 16)
        if (point === 0 || point >= 0x80) undecoded = true
        value += point <= 0x10ffff ? String.fromCodePoint(point) : ""
        index += digits.length - (octal ? 1 : 0)
      }
    }
  }
}

function bashHeredocDelimiter(input: string, start: number) {
  const tabs = input[start + 2] === "-"
  let delimiter = ""
  let quoted = false
  let quote: "'" | '"' | undefined
  let end = start
  let started = false
  for (let index = start + (tabs ? 3 : 2); index < input.length; index++) {
    const char = input[index]
    if (!started && /[ \t]/.test(char)) continue
    if (!started && char === "#") return
    if (!quote && /[ \t\n;&|()<>]/.test(char)) return started ? { delimiter, quoted, tabs, end } : undefined
    if (!quote && input.startsWith("$'", index)) {
      const literal = bashAnsiQuote(input, index + 1)
      // A delimiter bash decodes differently would end the heredoc at the wrong line and hide the commands after it.
      if (!literal || literal.undecoded) return
      delimiter += literal.value
      quoted = true
      started = true
      index = literal.end
      end = index
      continue
    }
    if (!quote && input.startsWith('$"', index)) {
      quote = '"'
      quoted = true
      started = true
      end = ++index
      continue
    }
    if (char === quote) {
      quote = undefined
      end = index
      continue
    }
    if (char === "\\" && quote !== "'") {
      const next = input[index + 1]
      if (next === undefined) return
      if (next === "\n") {
        index++
        continue
      }
      // Double quotes only remove escapes for shell-special characters.
      if (!quote || '$`"\\'.includes(next)) {
        quoted = true
        started = true
        delimiter += input[++index]
        end = index
        continue
      }
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      quoted = true
      started = true
      end = index
      continue
    }
    delimiter += char
    started = true
    end = index
  }
  if (started && !quote) return { delimiter, quoted, tabs, end }
}

function bashHeredoc(input: string, start: number, delimiter: { delimiter: string; tabs: boolean; quoted: boolean }) {
  const bodyStart = start
  let lineStart = start
  let line = ""
  for (let index = start; index <= input.length; index++) {
    if (index < input.length && input[index] !== "\n") continue
    const text = input.slice(start, index)
    line += delimiter.tabs ? text.replace(/^\t+/, "") : text
    if (!delimiter.quoted && /(?<!\\)(?:\\\\)*\\$/.test(line) && index < input.length) {
      line = line.slice(0, -1)
      start = index + 1
      continue
    }
    if (line === delimiter.delimiter) return { source: input.slice(bodyStart, lineStart), end: index }
    line = ""
    start = index + 1
    lineStart = start
  }
}

// Flattens the detail pass to the legacy command list, in the order it has always been emitted.
export function scanPowerShell(input: string): Result {
  const result = inspectPowerShell(input)
  if (result.kind === "opaque") return { kind: "opaque", reason: result.reason }
  return { kind: "scanned", commands: result.commands.map(plain) }
}

// depthLimitHit is set when a nesting bound refuses text, so the failure that follows is classed as a limit.
type PowerShellBudget = { remaining: number; depthLimitHit: boolean }

const POWERSHELL_ALIAS_COMMANDS = new Set(["set-alias", "new-alias", "sal", "nal"])
// Cmdlets that write an item, so naming the alias: or function: drive defines a command.
const POWERSHELL_DRIVE_WRITERS = new Set(
  "set-item si new-item ni set-content sc add-content ac rename-item rni ren rn copy-item cpi cp copy move-item mi mv move".split(
    " ",
  ),
)

function inspectPowerShell(input: string): PowerShellScanned | PowerShellOpaque {
  return scanPowerShellNested(input, 0, { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH, depthLimitHit: false })
}

function powerShellFeatures(): PowerShellFeatures {
  return {
    assignment: false,
    envAssignment: false,
    stopParsing: false,
    callOperator: false,
    aliasDefinition: false,
    functionDefinition: false,
  }
}

function mergePowerShellFeatures(into: PowerShellFeatures, from: PowerShellFeatures) {
  into.assignment ||= from.assignment
  into.envAssignment ||= from.envAssignment
  into.stopParsing ||= from.stopParsing
  into.aliasDefinition ||= from.aliasDefinition
  into.functionDefinition ||= from.functionDefinition
  if (from.callOperator === "dynamic" || (from.callOperator && !into.callOperator))
    into.callOperator = from.callOperator
}

function scanPowerShellNested(
  input: string,
  depth: number,
  budget: PowerShellBudget,
  hash = false,
): PowerShellScanned | PowerShellOpaque {
  budget.remaining -= input.length
  if (input.length > MAX_INPUT_LENGTH || depth >= MAX_SUBSTITUTION_DEPTH || budget.remaining < 0)
    return { kind: "opaque", reason: "invalid-structure", class: "limit" }
  // PowerShell's Unicode quotes, dashes, and whitespace differ from JavaScript's token rules.
  if (/[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/.test(input))
    return { kind: "opaque", reason: "invalid-structure", class: "unsupported" }
  const syntax = (reason: OpaqueReason): PowerShellOpaque => ({ kind: "opaque", reason, class: "syntax" })
  const blockFailure = (): PowerShellOpaque => ({
    kind: "opaque",
    reason: "invalid-structure",
    class: budget.depthLimitHit ? "limit" : "syntax",
  })
  // commands is the flat legacy sequence; roots is the tree whose nodes own their nested commands.
  const commands: PowerShellDetail[] = []
  const roots: PowerShellDetail[] = []
  const features = powerShellFeatures()
  const nestedCommands: PowerShellDetail[] = []
  const pendingNested: PowerShellDetail[] = []
  const pendingGroups: PowerShellDetail[] = []
  const redirects: Redirect[] = []
  let redirectPending: { operator: string; fd?: string } | undefined
  // Start of the statement's first word, so invocations are read from its own source.
  let statementStart = -1
  // Index of the first word after --%, which PowerShell passes on literally.
  let literalFrom = -1
  // The statement assigns with =, so a member before it is a setter call.
  let assigned = false
  const adopt = (result: PowerShellScanned, origin: Origin, target: PowerShellDetail[]) => {
    result.roots.forEach((root) => (root.origin ??= origin))
    target.push(...result.roots)
    nestedCommands.push(...result.commands)
    mergePowerShellFeatures(features, result.features)
  }
  const words: string[] = []
  const rawWords: string[] = []
  const wordEnds: number[] = []
  let segment = 0
  let word = ""
  let started = false
  let wordStart = 0
  let quote: "single" | "double" | undefined
  let standalone = false
  let expression = hash
  let compound = false
  let stopParsing = false
  let commandEnd = 0
  let statementHead = true
  let invalid = false
  let redirectTarget = false
  let comment = false
  let dangling = false
  let invocation = false

  const finishWord = (end: number) => {
    if (!started) return
    // Generic tokens can spell stop-parsing with escapes or embedded quotes; literal strings cannot.
    if (word === "--%" && words.length > 0 && !expression && !/['"]/.test(input[wordStart])) {
      stopParsing = true
      features.stopParsing = true
    }
    if (statementStart < 0) statementStart = wordStart
    if (!redirectTarget) {
      if (!words.length && !invocation && !expression) segment = wordStart
      words.push(word)
      rawWords.push(input.slice(wordStart, end))
      wordEnds.push(end)
      dangling = false
    } else if (redirectPending) {
      const raw = input.slice(wordStart, end)
      const flags = powerShellWordFlags(raw, word, depth, budget)
      const nullSink = /^\$null$/i.test(raw)
      redirects.push({
        operator: redirectPending.operator,
        ...(redirectPending.fd ? { fd: redirectPending.fd } : {}),
        target: word,
        raw,
        write: true,
        dynamic: !nullSink && Object.keys(flags).length > 0,
        nullSink,
      })
    }
    redirectPending = undefined
    commandEnd = end
    redirectTarget = false
    word = ""
    started = false
  }
  const finishCommand = (end: number, required = false) => {
    finishWord(end)
    const start = segment + input.slice(segment, commandEnd).search(/\S|$/)
    const resource = input.slice(start, commandEnd).trimEnd()
    const invocations =
      statementStart >= 0 ? powerShellInvocations(input.slice(statementStart, commandEnd), depth, budget, assigned) : []
    // PowerShell expands %NAME% in the text after --%.
    if (literalFrom >= 0)
      words.slice(literalFrom).forEach((text) => {
        for (const match of text.matchAll(/%([^%\s]+)%/g)) invocations.push({ kind: "env", name: match[1] })
      })
    let node: PowerShellDetail | undefined
    if (words.length && !expression) {
      const flags = rawWords.map((raw, position) =>
        literalFrom >= 0 && position >= literalFrom
          ? /%[^%\s]+%/.test(words[position])
            ? { parameter: true as const }
            : {}
          : powerShellWordFlags(raw, words[position], depth, budget),
      )
      node = {
        resource,
        words: [...words],
        rawWords: [...rawWords],
        wordEnds: wordEnds.map((end) => end - start),
        ...(statementHead && !invocation ? { statementHead: true as const } : {}),
        flags,
        redirects: [...redirects],
        invocations,
        nested: [],
      }
      commands.push(node)
      roots.push(node)
      if (invocation) {
        const target = Object.keys(flags[0]).length > 0 ? "dynamic" : "literal"
        mergePowerShellFeatures(features, { ...powerShellFeatures(), callOperator: target })
      }
      // A module-qualified name such as Microsoft.PowerShell.Utility\Set-Alias runs the same command.
      const name = words[0].toLowerCase().replace(/^[a-z_][\w.]*\\/, "")
      if (POWERSHELL_ALIAS_COMMANDS.has(name)) features.aliasDefinition = true
      // Writing to the alias: or function: drive defines one as well.
      if (POWERSHELL_DRIVE_WRITERS.has(name)) {
        if (words.some((text) => /^(?:-path:?)?alias:/i.test(text))) features.aliasDefinition = true
        if (words.some((text) => /^(?:-path:?)?function:/i.test(text))) features.functionDefinition = true
      }
    } else if ((!expression && invocation) || (required && !words.length && !nestedCommands.length)) invalid = true
    // Every expression statement is an entry, even a bare literal: it can run code through a cast or a setter.
    if (!node && (redirects.length > 0 || invocations.length > 0 || (expression && !compound && !hash && words.length > 0))) {
      node = {
        resource,
        words: [],
        rawWords: [],
        flags: [],
        redirects: [...redirects],
        invocations,
        nested: [],
        commandless: true,
      }
      roots.push(node)
    }
    if (node) {
      node.nested.push(...pendingGroups.splice(0))
      // Expansions with no command to own them become top-level entries.
      if (node.commandless) roots.push(...pendingNested.splice(0))
      else node.nested.push(...pendingNested.splice(0))
    } else roots.push(...pendingNested.splice(0), ...pendingGroups.splice(0))
    if (redirectTarget) invalid = true
    commands.push(...nestedCommands.splice(0))
    redirects.length = 0
    redirectPending = undefined
    assigned = false
    statementStart = -1
    literalFrom = -1
    words.length = 0
    rawWords.length = 0
    wordEnds.length = 0
    redirectTarget = false
    invocation = false
    expression = hash
    compound = false
    stopParsing = false
  }

  // True when the text before a line break ends in . or ::, which member access continues over. In an expression that
  // holds for any token; in a command argument Windows PowerShell 5.1 never continues, so the next line is a command.
  let expressionLedStart = -1
  let expressionLed = false
  const memberContinues = (at: number) => {
    let end = at
    // Windows PowerShell 5.1 treats form feed, vertical tab and Unicode spaces as blanks too.
    while (end > 0 && /[^\S\r\n]/.test(input[end - 1])) end--
    const accessor = input.startsWith("::", end - 2) ? 2 : input[end - 1] === "." ? 1 : 0
    if (accessor === 0 || quote) return false
    if (!expression) return false
    const before = input.slice(Math.max(0, end - accessor - 64), end - accessor)
    // A number such as 1. ends the statement.
    return !/(?:^|[^\w$.])[+-]?\d+$/.test(before) && before !== ""
  }
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (!started) wordStart = index
    if (stopParsing) {
      const stop = powerShellStopParsing(input, index)
      const text = input.slice(index, stop).trim()
      if (text) {
        wordStart = index + input.slice(index, stop).search(/\S/)
        word = text
        started = true
        if (literalFrom < 0) literalFrom = words.length
        finishWord(wordStart + text.length)
      }
      stopParsing = false
      index = stop - 1
      continue
    }
    if (quote === "single") {
      started = true
      if (char === "'" && input[index + 1] === "'") {
        word += "'"
        index++
      } else if (char === "'") {
        quote = undefined
        if (standalone) finishWord(index + 1)
      } else word += char
      continue
    }
    if (quote === "double") {
      if (char === '"' && input[index + 1] === '"') {
        word += '"'
        index++
      } else if (char === '"') {
        quote = undefined
        if (standalone) finishWord(index + 1)
      } else if (char === "`") {
        const escape = powerShellEscape(input, index)
        if (!escape) return syntax("unterminated-escape")
        word += escape.value
        index = escape.end
      } else if (char === "$" && input[index + 1] === "(") {
        const block = powerShellBlock(input, index + 1, depth, budget)
        if (!block) return blockFailure()
        const result = scanPowerShellNested(block.source, depth + 1, budget)
        if (result.kind === "opaque") return result
        adopt(result, "subexpression", pendingNested)
        word += input.slice(index, block.end + 1)
        index = block.end
      } else word += char
      continue
    }
    if (char === "'" || char === '"') {
      if (!started && words.length === 0 && !invocation) expression = true
      quote = char === "'" ? "single" : "double"
      standalone = !started
      started = true
      continue
    }
    // In a command argument or a redirect target Windows PowerShell 5.1 ends an expression word at a glued # or <# and
    // starts a comment, and continues a glued . or :: over a comment or a backtick-newline. The scanner reads those
    // as text, so it refuses the whole input instead of guessing.
    if (started && (redirectTarget || !expression)) {
      const blockOrLine = char === "#" || (char === "<" && input[index + 1] === "#")
      if (blockOrLine || (char === "`" && /[\r\n]/.test(input[index + 1] ?? ""))) {
        const accessor = input.startsWith("::", index - 2) ? 2 : input[index - 1] === "." ? 1 : 0
        if (accessor > 0 && /[\w)\]}"'$]/.test(input[index - accessor - 1] ?? ""))
          return syntax("invalid-structure")
        if (blockOrLine) {
          // Decided once per word: a regex at every # is quadratic in a word that holds many.
          if (expressionLedStart !== wordStart) {
            expressionLedStart = wordStart
            // A word that starts right after a group or a closing quote, such as the .a of @{a=1}.a, is a member too.
            expressionLed =
              /[)\]}"']/.test(input[wordStart - 1] ?? "") ||
              /^(?:-[^\s:]*:)?[$@"']/.test(input.slice(wordStart, wordStart + 80))
          }
          if (expressionLed) return syntax("invalid-structure")
        }
      }
    }
    if (char === "`") {
      if (/[\r\n]/.test(input[index + 1] ?? "") && memberContinues(index)) return syntax("invalid-structure")
      const escape = powerShellEscape(input, index)
      if (!escape) return syntax("unterminated-escape")
      // At a token boundary escaped whitespace is trivia, not a new argument.
      if (started || /\S/.test(escape.value)) {
        started = true
        word += escape.value
      }
      index = escape.end
      continue
    }
    if (!started && words.length > 0 && !expression && /^--%(?=$|[\s;|&(){}])/.test(input.slice(index))) {
      word = "--%"
      started = true
      finishWord(index + 3)
      stopParsing = true
      features.stopParsing = true
      index += 2
      continue
    }
    // After a trailing . or :: Windows PowerShell 5.1 also continues over comments and blank lines. The scanner does
    // not follow that, so it refuses the whole input instead of guessing where the member name is.
    if ((char === "#" || (char === "<" && input[index + 1] === "#")) && memberContinues(index))
      return syntax("invalid-structure")
    // A <# #> comment ends an expression token wherever it is glued to one; `$x<# c #>; ...` is not a line comment.
    if (char === "<" && input[index + 1] === "#" && (!started || (expression && !redirectTarget))) {
      if (started) finishWord(index)
      const end = powerShellComment(input, index)
      if (end === undefined) return syntax("invalid-structure")
      if (!words.length && !invocation) segment = end + 1
      index = end
      continue
    }
    if (char === "#" && (!started || (expression && !redirectTarget))) {
      if (words.length || started || invocation) finishCommand(index)
      statementHead = !dangling
      comment = true
      const endings = [input.indexOf("\n", index), input.indexOf("\r", index)].filter((ending) => ending >= 0)
      const newline = endings.length > 0 ? Math.min(...endings) : -1
      if (newline === -1) break
      comment = false
      index = input[newline] === "\r" && input[newline + 1] === "\n" ? newline + 1 : newline
      segment = index + 1
      continue
    }
    // A ">" ends an expression token such as $v, ${v}, $(...) or $x.Length, so `$v>f` writes f. It does not end a
    // generic argument token: Windows PowerShell 5.1 prints the text of `Write-Output a>f` and creates no file. A
    // $-led command argument such as `Write-Output $x>f` also ends at ">" here, which over-reports a write that 5.1
    // does not make; the over-report is the safe direction and a test pins it.
    if (char === ">" && started && !redirectTarget && input[index - 1] !== ">" && (expression || /^(?:\$|@[({])/.test(input.slice(wordStart, index))))
      finishWord(index)
    const redirect =
      !started && (char === ">" || char === "*" || /\d/.test(char)) ? powerShellRedirect(input, index) : undefined
    if (redirect === false) return syntax("invalid-redirect")
    if (redirect) {
      if (redirectTarget) return syntax("invalid-redirect")
      if (words.length === 0) return syntax("invalid-redirect")
      redirectTarget = !redirect.includes("&")
      const fd = /^(?:\*|\d+)/.exec(redirect)?.[0]
      if (redirectTarget) redirectPending = { operator: redirect.includes(">>") ? ">>" : ">", ...(fd ? { fd } : {}) }
      else
        redirects.push({
          operator: ">&",
          ...(fd ? { fd } : {}),
          // The destination, as the Bash scanner stores it.
          raw: redirect.slice(redirect.indexOf("&") + 1),
          write: false,
          dynamic: false,
          nullSink: false,
        })
      index += redirect.length - 1
      commandEnd = index + 1
      continue
    }
    if (!started && !words.length && !invocation && !expression && /[A-Za-z]/.test(char)) {
      const keyword = /^[A-Za-z]+(?=$|[\s({])/.exec(input.slice(index))?.[0]?.toLowerCase()
      if (
        keyword &&
        /^(?:if|elseif|else|for|while|do|until|switch|function|filter|try|catch|finally|begin|process|end|clean|param|trap|class|enum|data|dynamicparam|using)$/.test(
          keyword,
        )
      ) {
        expression = true
        compound = true
        if (keyword === "function" || keyword === "filter") features.functionDefinition = true
        index += keyword.length - 1
        continue
      }
      if (keyword === "foreach" && /^foreach\s*\(/i.test(input.slice(index))) {
        expression = true
        compound = true
        index += keyword.length - 1
        continue
      }
      if (keyword && /^(?:return|throw|exit|break|continue)$/.test(keyword)) {
        index += keyword.length - 1
        segment = index + 1
        continue
      }
    }
    if (expression && !compound && !redirectTarget && (char === "=" || (/[-+*/%]/.test(char) && input[index + 1] === "="))) {
      finishWord(index)
      // A hashtable entry or a type literal's content is not an assignment.
      if (!hash) {
        features.assignment = true
        assigned = true
        const target = rawWords[0] ?? ""
        if (/^(?:\[[^\]]*\])*\$(?:\{env:|env:)/i.test(target)) features.envAssignment = true
        // $alias:name = and $function:name = define a command like Set-Alias and function do.
        if (/^(?:\[[^\]]*\])*\$(?:\{alias:|alias:)/i.test(target)) features.aliasDefinition = true
        if (/^(?:\[[^\]]*\])*\$(?:\{function:|function:)/i.test(target)) features.functionDefinition = true
      }
      words.length = 0
      rawWords.length = 0
      wordEnds.length = 0
      expression = false
      if (char !== "=") index++
      segment = index + 1
      continue
    }
    if (expression && !started && /^in\b/i.test(input.slice(index))) {
      words.length = 0
      rawWords.length = 0
      wordEnds.length = 0
      expression = false
      index++
      segment = index + 1
      continue
    }
    if (char === "@" && /['"]/.test(input[index + 1] ?? "")) {
      const literal = powerShellHereString(input, index)
      if (!literal) return syntax("unterminated-quote")
      if (!words.length && !invocation) expression = true
      if (input[index + 1] === '"') {
        const result = powerShellExpansions(literal.source, depth + 1, budget)
        if (result.kind === "opaque") return result
        adopt(result, "subexpression", pendingNested)
      }
      word = literal.source
      started = true
      index = literal.end
      finishWord(index + 1)
      continue
    }
    if (char === "$" && input[index + 1] === "{") {
      const end = input.indexOf("}", index + 2)
      if (end < 0) return syntax("invalid-structure")
      if (!started && !words.length && !invocation) expression = true
      word += input.slice(index, end + 1)
      started = true
      index = end
      continue
    }
    const opener =
      (char === "$" || char === "@") && input[index + 1] === "("
        ? index + 1
        : char === "@" && input[index + 1] === "{"
          ? index + 1
          : char === "(" || char === "{" || (char === "[" && (expression || !started))
            ? index
            : undefined
    if (opener !== undefined) {
      if (started && (char === "{" || char === "(")) {
        finishWord(index)
        wordStart = index
      }
      if (!started && !words.length && !invocation) expression = true
      const block = powerShellBlock(input, opener, depth, budget)
      if (!block) return blockFailure()
      const result = scanPowerShellNested(
        block.source,
        depth + 1,
        budget,
        input[opener] === "[" || (char === "@" && input[opener] === "{"),
      )
      if (result.kind === "opaque") return result
      // Grouping passes objects, not text, so only $( ) and @( ) count as a subexpression.
      if (input[opener] === "(" && char !== "(") adopt(result, "subexpression", pendingNested)
      else adopt(result, input[opener] === "{" ? "block" : "group", pendingGroups)
      started = true
      word += input.slice(index, block.end + 1)
      index = block.end
      if (input[opener] === "{" || char === "(") finishWord(index + 1)
      if (compound && input[opener] === "{") {
        finishCommand(index + 1)
        segment = index + 1
      }
      continue
    }
    if (char === "}" || char === ")") return syntax("invalid-structure")
    if (
      !started &&
      words.length === 0 &&
      ((char === "&" && input[index + 1] !== "&") ||
        (char === "." && (/\s/.test(input[index + 1] ?? "") || !input[index + 1])))
    ) {
      if (invocation) return syntax("invalid-structure")
      invocation = true
      continue
    }
    if (!started && !words.length && !invocation && powerShellExpression(input.slice(index))) expression = true
    if (/\s/.test(char) && char !== "\n" && char !== "\r") {
      finishWord(index)
      continue
    }
    const next = input[index + 1]
    const separator =
      char === "\r" && next === "\n"
        ? char + next
        : (char === "&" && next === "&") || (char === "|" && next === "|")
          ? char + next
          : char === ";" || char === "|" || char === "&" || char === "\n" || char === "\r"
            ? char
            : undefined
    if (separator && (separator === "\n" || separator === "\r" || separator === "\r\n") && memberContinues(index)) {
      // Member access goes on over a line break after . or ::, so the next line is part of this statement. A second
      // line break or a comment in between continues too, but the scanner does not follow it.
      if (/^[^\S\r\n]*(?:[\r\n]|#|<#|`)/.test(input.slice(index + separator.length))) return syntax("invalid-structure")
      index += separator.length - 1
      continue
    }
    if (separator) {
      if (
        (separator === "\n" || separator === "\r" || separator === "\r\n") &&
        !started &&
        !words.length &&
        !invocation
      ) {
        index += separator.length - 1
        segment = index + 1
        continue
      }
      finishCommand(index, dangling || ![";", "\n", "\r", "\r\n"].includes(separator))
      dangling = ![";", "&", "\n", "\r", "\r\n"].includes(separator)
      statementHead = !dangling
      index += separator.length - 1
      segment = index + 1
      continue
    }
    started = true
    dangling = false
    word += char
  }

  if (quote) return syntax("unterminated-quote")
  if (!comment) finishCommand(input.length)
  if (redirectTarget || invalid || dangling) return syntax("invalid-structure")
  if (commands.some((command) => !command.words[0]))
    return { kind: "opaque", reason: "dynamic-command-name", class: "unsupported" }
  return { kind: "scanned", commands, roots, features }
}

function powerShellBlock(
  input: string,
  start: number,
  depth: number,
  budget: PowerShellBudget,
): { source: string; end: number } | undefined {
  if (depth >= MAX_SUBSTITUTION_DEPTH) {
    budget.depthLimitHit = true
    return
  }
  let quote: "single" | "double" | undefined
  let standalone = false
  let started = false
  let head = true
  let expression = false
  let token = ""
  const close = input[start] === "(" ? ")" : input[start] === "[" ? "]" : "}"
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index]
    if (quote === "single") {
      if (char === "'" && input[index + 1] === "'") {
        token += "'"
        index++
      } else if (char === "'") {
        quote = undefined
        started = !standalone
        if (standalone) token = ""
      } else token += char
      continue
    }
    if (quote === "double") {
      if (char === "`") {
        const escape = powerShellEscape(input, index)
        if (!escape) return
        token += escape.value
        index = escape.end
      } else if (char === '"' && input[index + 1] === '"') {
        token += '"'
        index++
      } else if (char === '"') {
        quote = undefined
        started = !standalone
        if (standalone) token = ""
      } else if (char === "$" && input[index + 1] === "(") {
        const nested = powerShellBlock(input, index + 1, depth + 1, budget)
        if (!nested) return
        index = nested.end
      } else token += char
      continue
    }
    if (char === "`") {
      const escape = powerShellEscape(input, index)
      if (!escape) return
      if (started || /\S/.test(escape.value)) {
        started = true
        token += escape.value
      }
      index = escape.end
      continue
    }
    if (char === "<" && input[index + 1] === "#" && !started) {
      const end = powerShellComment(input, index)
      if (end === undefined) return
      index = end
      continue
    }
    if (char === "#" && (!started || expression)) {
      const endings = [input.indexOf("\n", index), input.indexOf("\r", index)].filter((ending) => ending >= 0)
      const newline = endings.length > 0 ? Math.min(...endings) : -1
      if (newline < 0) return
      index = newline
      started = false
      head = true
      expression = false
      token = ""
      continue
    }
    if (char === "@" && /['"]/.test(input[index + 1] ?? "")) {
      const literal = powerShellHereString(input, index)
      if (!literal) return
      index = literal.end
      started = false
      head = false
      continue
    }
    if (
      head &&
      !started &&
      ((char === "&" && input[index + 1] !== "&") || (char === "." && /\s/.test(input[index + 1] ?? "")))
    ) {
      head = false
      continue
    }
    if (expression && (char === "=" || (!started && /^in\b/i.test(input.slice(index))))) {
      if (char !== "=") index++
      expression = false
      head = true
      started = false
      token = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double"
      standalone = !started
      if (head && !started) expression = true
      started = true
      continue
    }
    const redirect =
      !started && (char === ">" || char === "*" || /\d/.test(char)) ? powerShellRedirect(input, index) : undefined
    if (redirect === false) return
    if (redirect) {
      index += redirect.length - 1
      token = ""
      continue
    }
    if (char === "$" && input[index + 1] === "{") {
      const end = input.indexOf("}", index + 2)
      if (end < 0) return
      if (head && !started) expression = true
      index = end
      started = true
      continue
    }
    if (!started && !head && !expression && /^--%(?=$|[\s;|&(){}])/.test(input.slice(index))) {
      index = powerShellStopParsing(input, index + 3) - 1
      continue
    }
    if (char === close) return { source: input.slice(start + 1, index), end: index }
    if (char === "(" || char === "{" || (char === "[" && (!started || expression || close === "]"))) {
      if (head && !started) expression = true
      const nested = powerShellBlock(input, index, depth + 1, budget)
      if (!nested) return
      index = nested.end
      started = false
      head = false
      token = ""
      continue
    }
    if (/[\s;&|]/.test(char)) {
      if (token === "--%" && !expression) {
        index = powerShellStopParsing(input, index) - 1
        token = ""
        continue
      }
      if (/[;&|\r\n]/.test(char)) {
        head = true
        expression = false
      } else if (started) head = false
      started = false
      token = ""
      continue
    }
    if (head && !started && powerShellExpression(input.slice(index))) expression = true
    started = true
    token += char
  }
}

const POWERSHELL_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

function powerShellEscape(input: string, start: number) {
  const char = input[start + 1]
  if (char === undefined) return
  if (char === "\r" || char === "\n")
    return {
      value: char === "\r" && input[start + 2] === "\n" ? "\r\n" : char,
      end: start + (char === "\r" && input[start + 2] === "\n" ? 2 : 1),
    }
  if (char === "u" && input[start + 2] === "{") {
    const code = /^u\{([0-9a-f]{1,6})\}/i.exec(input.slice(start + 1))
    if (!code || Number.parseInt(code[1], 16) > 0x10ffff) return
    return { value: String.fromCodePoint(Number.parseInt(code[1], 16)), end: start + code[0].length }
  }
  return { value: POWERSHELL_ESCAPES[char] ?? char, end: start + 1 }
}

function powerShellExpression(input: string) {
  return /^(?:[$!,+]|[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?(?:[dDlLnNuU]|[kKmMgGtTpP][bB])?(?![\w'"`])|0[xX][\da-fA-F]+\b|0[bB][01]+\b|\.[0-9]|-(?:not|bnot|join|split)\b)/i.test(
    input,
  )
}

function powerShellStopParsing(input: string, start: number) {
  let quoted = false
  for (let index = start; index < input.length; index++) {
    if (input[index] === '"') quoted = !quoted
    if (input[index] === "\r" || input[index] === "\n" || (input[index] === "|" && !quoted)) return index
  }
  return input.length
}

function powerShellComment(input: string, start: number) {
  const end = input.indexOf("#>", start + 2)
  return end < 0 ? undefined : end + 1
}

function powerShellHereString(input: string, start: number) {
  const header = /^@['"][ \t]*(?:\r\n|\r|\n)/.exec(input.slice(start))
  if (!header) return
  const body = start + header[0].length
  for (let index = body; index < input.length; index++) {
    if (index !== body && input[index - 1] !== "\r" && input[index - 1] !== "\n") continue
    if (input[index] !== input[start + 1] || input[index + 1] !== "@") continue
    const end =
      index > body && input[index - 1] === "\n" && input[index - 2] === "\r"
        ? index - 2
        : index > body
          ? index - 1
          : index
    return { source: input.slice(body, end), end: index + 1 }
  }
}

function powerShellExpansions(
  input: string,
  depth: number,
  budget: PowerShellBudget,
): PowerShellScanned | PowerShellOpaque {
  const commands: PowerShellDetail[] = []
  const roots: PowerShellDetail[] = []
  const features = powerShellFeatures()
  for (let index = 0; index < input.length; index++) {
    if (input[index] === "`") {
      index++
      continue
    }
    if (!input.startsWith("$(", index)) continue
    const block = powerShellBlock(input, index + 1, depth, budget)
    if (!block) return { kind: "opaque", reason: "invalid-structure", class: budget.depthLimitHit ? "limit" : "syntax" }
    const result = scanPowerShellNested(block.source, depth + 1, budget)
    if (result.kind === "opaque") return result
    commands.push(...result.commands)
    roots.push(...result.roots)
    mergePowerShellFeatures(features, result.features)
    index = block.end
  }
  return { kind: "scanned", commands, roots, features }
}

// Expansion and wildcard flags of one word, read from its source spelling. Single-quoted text has none.
function powerShellWordFlags(raw: string, value: string, depth: number, parent: PowerShellBudget): WordFlags {
  const budget = scratchBudget(parent)
  const flags: WordFlags = {}
  // The file system provider replaces a leading ~ even when it is quoted.
  if (/^~(?:[\\/]|$)/.test(value)) flags.tilde = true
  const skip = (open: number) => powerShellBlock(raw, open, depth, budget)?.end
  let quote: "single" | "double" | undefined
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (quote === "single") {
      if (char === "'") {
        if (raw[index + 1] === "'") index++
        else quote = undefined
      }
      continue
    }
    if (char === "`") {
      index++
      continue
    }
    if (quote === "double") {
      if (char === '"') {
        if (raw[index + 1] === '"') index++
        else quote = undefined
        continue
      }
    } else if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double"
      continue
    }
    if (char === "$") {
      const next = raw[index + 1] ?? ""
      if (next === "(") {
        flags.command = true
        const end = skip(index + 1)
        if (end === undefined) break
        index = end
      } else if (next === "{") {
        flags.parameter = true
        const end = raw.indexOf("}", index + 2)
        if (end < 0) break
        index = end
      } else if (/[\w?$^:]/.test(next)) {
        flags.parameter = true
        // $? $$ and $^ are variables, so their second character is not a wildcard.
        if (!/\w/.test(next)) index++
      }
      continue
    }
    if (quote) continue
    if (char === "@" && raw[index + 1] === "(") flags.command = true
    if (char === "(") flags.command = true
    if ((char === "@" && (raw[index + 1] === "(" || raw[index + 1] === "{")) || char === "(" || char === "{") {
      const end = skip(char === "@" ? index + 1 : index)
      if (end === undefined) break
      index = end
      continue
    }
    if (char === "*" || char === "?") flags.glob = true
    // $x[0] and (expr)[0] are indexes. Any other [ may open a wildcard set, so a type literal argument is over-reported.
    if (char === "[" && !/^[$(@]/.test(raw)) flags.glob = true
  }
  return flags
}

// Member calls and env: reads in one statement's own source. Text inside ( ), { } and $( ) belongs to nested nodes.
function powerShellInvocations(
  source: string,
  depth: number,
  parent: PowerShellBudget,
  assigned: boolean,
): Invocation[] {
  const budget = scratchBudget(parent)
  const found: Invocation[] = []
  const envRead = /^\$(?:\{env:([^}]+)\}|env:([A-Za-z_]\w*))/i
  let closers: Map<number, number> | undefined
  let quote: "single" | "double" | undefined
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const skip = (open: number) => {
      const end = powerShellBlock(source, open, depth, budget)?.end
      if (end !== undefined) index = end
      return end !== undefined
    }
    if (quote === "single") {
      if (char === "'") {
        if (source[index + 1] === "'") index++
        else quote = undefined
      }
      continue
    }
    if (char === "`") {
      index++
      continue
    }
    if (quote === "double") {
      if (char === '"') {
        if (source[index + 1] === '"') index++
        else quote = undefined
      } else if (char === "$" && source[index + 1] === "(") {
        if (!skip(index + 1)) break
      } else if (char === "$") {
        const env = envRead.exec(source.slice(index))
        if (env) found.push({ kind: "env", name: env[1] ?? env[2] })
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double"
      continue
    }
    if (char === "<" && source[index + 1] === "#") {
      const end = powerShellComment(source, index)
      if (end === undefined) break
      index = end
      continue
    }
    if (char === "#" && /\s/.test(source[index - 1] ?? " ")) {
      const newline = source.slice(index).search(/[\r\n]/)
      if (newline < 0) break
      index += newline
      continue
    }
    if (char === "@" && /['"]/.test(source[index + 1] ?? "")) {
      const literal = powerShellHereString(source, index)
      if (!literal) break
      if (source[index + 1] === '"') found.push(...expandableEnvReads(literal.source, depth, budget))
      index = literal.end
      continue
    }
    if (char === "$") {
      const env = envRead.exec(source.slice(index))
      if (env) {
        found.push({ kind: "env", name: env[1] ?? env[2] })
        index += env[0].length - 1
      } else if (source[index + 1] === "(") {
        if (!skip(index + 1)) break
      } else if (source[index + 1] === "{") {
        const end = source.indexOf("}", index + 2)
        if (end < 0) break
        index = end
      }
      continue
    }
    if (char === "@" && (source[index + 1] === "(" || source[index + 1] === "{")) {
      if (!skip(index + 1)) break
      continue
    }
    if (char === "(" || char === "{") {
      if (!skip(index)) break
      continue
    }
    if (char === "[") {
      closers ??= typeLiteralEnds(source)
      const end = closers.get(index)
      if (end === undefined) continue
      const type = source.slice(index + 1, end).trim()
      const rest = source.slice(end + 1)
      const accessor = /^::\s*/.exec(rest)
      if (!accessor) {
        // [Type]operand and -as [Type] convert; [Type] alone, [Type].Name and a numeric index do not.
        if (
          // A [ right after a name is a generic argument list or an index, not a cast.
          !/\w/.test(source[index - 1] ?? "") &&
          /^[A-Za-z_][\w.+`,\s[\]]*$/.test(type) &&
          (/^\s*[$'"(@[{\w]|^\s*-\d/.test(rest) || /-as\s*$/i.test(source.slice(Math.max(0, index - 8), index)))
        )
          found.push({ kind: "conversion", type })
        continue
      }
      const memberStart = end + 1 + accessor[0].length
      const named = GENERIC_CALL.exec(source.slice(memberStart))
      if (named) found.push({ kind: "static", type, member: named[1] })
      else if (computedMember(source, memberStart, depth, budget))
        found.push({ kind: "static", type, member: "", dynamic: true })
      else if (assigned) {
        const setter = memberAssignment(source, memberStart)
        if (setter !== undefined) found.push({ kind: "setter", type, member: setter, ...(setter ? {} : { dynamic: true as const }) })
      }
      continue
    }
    if (char === ":" && source[index + 1] === ":" && source[index - 1] !== "]") {
      const accessor = /^::\s*/.exec(source.slice(index))
      const start = index + (accessor?.[0].length ?? 2)
      const named = GENERIC_CALL.exec(source.slice(start))
      const type = staticReceiver(source, index)
      if (named) found.push({ kind: "static", type, member: named[1], dynamic: true })
      else if (computedMember(source, start, depth, budget))
        found.push({ kind: "static", type, member: "", dynamic: true })
      else if (assigned) {
        const setter = memberAssignment(source, start)
        if (setter !== undefined) found.push({ kind: "setter", type, member: setter, dynamic: true })
      }
      index++
      continue
    }
    if (char === ".") {
      // Not a member access after whitespace or another dot (dot-sourcing, ranges, numbers).
      if (index === 0 || /[\s.;|&(,{=]/.test(source[index - 1])) continue
      const rest = source.slice(index + 1)
      const named = GENERIC_CALL.exec(rest.trimStart())
      const memberStart = index + 1 + rest.length - rest.trimStart().length
      if (named) found.push({ kind: "instance", member: named[1] })
      else if (computedMember(source, memberStart, depth, budget)) found.push({ kind: "instance", member: "", dynamic: true })
      else if (assigned) {
        const setter = memberAssignment(source, memberStart)
        if (setter !== undefined) found.push({ kind: "setter", member: setter, ...(setter ? {} : { dynamic: true as const }) })
      }
    }
  }
  return found
}

// Name( and, since PowerShell 7.3, Name[type, type]( for a generic method.
const GENERIC_CALL = /^([A-Za-z_]\w*)(?:\[[\w.,\s[\]]{0,200}\])?\(/

// The member name when the member at start is assigned (= += -= and the like), "" when it is computed, else undefined.
function memberAssignment(source: string, start: number) {
  const match = /^\s*(?:([A-Za-z_]\w*)|\$\{?[\w:]+\}?|'[^']*'|"[^"]*")\s*(?:[-+*/%]|\?\?)?=(?!=)/.exec(
    source.slice(start, start + 400),
  )
  return match ? (match[1] ?? "") : undefined
}

// env: reads in the body of an expandable here-string. Text inside $( ) belongs to the nested node.
function expandableEnvReads(body: string, depth: number, budget: PowerShellBudget) {
  const found: Invocation[] = []
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "`") index++
    else if (body[index] === "$" && body[index + 1] === "(") {
      const end = powerShellBlock(body, index + 1, depth, budget)?.end
      if (end === undefined) break
      index = end
    } else if (body[index] === "$") {
      const env = /^\$(?:\{env:([^}]+)\}|env:([A-Za-z_]\w*))/i.exec(body.slice(index, index + 300))
      if (env) found.push({ kind: "env", name: env[1] ?? env[2] })
    }
  }
  return found
}

// The non-scanner passes only look for what they report. A nesting bound they hit must not class a later syntax error as a limit.
function scratchBudget(budget: PowerShellBudget): PowerShellBudget {
  return { remaining: budget.remaining, depthLimitHit: false }
}

// True when a computed member name ($name, 'name', "name" or (expression)) at start is followed by a call.
function computedMember(source: string, start: number, depth: number, budget: PowerShellBudget) {
  const rest = source.slice(start)
  if (/^(?:\$\{?[\w:]+\}?|'[^']*'|"[^"]*")\(/.test(rest)) return true
  if (rest[0] !== "(") return false
  const block = powerShellBlock(source, start, depth, budget)
  return block !== undefined && source[block.end + 1] === "("
}

// Every [ of a type literal such as [IO.File] or [List[int]] mapped to its matching ]. A [ that closes nowhere before
// a character that cannot be inside a type name is absent. One pass keeps this linear however many [ the text has.
function typeLiteralEnds(source: string) {
  const ends = new Map<number, number>()
  let open: number[] = []
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === "[") open.push(index)
    else if (char === "]") {
      const start = open.pop()
      if (start !== undefined) ends.set(start, index)
    } else if (/[\r\n'"$(){};|]/.test(char)) open = []
  }
  return ends
}

// The token before a :: that names its type or variable, read backwards so a long prefix costs nothing.
function staticReceiver(source: string, colons: number) {
  const end = source[colons - 1] === "}" ? colons - 1 : colons
  let name = end
  while (name > 0 && /[\w:]/.test(source[name - 1])) name--
  const open = source[name - 1] === "{" ? name - 1 : name
  const dollar = name < end && source[open - 1] === "$" ? open - 1 : -1
  let plain = colons
  while (plain > 0 && /[\w.]/.test(source[plain - 1])) plain--
  if (dollar < 0) return source.slice(plain, colons)
  return source.slice(plain === colons ? dollar : Math.min(dollar, plain), colons)
}

function powerShellRedirect(input: string, index: number) {
  let cursor = index
  if (input[cursor] === "*") cursor++
  else while (/\d/.test(input[cursor] ?? "")) cursor++
  if (input[cursor] !== ">") return
  cursor++
  if (input[cursor] === ">") cursor++
  if (input[cursor] === "&") {
    cursor++
    while (/\d/.test(input[cursor] ?? "")) cursor++
  }
  const redirect = input.slice(index, cursor)
  return /^(?:(?:[1-6]|\*)?>>?|[2-6*]>&1)$/.test(redirect) ? redirect : false
}
