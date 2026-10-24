import { Argument, Flag, GlobalFlag } from "effect/unstable/cli"
import { Schema } from "effect"
import { Spec } from "../framework/spec"

export const PrintLogs = GlobalFlag.setting("print-logs")({
  flag: Flag.boolean("print-logs").pipe(
    Flag.withDescription("Print logs to stderr (server logs require --standalone)"),
    Flag.withDefault(false),
  ),
})

declare const ORBIT_CLI_NAME: string | undefined

const ServerParams = {
  standalone: Flag.boolean("standalone").pipe(
    Flag.withDescription("Run with a private server instead of the background service"),
    Flag.withDefault(false),
  ),
  server: Flag.string("server").pipe(
    Flag.withDescription("Connect to a server URL instead of the background service"),
    Flag.optional,
  ),
}

// For commands that start work in the current folder and stop, rather than ask, when its project config is held back or
// when they are about to load code from it, run the shell commands that a file in it defines, approve what its agents
// ask permission for, or run its nodes as agents that it names, because a workflow or suite file says so.
const TrustParams = {
  trust: Flag.boolean("trust").pipe(
    Flag.withDescription(
      "Trust this folder for this run only, so its project config applies, the code and commands it holds may run, and a workflow or suite in it may approve what its agents ask permission for or choose which of your agents run, and trust the folder of a workflow or suite file that lies in another project the same way; runs on a private server and cannot be combined with --server",
    ),
    Flag.withDefault(false),
  ),
}

const PermissionParams = {
  auto: Flag.boolean("auto").pipe(
    Flag.withDescription("Auto-approve permissions that are not explicitly denied"),
    Flag.withDefault(false),
  ),
  yolo: Flag.boolean("yolo").pipe(Flag.withDefault(false), Flag.withHidden),
  dangerouslySkipPermissions: Flag.boolean("dangerously-skip-permissions").pipe(
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}

// What a run that sends one message and prints the answer takes, shared by `orb run` and `orb -p`.
const HeadlessParams = {
  // Puts back the files that the named session's file tools changed since a prompt's work began, then exits. Left out of
  // --help, as the reference leaves its own flag out.
  rewindFiles: Flag.string("rewind-files").pipe(Flag.withHidden, Flag.optional),
  bare: Flag.boolean("bare").pipe(
    Flag.withDescription(
      "Run on a private server without project config or instruction files (AGENTS.md and the like), for reproducible scripts",
    ),
    Flag.withDefault(false),
  ),
  jsonSchema: Flag.string("json-schema").pipe(
    Flag.withDescription(
      "JSON Schema the final answer must follow, as JSON text (when it starts with {) or the path of a file. The model hands the answer in through a tool that checks it, and the result carries it as structured_output; text output prints only that JSON. Set ORBIT_MAX_STRUCTURED_OUTPUT_RETRIES (1 to 20, default 5) to change how many wrong answers are allowed",
    ),
    Flag.optional,
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("File to attach to the message"),
    Flag.atMost(100),
  ),
  inputFormat: Flag.choice("input-format", ["text", "stream-json"]).pipe(
    Flag.withDescription(
      'Input format: "text" (the default) sends the words after the flags and anything piped in as one message; "stream-json" reads one JSON input per line from standard input while the run goes on, and needs --output-format stream-json (--format stream-json for orb run). Inputs: {"type":"user","text":"...","files":["path"],"delivery":"steer"|"queue","id":"msg_..."}, {"type":"interrupt"}, {"type":"permission_reply","requestID":"per_...","decision":"once"|"always"|"reject","message":"..."}, {"type":"form_reply","formID":"frm_...","answer":{...}}, {"type":"form_cancel","formID":"frm_...","message":"..."}, {"type":"set_model","model":"provider/model#variant"} and {"type":"end"}. Asks and questions are written as permission_request and form_request lines for the program to answer; the run ends when standard input closes and every message has a result line. Words after the flags are sent as the first message',
    ),
    Flag.optional,
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Session title"), Flag.optional),
  thinking: Flag.boolean("thinking").pipe(Flag.withDescription("Show thinking blocks"), Flag.withDefault(false)),
  maxSteps: Flag.integer("max-steps").pipe(
    Flag.withAlias("max-turns"),
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    Flag.withDescription("Stop after this many model calls; the result then has subtype error_max_steps"),
    Flag.optional,
  ),
  maxCost: Flag.float("max-cost").pipe(
    Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0))),
    Flag.withDescription("Stop once the run has cost this many US dollars; needs a model with a known price"),
    Flag.optional,
  ),
  maxTokens: Flag.integer("max-tokens").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    Flag.withDescription("Stop once the run has used this many tokens"),
    Flag.optional,
  ),
  fallbackModel: Flag.string("fallback-model").pipe(
    Flag.withDescription(
      "Model to switch to when the main model stays overloaded, in the format provider/model#variant",
    ),
    Flag.optional,
  ),
}

