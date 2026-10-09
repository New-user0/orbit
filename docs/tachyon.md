# Tachyon wire protocol (Orbit provider spec)

This is what Orbit's native TypeScript provider implements to call Tachyon **without** `tachyon_sdk`.

It was established on 2026-10-02 from two sources:
- **Probe runs** of a one-time discovery script (`tools/tachyon-probe/probe.py` v2 and v3, removed once this spec was written; it is in the git history at 7845c97) against the live gateway, using tachyon-sdk 2.1.201 on Windows 11 with three models: `claude-opus-4-5@20251101`, `gpt-5.4` and `gpt4o`.
- **The SDK's own source:** `common/apigee.py`, `langchain_client/langchain_client.py` and `common/sdk_metadata.py`.

The probe's `--native-check` replayed this recipe with plain `httpx` and no SDK. Both the plain and the streaming call returned 200.

## Configuration

These are the same variables the SDK and the excel project use. When `TACHYON_CHAT_COMPLETION_BASE_URL` is set, Orbit defines a provider named `tachyon` from them; `orbit.json` lists its models and can override any setting under `providers.tachyon.settings` (`baseURL`, `apigeeURL`, `consumerKey`, `consumerSecret`, `apiKey`, `usecaseId`, `useApiGateway`, each accepting `{env:VAR}`).

```jsonc
// ~/.config/orbit/orbit.json (Windows: %USERPROFILE%\.config\orbit\orbit.json)
{
  "model": "tachyon/claude-opus-4-5@20251101",
  "providers": {
    "tachyon": {
      "package": "@orbit/ai/providers/tachyon",
      "models": {
        "claude-opus-4-5@20251101": { "name": "Claude Opus 4.5", "limit": { "context": 200000, "output": 32000 } },
        "gpt-5.4": { "name": "GPT-5.4", "limit": { "context": 400000, "output": 128000 } },
        // Override the output-ceiling field when a model reads the other one:
        "gpt4o": { "name": "GPT-4o", "compatibility": { "maxTokensField": "max_tokens" } }
      }
    }
  }
}
```

**Fallback models.** `providers.tachyon.settings.fallbackModels` (a list, or a comma-separated string) names gateway models to try, in order, when a model fails on the gateway side: TAC006, HTTP 429 or 5xx. The request is resent with the next model and that model's default output-ceiling field. Content blocks (TAC010-012), auth errors and Apigee's missing-header 500 never fall back. A model that fails 3 times in a row is skipped for 60 seconds.

```jsonc
"tachyon": { "settings": { "fallbackModels": ["gpt-5.4", "claude-sonnet-4-5@20250929"] }, "models": { ... } }
```

Run `orb doctor` to see which variables are set (names only) and `orb doctor --model tachyon/<model>` to send one short request.

| Variable | Use |
|---|---|
| `TACHYON_APIGEE_URL` | The token endpoint, used **as is** with no path appended. On your deployment it ends in `/oauth/token`. |
| `TACHYON_CONSUMER_KEY`, `TACHYON_CONSUMER_SECRET` | Apigee client credentials |
| `TACHYON_CHAT_COMPLETION_BASE_URL` | Chat base URL; Orbit appends `/chat/completions` |
| `TACHYON_API_KEY` | Sent as the `x-wf-api-key` header |
| `TACHYON_USECASE_ID` | Sent as the `x-wf-usecase-id` header |
| `TACHYON_CERT_PATH` / `TACHYON_CERT_B64` | The CA bundle as a file, or as base64 / raw PEM. Orbit adds it to the trust store for every request, like `ORBIT_CA_CERTS`. |
| `TACHYON_USE_API_GATEWAY` | `false` skips the token call and sends `Bearer dummy` (SDK behaviour) |

## 1. Token

