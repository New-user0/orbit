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
// when they are about to load code from it, run the shell commands that a file in it defines, or approve what its
// agents ask permission for because a workflow file says so.
const TrustParams = {
  trust: Flag.boolean("trust").pipe(
    Flag.withDescription(
      "Trust this folder for this run only, so its project config applies, the code and commands it holds may run, and a workflow in it may approve what its agents ask permission for; runs on a private server and cannot be combined with --server",
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

const Root = Spec.make(typeof ORBIT_CLI_NAME === "string" ? ORBIT_CLI_NAME : "orb", {
  description: "Orbit command line interface",
  params: {
    ...ServerParams,
    ...PermissionParams,
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Directory to start Orbit in"),
      Argument.optional,
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
        Spec.make("config", { description: "List configuration sources" }),
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
            ]).pipe(
              Argument.withDescription(
                "Print only one path: db, home, data, config, cache, state, tmp, bin, log, repos",
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
            run: Argument.string("run").pipe(
              Argument.withDescription("Run ID; the newest run when omitted"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("trace", {
          description: "Show a run's timeline, or export it as OpenTelemetry traces",
          params: {
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
            run: Argument.string("run").pipe(
              Argument.withDescription("Run ID; every run that is not running or waiting when omitted"),
              Argument.optional,
            ),
          },
        }),
        Spec.make("ls", {
          description: "List recent runs in this repository",
          params: {
            format: Flag.choice("format", ["table", "json"]).pipe(Flag.withDefault("table")),
          },
        }),
        Spec.make("show", {
          description: "Show the nodes and events of a run",
          params: {
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
          Flag.withDescription(
            'Output format: "json" or "stream-json" print one JSON event per line, "result" prints one JSON object at the end',
          ),
          Flag.withDefault("default"),
        ),
        bare: Flag.boolean("bare").pipe(
          Flag.withDescription(
            "Run on a private server without project config or instruction files (AGENTS.md and the like), for reproducible scripts",
          ),
          Flag.withDefault(false),
        ),
        jsonSchema: Flag.string("json-schema").pipe(
          Flag.withDescription("JSON Schema file the final answer must follow; implies --format result"),
          Flag.optional,
        ),
        file: Flag.string("file").pipe(
          Flag.withAlias("f"),
          Flag.withDescription("File to attach to the message"),
          Flag.atMost(100),
        ),
        title: Flag.string("title").pipe(Flag.withDescription("Session title"), Flag.optional),
        thinking: Flag.boolean("thinking").pipe(Flag.withDescription("Show thinking blocks"), Flag.withDefault(false)),
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
      description: "Trust a folder, so that the project config it holds back can run",
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