// The flags that only `orb -p` takes, which the root command lists so that --help shows them.
const PrintParams = {
  ...HeadlessParams,
  outputFormat: Flag.choice("output-format", ["text", "json", "stream-json"]).pipe(
    Flag.withDescription(
      'Output format with -p: "text" prints the answer; "json" prints one JSON result object; "stream-json" prints one JSON line per event, starting with an init line {type, protocol: 1, sessionID, cwd, agent, model, version} (a run that fails before its prompt is sent prints only the result line) and ending with the result line. The result object has type "result", sessionID, is_error, subtype, outcome (succeeded, failed or interrupted), reason, result, structured_output, error, steps, duration_ms, cost, tokens and rejected (requests that were rejected because nobody could approve them), and counts the steps of subagents',
    ),
    Flag.optional,
  ),
  includePartialMessages: Flag.boolean("include-partial-messages").pipe(
    Flag.withDescription(
      "With --output-format stream-json: also print text_delta, reasoning_delta (with --thinking) and tool_input_delta lines as the model streams",
    ),
    Flag.withDefault(false),
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription(
      "With the text format: show thinking and tool output, and print one usage line per step on stderr",
    ),
    Flag.withDefault(false),
  ),
}

// A config file for this run only. Every command that starts or reads a server takes it, and starts a private server.
// Up to twenty values are read, like --mcp-config, so that a repeat always reaches the handler and gets its one-line refusal.
const SettingsParams = {
  settings: Flag.string("settings").pipe(
    Flag.withDescription(
      "A config file, or the JSON itself, in the orbit.json shape, for this run only. It ranks above project and local config and below managed settings. A relative file name is taken from the folder you typed the command in. Starts a private server for the run, separate from the background service, which takes a moment to start; cannot be combined with --server",
    ),
    Flag.atMost(20),
  ),
}

// Config for this run only, which the interface takes as well as `orb -p` and `orb run`. They start a private server.
const OverlayParams = {
  ...SettingsParams,
  mcpConfig: Flag.string("mcp-config").pipe(
    Flag.withDescription(
      'MCP servers for this run only: a JSON file, or the JSON itself, shaped {"servers": {"<name>": {"type": "local", "command": ["<program>"]}}}. Repeat the flag to add more. Relative program and cwd paths in a file are taken from that file\'s folder. Runs on a private server and cannot be combined with --server',
    ),
    Flag.atMost(20),
  ),
  agents: Flag.string("agents").pipe(
    Flag.withDescription(
      'Agents for this run only: a JSON file, or the JSON itself, shaped {"<name>": {"system": "...", "description": "..."}}, applied over the config. Runs on a private server and cannot be combined with --server',
    ),
    Flag.optional,
  ),
}

// What the interface takes as well as `orb -p`, so a plain `orb` run does not refuse them.
const ModelParams = {
  model: Flag.string("model").pipe(
    Flag.withAlias("m"),
    Flag.withDescription("Model to use in the format provider/model#variant"),
    Flag.optional,
  ),
  agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
}

/** The flags that only `orb -p` takes, as the camelCase names of the parsed input, which the root command refuses. */
export const PrintParamKeys = Object.keys(PrintParams) as ReadonlyArray<keyof typeof PrintParams>

