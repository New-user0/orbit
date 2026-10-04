# Tachyon probe

This script records how `tachyon_sdk` talks to the Tachyon gateway. Orbit's native TypeScript provider will be built from those facts, so nothing about Tachyon has to be guessed. See `docs/DESIGN.md` → Phase 0.

## What it records

| Section | Contents |
|---|---|
| `env` | Which `TACHYON_*` settings are set, by name only, plus the CA and trust-store setup. |
| `sdk` | SDK and dependency versions, its module list, and the SDK **source lines** that build headers, tokens and URLs. `langchain_client/` and `common/` are scanned in full first. `a2a/`, `mcp_core/` and `adk*` are skipped unless `--scan-all` is given. Files named with `--dump-file` are included whole. |
| `wire` | Every HTTP call the SDK makes: method, path, header **names** with a value **fingerprint**, and request/response body **shape**. |
| `models` | Per model: **which output-ceiling parameter it reads**, and whether sending both names is safe. Then plain call, streaming, tool calling, and whether `seed` is sent and honoured. |
| `native_check` | With `--native-check`: the **header recipe** (one rule per header), then a plain and a streaming call made **without the SDK** using only that recipe, then one call per header with that header left out, which shows which headers are **required**. |

## Header fingerprints

A header value is never written to the report. A fingerprint says where the value comes from:

| Fingerprint | Meaning |
|---|---|
| `= $TACHYON_API_KEY` | exactly the value of that variable |
| `Basic base64($TACHYON_CONSUMER_KEY:$TACHYON_CONSUMER_SECRET)` | Basic auth built from those two variables |
| `Bearer <access_token from the token response>` | the Apigee token |
| `= header x-wf-client-id` | a copy of another header |
| `uuid (version 4)` | a fresh UUID |
| `date/number template 9999-99-99T99:99:99.999999` | a timestamp, with every digit replaced by 9 |
| `= installed tachyon-sdk version` | the SDK version string |
| `'…' (verbatim: SDK constant)` | `x-wf-client-type` and `x-wf-client-version` only. Shown in full because they are constants, but still blocked if they contain a secret. |
| `<unknown:len=N>` | not derivable. The native check marks it `copied`, meaning that part of the recipe is still unknown. |

## The `max_tokens` / `max_completion_tokens` split

On Tachyon the two names are **not interchangeable**. Your excel `config/model-capabilities.json` records:

| Reads | Models |
|---|---|
| `max_completion_tokens`, and **rejects** raw `max_tokens` with a 400 | the gpt-5.x family (`gpt-5.4`, `gpt-5.5`, `gpt5.1`, …) |
| raw `max_tokens`, and **ignores** `max_completion_tokens` | Claude, Gemini, Gemma, Llama, Grok, **and** `gpt4.1`, `gpt4o`, `gpt4o-mini`, `gpt-oss-20b` |

So "GPT" is not the rule. When a model is sent the name it ignores, nothing errors: the reply is cut at the platform default of 1024 tokens and still looks normal.

The probe therefore **measures** the parameter, using the same method as excel's `scripts/probe_max_tokens_param.py`:
1. It asks for 400 numbers under a 24-token ceiling, once with each name.
2. It judges each reply by `output_tokens`, not `finish_reason`. A cut at the platform's 1024 also reports `length`.
3. It decides the outcome for each name:
   - **honoured**: the reply stopped at about 24 tokens.
   - **ignored**: the reply ran long.
   - **rejected**: the gateway returned an error.

The measured verdict is used for every other test. Pass `--capabilities <excel>/config/model-capabilities.json` to compare it with the recorded value. A disagreement is flagged in both the console and the report.

## How secrets are kept out of the report

- Header values are always replaced with `<redacted:len=N>`. The exceptions are `content-type`, `accept`, `user-agent` and encoding headers. For `Authorization`, only the scheme (e.g. `Bearer`) is kept.
- String values in request and response bodies are replaced with `<str:len=N>`. Only protocol fields are kept, such as `model`, `stream`, `grant_type`, `token_type`, `expires_in` and `finish_reason`.
- Hostnames become `<host>` unless you pass `--keep-hosts`.
- Local paths (your home folder, `site-packages`, the Python prefix) become `<local-path>` or `<home>`. This includes tracebacks, which probe v2 did not redact.
- Access tokens returned by the gateway are added to the secret list as soon as they are seen.
- Before writing, the report is searched for every `TACHYON_*` and `DDA_TACHYON__*` value in your environment, every access token, and your home folder path. If any of them is found, **no file is written**.

## Run it (Windows)

Requirements: Python ≥ 3.12, `tachyon-sdk` with its `langchain-client` extra, and `truststore` (optional).

```powershell
# Same settings as the excel project. Either the DDA_TACHYON__* or the TACHYON_* names work.
$env:TACHYON_API_KEY = "..."; $env:TACHYON_CHAT_COMPLETION_BASE_URL = "..."
$env:TACHYON_USECASE_ID = "..."; $env:TACHYON_APIGEE_URL = "..."
$env:TACHYON_CONSUMER_KEY = "..."; $env:TACHYON_CONSUMER_SECRET = "..."
$env:TACHYON_CERT_PATH = "C:\path\to\ca-bundle.pem"

py tools\tachyon-probe\probe.py `
  --model claude-opus-4-5@20251101 `
  --model gpt-5.4 `
  --model gpt4o `
  --native-check `
  --capabilities ..\excel\config\model-capabilities.json `
  --dump-file common/http_interceptor.py `
  --dump-file common/apigee.py `
  --dump-file common/sdk_metadata.py `
  --dump-file langchain_client/langchain_client.py
```

- Run it from a folder **without** an unrelated `.env` file. The SDK calls `load_dotenv(override=True)` on the current directory.
- Each model costs about 8 small calls: 3 measurement calls (one may run to about 1024 tokens when that name is ignored) and 5 calls of at most 64 tokens. `--native-check` adds 1 token call, 2 chat calls, and 1 call per header (about 12 calls of 16 tokens each). `--no-header-ablation` skips the per-header calls.
- `--dump-file` puts whole SDK source files into the report, with secrets, hosts and local paths redacted. Leave it out if internal SDK code must not leave your machine. The priority source scan usually shows enough on its own. Leave out tests with `--skip seed`, `--skip tools` and so on.

## Share the result

1. Open `probe-report.json` and read it.
2. Paste it into the chat. Don't commit it: the file is git-ignored on purpose.