```
POST $TACHYON_APIGEE_URL
Authorization: Basic base64("$TACHYON_CONSUMER_KEY:$TACHYON_CONSUMER_SECRET")
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

The response is `{"token_type":"Bearer","access_token":"…","issued_at":<epoch ms>,"expires_in":86399,"scope":""}`.

- If the response has no `access_token`, treat it as an **auth error**. Report the error without the response body, which may echo credentials.
- **Cache** the token in memory. One token covered all 21 calls of a probe run.
- **Refresh ahead** of expiry; Orbit's default margin is 5 minutes. If the margin is at least the token's lifetime, refresh at 10% of the lifetime instead (the SDK's rule). Only one refresh may be in flight at a time.
- If `expires_in` is missing or not positive, use a short fallback lifetime.
- On a **401** from the chat endpoint, refresh the token **once** and resend.

## 2. Chat request

```
POST $TACHYON_CHAT_COMPLETION_BASE_URL/chat/completions
Content-Type: application/json
```

### Headers

All header values are generated fresh for each request.

| Header | Required? | Value |
|---|---|---|
| `Authorization` | **yes** (401 `F-EAPIM-IGTWY-E40100` without it) | `Bearer <access_token>` |
| `x-request-id` | **yes** (400 `TAC002` without it) | new UUIDv4 |
| `x-wf-request-date` | **yes** (400 `TAC002` without it) | **local** time, no zone, microseconds: `YYYY-MM-DDTHH:MM:SS.ffffff`. This is Python's `datetime.now().isoformat()`. JavaScript has milliseconds only, so pad with `000`. |
| `x-wf-api-key` | **yes** (500 `W-EAPIM-IGTWY-E50043` "Missing Header" without it) | `$TACHYON_API_KEY` |
| `x-wf-usecase-id` | **yes** (403 `F-EAPIM-IGTWY-E40300` without it) | `$TACHYON_USECASE_ID` |
| `x-correlation-id` | no | UUIDv4. Orbit reuses one per agent turn so a turn's calls can be traced together. |

**Not sent, by decision.** These are the SDK's adoption-tracking headers:
- `x-wf-client-id` and `From`: `<usecase>_langchain`
- `x-wf-client-type`: `TachyonLangchainClient`
- `x-wf-client-version`: the SDK version

The probe showed every one of them is optional.

### Body

Standard OpenAI chat-completions: `model`, `messages`, `temperature`, `tools` and `tool_choice`, plus exactly **one** output-ceiling parameter (section 4).

- **`model`:** use the configured id, e.g. `claude-opus-4-5@20251101`. Responses report a different id (`claude-opus-4-5-20251101`, `gpt-5.4-2026-03-05`). Log it, but never use it for lookups.
- **`temperature`:** always send it. The SDK forces 0 when it is absent.
- **`seed`:** accepted but **not honoured**, so don't rely on it.

### Streaming

Request `"stream": true, "stream_options": {"include_usage": true}`.

The response is `text/event-stream; charset=utf-8`:
- The first chunk is `delta.role`.
- Content arrives in `delta.content` chunks.
- The last JSON chunk carries `finish_reason` and `usage`.
- The stream ends with `data: [DONE]`.

### Tool calling

Native OpenAI tools work. Claude and gpt-5.4 both returned `tool_calls` with `finish_reason: "tool_calls"`.

## 3. TLS

- The SDK trusts **only** the CA bundle: `ssl.create_default_context(cafile=TACHYON_CERT_PATH)`.
- Orbit trusts the bundle **plus** the OS store, because corporate proxies are often in the OS store.
- No client certificate (mTLS) is involved.

## 4. Output ceiling: send exactly one parameter

Measured per model with a 24-token ceiling and a 400-number prompt:

| Model | `max_tokens` only | `max_completion_tokens` only | both |
|---|---|---|---|
| claude-opus-4-5@20251101 | **honoured** | ignored (ran to 803 tokens) | honoured |
| gpt-5.4 | **400 TAC006** | **honoured** | **400 TAC006** |
| gpt4o | honoured | honoured | **400 TAC006** |

Rules:
- Take the parameter from the model capabilities registry (`maxTokensParam`), never from the model name. gpt4o and gpt-4.1 read `max_tokens`; only gpt-5.x needs `max_completion_tokens`.
- **Never send both.**
- Unknown model: send `max_tokens` and warn once. Use `orb doctor --probe-params <model>` to measure and record it.
- For an unmeasured model, a 400 with TAC006 or `unsupported_parameter` is retried **once** with the other parameter. Nothing was generated, so nothing is billed twice.

## 5. Errors

There are two body formats.

Tachyon:
```json
{"errors":[{"code":"TAC006","title":"Model Execution Exception","detail":"Error while invoking …"}]}
```

Apigee gateway:
```json
{"errors":[{"id":"…","status":"401","code":"F-EAPIM-IGTWY-E40100","title":"Unauthorized","source":{…},"meta":{…}}]}
```

| Status / code | Meaning | Orbit action |
|---|---|---|
| 401 `F-EAPIM-IGTWY-E40100` | Bad or expired token | Refresh the token once, then fail as auth |
| 403 `F-EAPIM-IGTWY-E40300` | Use-case not entitled, or missing `x-wf-usecase-id` | Fail (configuration). Never retry. |
| 500 `W-EAPIM-IGTWY-E50043` "Missing Header" | Missing `x-wf-api-key` | Fail (configuration). **Not transient**: never retry on this 500. |
| 400 `TAC002` "Invalid Header Data" | One of our headers is bad | Fail (bug). Never retry. |
| 400 `TAC006` "Model Execution Exception" | The backend model call failed. **This also happens for bad parameters.** | Try the ceiling-parameter swap (section 4) if it applies. Otherwise try a fallback model once. Never resend the same request. |
| 424 `TAC010` / `TAC011` / `TAC012` | Model Armor blocked the prompt, response or attachment | Content blocked. Never retry. |
| 429 | Rate limited | Back off and retry |
| 408, 502, 503, 504, timeouts, connection errors | Transient | Retry with backoff |

The `detail` field can name the backend deployment URL (e.g. Azure OpenAI). Keep it in debug logs only, not in UI messages.

## 6. Usage and cost

- `usage` has `prompt_tokens`, `completion_tokens` and `total_tokens`.
- gpt-5.4 adds `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` and a `latency_checkpoint`. Claude reports only the counts.
- **There is no cost field.** Prices per model come from Orbit's config.

## 7. Not in v1

The `enqueue` / submission-polling path (the excel `LONG` tier, `SUBMISSION_RESPONSE_URL`). It doesn't fit an interactive coding loop. Note that an enqueued request **must never be retried**: a retry submits and bills the work again.