/** The same flags as they are typed, for the message that refuses them and the tests that pin it. */
export const PrintParamFlags = PrintParamKeys.map(
  (key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
)

// A bare -r or --resume is rewritten to `--resume=` by framework/argv.ts, because the parser has no optional values.
const ResumeParams = {
  resume: Flag.string("resume").pipe(
    Flag.withAlias("r"),
    Flag.withDescription(
      "Resume a session: a session ID, or words to search for (a bare flag opens the session list). The next word is its value, so quote a message or put it after --",
    ),
    Flag.optional,
  ),
}

// Where no session list can open, a bare flag fails, so the help does not offer one.
const HeadlessResumeParams = {
  resume: Flag.string("resume").pipe(
    Flag.withAlias("r"),
    Flag.withDescription(
      "Resume an existing session: a session ID, or words to search for in this folder's sessions. The next word is its value, so quote a message or put it after --",
    ),
    Flag.optional,
  ),
}

const SessionParams = {
  ...ResumeParams,
  fork: Flag.boolean("fork").pipe(Flag.withDescription("Fork the session before continuing"), Flag.withDefault(false)),
  continue: Flag.boolean("continue").pipe(
    Flag.withAlias("c"),
    Flag.withDescription("Continue the last session"),
    Flag.withDefault(false),
  ),
  session: Flag.string("session").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Session ID to continue, or to create if it does not exist"),
    Flag.optional,
  ),
}

const PrintFlag = Flag.boolean("print").pipe(
  Flag.withAlias("p"),
  Flag.withDescription(
    "Send the words after the flags as one message, print the answer and exit. A word right after a flag that takes a value is that flag's value; run orb -p --help to list every flag it accepts",
  ),
  Flag.withDefault(false),
)

const Root = Spec.make(typeof ORBIT_CLI_NAME === "string" ? ORBIT_CLI_NAME : "orb", {
  description: "Orbit command line interface",
  params: {
    ...ServerParams,
    ...PermissionParams,
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Directory to start Orbit in"),
      Argument.optional,
    ),
    print: PrintFlag,
    ...SessionParams,
    ...PrintParams,
    ...ModelParams,
    ...OverlayParams,
    prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
  },
  commands: [
    Spec.make("acp", { description: "Start an Agent Client Protocol server" }),
    Spec.make("api", {
      description: "Make a request to the running server",
      params: {
        ...ServerParams,
        request: Argument.string("operation | method path").pipe(
          Argument.withDescription("OpenAPI operation ID, or an HTTP method followed by a path"),
          Argument.variadic({ min: 1, max: 2 }),
        ),
        data: Flag.string("data").pipe(Flag.withAlias("d"), Flag.withDescription("Request body"), Flag.optional),
        header: Flag.string("header").pipe(
          Flag.withAlias("H"),
          Flag.withDescription("Request header in name:value form"),
          Flag.atMost(100),
        ),
        param: Flag.keyValuePair("param").pipe(Flag.withDescription("OpenAPI path or query parameter"), Flag.optional),
      },
    }),
    Spec.make("debug", {
      description: "Debugging and troubleshooting tools",
      commands: [
        Spec.make("agents", { description: "List all agents" }),
        Spec.make("config", { description: "List configuration sources", params: { ...SettingsParams } }),
        Spec.make("paths", {
          description: "Show global paths (data, config, cache, state)",
          params: {
            name: Argument.choice("name", [
              "db",
              "home",
              "data",
              "config",
              "cache",
              "state",
              "tmp",
              "bin",
              "log",
              "repos",
              "managed",
            ]).pipe(
              Argument.withDescription(
                "Print only one path: db, home, data, config, cache, state, tmp, bin, log, repos, managed",
              ),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("auth", {
      description: "manage integrations and credentials",
      commands: [
        Spec.make("list", {
          description: "list integrations and credentials",
          params: {
            ...ServerParams,
            format: Flag.choice("format", ["default", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("default"),
            ),
          },
        }),
        Spec.make("login", {
          description: "connect an integration",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID, name, or well-known provider URL"),
              Argument.optional,
            ),
            method: Flag.string("method").pipe(Flag.withDescription("Authentication method ID"), Flag.optional),
            answer: Flag.string("answer").pipe(
              Flag.withDescription("Provider form answer (key=value; repeat for multiple fields)"),
              Flag.atMost(100),
            ),
          },
        }),
        Spec.make("logout", {
          description: "log out of a saved account",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.string("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("export", {
          description: "print stored credentials, including secrets, as JSON",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name (exports every integration when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("import", {
          description: "import credentials exported by auth export",
          params: {
            ...ServerParams,
            file: Argument.string("file").pipe(
              Argument.withDescription("JSON file to import (reads stdin when omitted)"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("switch", {
          description: "switch the active account for an integration",
          params: {
            ...ServerParams,
            target: Argument.string("target").pipe(
              Argument.withDescription("Integration ID or name"),
              Argument.optional,
            ),
            credential: Argument.string("credential").pipe(
              Argument.withDescription("Credential ID or label (opens an account picker when omitted)"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("mcp", {
      description: "Manage MCP (Model Context Protocol) servers",
      commands: [
        Spec.make("list", { description: "List configured MCP servers and their status" }),
        Spec.make("add", {
          description: "Add an MCP server to your configuration",
          params: {
            name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")),
            command: Argument.string("command").pipe(
              Argument.withDescription("Command and arguments for a local server, passed after --"),
              Argument.variadic({ min: 0 }),
            ),
            url: Flag.string("url").pipe(Flag.withDescription("URL for a remote MCP server"), Flag.optional),
            header: Flag.keyValuePair("header").pipe(
              Flag.withDescription("HTTP header for a remote server, as name=value"),
              Flag.optional,
            ),
            env: Flag.keyValuePair("env").pipe(
              Flag.withDescription("Environment variable for a local server, as name=value"),
              Flag.optional,
            ),
            global: Flag.boolean("global").pipe(
              Flag.withDescription("Write to the global config instead of the project config"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("auth", {
          description: "Authenticate with an OAuth-capable remote MCP server",
          params: {
            name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server"), Argument.optional),
          },
        }),
        Spec.make("logout", {
          description: "Remove stored OAuth credentials for an MCP server",
          params: { name: Argument.string("name").pipe(Argument.withDescription("Name of the MCP server")) },
        }),
      ],
    }),
    Spec.make("plugin", {
      description: "Manage plugins",
      commands: [
        Spec.make("list", {
          description: "List plugins",
          params: {
            builtin: Flag.boolean("builtin").pipe(
              Flag.withDescription("Include built-in server plugins"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("add", {
          description: "Install a plugin and add it to the global configuration",
          params: {
            package: Argument.string("package").pipe(Argument.withDescription("npm registry or Git package specifier")),
          },
        }),
        Spec.make("check", {
          description: "Check package plugins for updates",
          params: {
            target: Argument.string("target").pipe(
              Argument.withDescription("Configured package target"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("update", {
          description: "Update package plugins",
          params: {
            target: Argument.string("target").pipe(
              Argument.withDescription("Configured package target; omit to update all outdated plugins"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("remove", {
          description: "Remove a plugin from global configuration",
          params: {
            package: Argument.string("package").pipe(Argument.withDescription("configured package specifier")),
          },
        }),
      ],
    }),
    Spec.make("models", {
      description: "List all available models",
      params: ServerParams,
    }),
    Spec.make("doctor", {
      description: "Check network, TLS, provider settings and, with --probe, reachability of each provider",
      params: {
        ...ServerParams,
        ...TrustParams,
        probe: Flag.boolean("probe").pipe(
          Flag.withDescription("Send one short request to one model per available provider"),
          Flag.withDefault(false),
        ),
        model: Flag.string("model").pipe(
          Flag.withDescription("Probe only this model (provider/model); implies --probe"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("flow", {
      description: "Run multi-agent workflows with recorded, resumable runs",
      commands: [
        Spec.make("run", {
          description: "Run a workflow file",
          params: {
            ...ServerParams,
            ...TrustParams,
            file: Argument.string("file").pipe(Argument.withDescription("Workflow file (.ts, .js, .yaml or .yml)")),
            input: Flag.string("input").pipe(
              Flag.withDescription("Workflow input as key=value (repeat for multiple), or a JSON object"),
              Flag.atLeast(0),
            ),
            auto: Flag.boolean("auto").pipe(
              Flag.withDescription("Approve actions that need permission instead of rejecting them"),
              Flag.withDefault(false),
            ),
            model: Flag.string("model").pipe(
              Flag.withDescription("Model (provider/model) for agents that do not set one"),
              Flag.optional,
            ),
            maxCost: Flag.float("max-cost").pipe(
              Flag.withDescription("Pause at a budget gate once the run has cost this many US dollars"),
              Flag.optional,
            ),
            maxTokens: Flag.integer("max-tokens").pipe(
              Flag.withDescription("Pause at a budget gate once the run has used this many tokens"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("resume", {
          description: "Resume a run, reusing nodes that already succeeded",
          params: {
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(Argument.withDescription("Run ID")),
            auto: Flag.boolean("auto").pipe(
              Flag.withDescription("Approve actions that need permission instead of rejecting them"),
              Flag.withDefault(false),
            ),
            model: Flag.string("model").pipe(
              Flag.withDescription("Model (provider/model) for agents that do not set one"),
              Flag.optional,
            ),
            maxCost: Flag.float("max-cost").pipe(
              Flag.withDescription("Pause at a budget gate once the run has cost this many US dollars"),
              Flag.optional,
            ),
            maxTokens: Flag.integer("max-tokens").pipe(
              Flag.withDescription("Pause at a budget gate once the run has used this many tokens"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("approve", {
          description: "Decide a gate a run is waiting on; then resume the run",
          params: {
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(Argument.withDescription("Run ID")),
            gate: Argument.string("gate").pipe(Argument.withDescription("Gate ID")),
            reject: Flag.boolean("reject").pipe(
              Flag.withDescription("Reject instead of approving"),
              Flag.withDefault(false),
            ),
            note: Flag.string("note").pipe(Flag.withDescription("A note the workflow receives"), Flag.optional),
          },
        }),
        Spec.make("cost", {
          description: "Show tokens and cost of a run by node and model",
          params: {
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(Argument.withDescription("Run ID")),
            format: Flag.choice("format", ["table", "json"]).pipe(Flag.withDefault("table")),
          },
        }),
        Spec.make("replay", {
          description: "Re-run a run from its recorded results, without models, to check the workflow's logic",
          params: {
            // A server is used only to ask whether the folder is trusted, before a workflow module is loaded.
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(Argument.withDescription("Run ID to replay")),
            file: Flag.string("file").pipe(
              Flag.withDescription(
                "Replay with this workflow file instead of the recorded one, such as an edited copy",
              ),
              Flag.optional,
            ),
          },
        }),
        Spec.make("watch", {
          description: "Show a run's nodes live until it stops",
          params: {
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(
              Argument.withDescription("Run ID; the newest run when omitted"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("trace", {
          description: "Show a run's timeline, or export it as OpenTelemetry traces",
          params: {
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(Argument.withDescription("Run ID")),
            format: Flag.choice("format", ["timeline", "otlp"]).pipe(
              Flag.withDescription("timeline (default) or OTLP JSON on stdout"),
              Flag.withDefault("timeline"),
            ),
            otlp: Flag.string("otlp").pipe(
              Flag.withDescription("Send the trace to this OTLP/HTTP collector, for example http://localhost:4318"),
              Flag.optional,
            ),
          },
        }),
        Spec.make("clean", {
          description: "Remove the worktrees and branches of finished runs",
          params: {
            // A server is used only to ask whether the folder is trusted: removing a worktree runs the folder's VCS.
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(
              Argument.withDescription("Run ID; every run that is not running or waiting when omitted"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("ls", {
          description: "List recent runs in this repository",
          params: {
            ...ServerParams,
            ...TrustParams,
            format: Flag.choice("format", ["table", "json"]).pipe(Flag.withDefault("table")),
          },
        }),
        Spec.make("show", {
          description: "Show the nodes and events of a run",
          params: {
            ...ServerParams,
            ...TrustParams,
            run: Argument.string("run").pipe(Argument.withDescription("Run ID")),
            format: Flag.choice("format", ["table", "json"]).pipe(Flag.withDefault("table")),
          },
        }),
      ],
    }),
    Spec.make("eval", {
      description: "Run an eval suite on one or more models and compare pass rate, tokens, cost and time",
      params: {
        ...ServerParams,
        ...TrustParams,
        suite: Argument.string("suite").pipe(
          Argument.withDescription("Eval suite file (.ts, .js, .json, .yaml or .yml)"),
        ),
        models: Flag.string("models").pipe(
          Flag.withDescription("Comma-separated provider/model list; the suite's models by default"),
          Flag.optional,
        ),
        concurrency: Flag.integer("concurrency").pipe(
          Flag.withDescription("Tasks running at once (default 1)"),
          Flag.optional,
        ),
        resume: Flag.string("resume").pipe(
          Flag.withDescription("Resume an eval run, reusing tasks that already finished"),
          Flag.optional,
        ),
        auto: Flag.boolean("auto").pipe(
          Flag.withDescription("Approve actions that need permission instead of rejecting them"),
          Flag.withDefault(false),
        ),
        format: Flag.choice("format", ["table", "json"]).pipe(Flag.withDefault("table")),
      },
    }),
    Spec.make("stats", {
      description: "Show shareable usage statistics",
      params: {
        ...ServerParams,
        days: Flag.integer("days").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          Flag.withDescription("Show the last N days; 0 means today"),
          Flag.optional,
        ),
        year: Flag.integer("year").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1970, maximum: 9_999 }))),
          Flag.withDescription("Show a calendar year"),
          Flag.optional,
        ),
        all: Flag.boolean("all").pipe(Flag.withDescription("Show lifetime statistics"), Flag.withDefault(false)),
        project: Flag.string("project").pipe(
          Flag.withDescription('Filter by project ID, or use "." for the current project'),
          Flag.optional,
        ),
        models: Flag.boolean("models").pipe(Flag.withDescription("Show model usage"), Flag.withDefault(false)),
        tools: Flag.boolean("tools").pipe(Flag.withDescription("Show tool reliability"), Flag.withDefault(false)),
        cost: Flag.boolean("cost").pipe(Flag.withDescription("Show cost and token details"), Flag.withDefault(false)),
        full: Flag.boolean("full").pipe(Flag.withDescription("Show every detailed section"), Flag.withDefault(false)),
        limit: Flag.integer("limit").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          Flag.withDescription("Number of rows in detailed sections"),
          Flag.withDefault(5),
        ),
        json: Flag.boolean("json").pipe(Flag.withDescription("Output statistics as JSON"), Flag.withDefault(false)),
      },
    }),
    Spec.make("mini", {
      description: "Start the minimal interactive interface",
      params: {
        ...ServerParams,
        ...SettingsParams,
        continue: Flag.boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue, or to create if it does not exist"),
          Flag.optional,
        ),
        fork: Flag.boolean("fork").pipe(
          Flag.withDescription("Fork the session when continuing"),
          Flag.withDefault(false),
        ),
        replay: Flag.boolean("replay").pipe(
          Flag.withDescription("Restore session history on resume and resize (disable with --no-replay)"),
          Flag.optional,
        ),
        replayLimit: Flag.integer("replay-limit").pipe(
          Flag.withDescription("Limit replay to the newest N messages (default: 200)"),
          Flag.optional,
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        prompt: Flag.string("prompt").pipe(Flag.withDescription("Prompt to use"), Flag.optional),
        demo: Flag.boolean("demo").pipe(Flag.withDefault(false), Flag.withHidden),
      },
    }),
    Spec.make("loop", {
      description: "Send the same message to one session on a schedule, such as checking a build every 10 minutes",
      params: {
        ...ServerParams,
        ...TrustParams,
        ...SettingsParams,
        interval: Argument.string("interval").pipe(
          Argument.withDescription('Time between runs, such as "30s", "10m" or "1h" (at least 10s)'),
        ),
        message: Argument.string("message").pipe(
          Argument.withDescription("Message to send each time"),
          Argument.variadic({ min: 1 }),
        ),
        times: Flag.integer("times").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          Flag.withDescription("Stop after this many runs (default: until interrupted)"),
          Flag.optional,
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session to run in (default: a new session for this loop)"),
          Flag.optional,
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model#variant"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        ...PermissionParams,
      },
    }),
    Spec.make("run", {
      description: "Run Orbit with a message",
      params: {
        ...ServerParams,
        ...TrustParams,
        message: Argument.string("message").pipe(
          Argument.withDescription("Message to send"),
          Argument.variadic({ min: 0 }),
        ),
        continue: Flag.boolean("continue").pipe(
          Flag.withAlias("c"),
          Flag.withDescription("Continue the last session"),
          Flag.withDefault(false),
        ),
        session: Flag.string("session").pipe(
          Flag.withAlias("s"),
          Flag.withDescription("Session ID to continue, or to create if it does not exist"),
          Flag.optional,
        ),
        ...HeadlessResumeParams,
        fork: Flag.boolean("fork").pipe(
          Flag.withDescription("Fork the session before continuing"),
          Flag.withDefault(false),
        ),
        model: Flag.string("model").pipe(
          Flag.withAlias("m"),
          Flag.withDescription("Model to use in the format provider/model#variant"),
          Flag.optional,
        ),
        agent: Flag.string("agent").pipe(Flag.withDescription("Agent to use"), Flag.optional),
        format: Flag.choice("format", ["default", "json", "stream-json", "result"]).pipe(
          Flag.withHidden,
          Flag.withDescription(
            'Output format: "json" or "stream-json" print one JSON event per line, "result" prints one JSON object at the end',
          ),
          Flag.withDefault("default"),
        ),
        ...HeadlessParams,
        ...OverlayParams,
        ...PermissionParams,
      },
    }),
    Spec.make("session", {
      description: "Manage sessions",
      commands: [
        Spec.make("list", {
          description: "List top-level sessions in the current project, newest first",
          params: {
            ...ServerParams,
            maxCount: Flag.integer("max-count").pipe(
              Flag.withAlias("n"),
              Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
              Flag.withDescription("Limit to N most recent sessions (default: 100)"),
              Flag.optional,
            ),
            format: Flag.choice("format", ["table", "json"]).pipe(
              Flag.withDescription("Output format"),
              Flag.withDefault("table"),
            ),
          },
        }),
        Spec.make("delete", {
          description: "Delete a session and its child sessions",
          params: {
            ...ServerParams,
            sessionID: Argument.string("sessionID").pipe(Argument.withDescription("Session ID to delete")),
          },
        }),
        Spec.make("export", {
          description: "Export session data as JSON",
          params: {
            ...ServerParams,
            session: Argument.string("session").pipe(
              Argument.withDescription("Session ID to export"),
              Argument.optional,
            ),
            sanitize: Flag.boolean("sanitize").pipe(
              Flag.withDescription("Redact sensitive transcript and file data"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("import", {
          description: "Import session data from a JSON file or URL",
          params: {
            ...ServerParams,
            ...TrustParams,
            file: Argument.string("file").pipe(Argument.withDescription("JSON file or URL to import")),
            directory: Flag.string("directory").pipe(
              Flag.withDescription("Directory in which to import the session"),
              Flag.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("service", {
      description: "Manage the background server",
      commands: [
        Spec.make("start", {
          description: "Start the background server",
          params: {
            json: Flag.boolean("json").pipe(
              Flag.withDescription("Print the endpoint and its credentials as JSON, for editor integrations"),
              Flag.withDefault(false),
            ),
          },
        }),
        Spec.make("restart", { description: "Restart the background server" }),
        Spec.make("status", { description: "Show background server status" }),
        Spec.make("stop", { description: "Stop the background server" }),
        Spec.make("get", {
          description: "Get service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env"), Argument.optional),
            name: Argument.string("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("set", {
          description: "Set service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env")),
            value: Argument.string("value").pipe(
              Argument.withDescription("Setting value or environment variable name"),
            ),
            nestedValue: Argument.string("env-value").pipe(
              Argument.withDescription("Environment variable value"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("unset", {
          description: "Unset service configuration",
          params: {
            key: Argument.string("key").pipe(Argument.withDescription("Service setting or env")),
            name: Argument.string("name").pipe(
              Argument.withDescription("Environment variable name"),
              Argument.optional,
            ),
          },
        }),
      ],
    }),
    Spec.make("reload", {
      description: "Reload configuration",
      params: {
        ...ServerParams,
      },
    }),
    Spec.make("trust", {
      description: "Trust a folder, so that what it holds loads and work can start there",
      params: {
        ...ServerParams,
        directory: Argument.string("directory").pipe(
          Argument.withDescription("Folder to trust; the current folder when omitted"),
          Argument.optional,
        ),
        revoke: Flag.boolean("revoke").pipe(
          Flag.withDescription("Stop trusting the folder instead of trusting it"),
          Flag.withDefault(false),
        ),
        list: Flag.boolean("list").pipe(
          Flag.withDescription("List the folders that are trusted for good"),
          Flag.withDefault(false),
        ),
      },
    }),
    Spec.make("pair", {
      description: "Print one-time links to connect a browser or app",
      params: {
        url: Flag.string("url").pipe(
          Flag.withDescription("Use an external HTTP(S) server URL in pairing links"),
          Flag.mapTryCatch(
            (value) => {
              const url = new URL(value)
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                throw new Error("Invalid pairing URL")
              return url.href.replace(/\/+$/, "")
            },
            () => "Expected an HTTP(S) server URL without credentials, query parameters, or a fragment",
          ),
          Flag.optional,
        ),
      },
    }),
    Spec.make("serve", {
      description: "Start the v2 API and web server",
      params: {
        hostname: Flag.string("hostname").pipe(Flag.optional),
        port: Flag.integer("port").pipe(Flag.optional),
        cors: Flag.string("cors").pipe(
          Flag.withSchema(Schema.NonEmptyString),
          Flag.withDescription("Additional allowed CORS origin (repeat for multiple origins)"),
          Flag.atLeast(0),
        ),
        service: Flag.boolean("service").pipe(Flag.withDefault(false)),
        stdio: Flag.boolean("stdio").pipe(Flag.withDefault(false)),
      },
    }),
  ],
})

export const Commands = Root

/** `orb -p`: the words after the flags are the message, so no word of it is a subcommand. */
export const Print = Spec.make(typeof ORBIT_CLI_NAME === "string" ? ORBIT_CLI_NAME : "orb", {
  description: "Orbit command line interface: send a message, print the answer and exit",
  params: {
    ...ServerParams,
    ...TrustParams,
    ...PermissionParams,
    ...SessionParams,
    ...HeadlessResumeParams,
    ...PrintParams,
    ...ModelParams,
    ...OverlayParams,
    print: PrintFlag,
    message: Argument.string("message").pipe(
      Argument.withDescription("Message to send"),
      Argument.variadic({ min: 0 }),
    ),
  },
})

/** The flags of the root command that take a value, so a word after one is that value and not a message word. */
export const RootValueFlags = {
  long: [
    "server",
    "session",
    "resume",
    "prompt",
    "model",
    "agent",
    "settings",
    "mcp-config",
    "agents",
    "output-format",
    "input-format",
    "json-schema",
    "max-steps",
    "max-turns",
    "max-cost",
    "max-tokens",
    "fallback-model",
    "rewind-files",
    "file",
    "title",
    "completions",
    "log-level",
  ],
  short: ["s", "m", "f", "r"],
} as const

/** The boolean flags of `orb -p` that grant trust or approve every ask when they are on. */
export const WideningFlags: ReadonlyArray<string> = ["trust", "auto", "yolo", "dangerously-skip-permissions"]

/** The boolean flags of `orb -p`, each with the short letter it is also written with, if it has one. */
export const PrintBooleanFlags: Readonly<Record<string, string | undefined>> = {
  print: "p",
  standalone: undefined,
  trust: undefined,
  auto: undefined,
  yolo: undefined,
  "dangerously-skip-permissions": undefined,
  continue: "c",
  fork: undefined,
  bare: undefined,
  thinking: undefined,
  "include-partial-messages": undefined,
  verbose: undefined,
  "print-logs": undefined,
}

/** The words `orb` dispatches on, which a message word of `orb -p` is not. */
export const Subcommands = Object.values(Root.commands).flatMap((command) => [
  command.name,
  ...command.aliases.map((alias) => alias.name),
])
