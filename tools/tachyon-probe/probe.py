"""Tachyon discovery probe for Orbit's native TypeScript provider.

Orbit talks to Tachyon directly over HTTP, without the Python `tachyon_sdk`.
To build that without guessing, this script records how the SDK actually talks
to the gateway, and writes a report that never contains a secret value:

  1. SDK facts      version, module paths, and the source lines that build
                    headers, tokens and URLs (code, not configuration). The
                    SDK's `langchain_client/` and `common/` are scanned first.
  2. Wire capture   every HTTP request the SDK makes (Apigee token exchange and
                    chat completions): method, path, header NAMES, body SHAPE.
                    Header values are replaced by a FINGERPRINT that says where
                    the value comes from (`= $TACHYON_API_KEY`, `uuid4`, a
                    digit-masked date template, `= header x-wf-client-id`...)
                    without showing it. Strings in bodies become `<str:len=N>`.
  3. Behaviour      per model: which output-ceiling spelling it reads
                    (`max_tokens` vs `max_completion_tokens`, and both together),
                    MEASURED, never guessed from the name; then plain call,
                    streaming, tool calling and `seed`.
  4. Native check   (--native-check) the same calls made WITHOUT the SDK, using
                    only the recipe derived above, plus one call per optional
                    header with that header left out, to learn which ones the
                    gateway requires. This is the recipe Orbit implements.

Usage (Windows, Python >= 3.12, tachyon-sdk installed, TACHYON_* set as for the
excel project):

    py tools\\tachyon-probe\\probe.py --model claude-opus-4-5@20251101 \\
        --model gpt-5.4 --model gpt4o --native-check \\
        --capabilities ..\\excel\\config\\model-capabilities.json

Writes probe-report.json in the current directory. Read it before sharing it.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import importlib
import importlib.metadata
import json
import os
import platform
import re
import site
import ssl
import sys
import tempfile
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

PROBE_VERSION = 3

# The excel project names these DDA_TACHYON__*; the SDK reads TACHYON_*.
# Either spelling works here. An already-set TACHYON_* value always wins.
SDK_ENV = {
    "TACHYON_API_KEY": "DDA_TACHYON__API_KEY",
    "TACHYON_CHAT_COMPLETION_BASE_URL": "DDA_TACHYON__CHAT_COMPLETION_BASE_URL",
    "TACHYON_USECASE_ID": "DDA_TACHYON__USECASE_ID",
    "TACHYON_APIGEE_URL": "DDA_TACHYON__APIGEE_URL",
    "TACHYON_CONSUMER_KEY": "DDA_TACHYON__CONSUMER_KEY",
    "TACHYON_CONSUMER_SECRET": "DDA_TACHYON__CONSUMER_SECRET",
    "TACHYON_CERT_PATH": "DDA_TACHYON__CERT_PATH",
    "TACHYON_USE_API_GATEWAY": "DDA_TACHYON__USE_API_GATEWAY",
}
REQUIRED_ENV = [name for name in SDK_ENV if name != "TACHYON_USE_API_GATEWAY"]

# Keys whose string VALUES are kept: protocol facts, never credentials.
KEEP_VALUE_KEYS = {
    "model", "model_name", "object", "role", "type", "stream", "grant_type",
    "token_type", "expires_in", "scope", "finish_reason", "stop_reason",
    "tool_choice", "enqueue", "status", "code", "error_code", "name", "title",
    "content-type", "accept", "transfer-encoding", "content-encoding",
}
# Header values that are safe and useful to see verbatim.
KEEP_HEADER_VALUES = {"content-type", "accept", "transfer-encoding",
                      "content-encoding", "user-agent"}
# SDK constants, not credentials: shown verbatim unless they match a secret
# (the final leak check still applies to them).
VERBATIM_HEADERS = {"x-wf-client-type", "x-wf-client-version"}
# Headers the transport adds by itself; never part of Orbit's recipe.
TRANSPORT_HEADERS = {"host", "accept-encoding", "connection", "content-length",
                     "user-agent", "accept", "content-type", "cookie",
                     "date", "server", "strict-transport-security"}

# Source lines in the SDK worth reading: how headers, tokens and URLs are built.
SOURCE_PATTERN = re.compile(
    r"header|authorization|bearer|basic|apigee|access_token|expires|usecase|"
    r"use_case|consumer|client_id|client_type|client_version|api[_-]?key|"
    r"x-[a-z0-9-]+|[\"']from[\"']|request[_-]date|strftime|isoformat|uuid|"
    r"requests\.(post|get)|verify=|cert|base_url|chat_completion|"
    r"getSubmission|submission|enqueue|load_dotenv|__version__",
    re.IGNORECASE)
# The SDK files that build the LLM request, scanned first and never truncated.
PRIORITY_SOURCE = ("langchain_client/", "common/")
# Agent-to-agent, MCP and ADK server code: not on the chat-completion path.
SKIPPED_SOURCE = ("a2a/", "mcp_core/", "adk")
HOST_PATTERN = re.compile(r"https?://[^/\s\"']+")
# A local user folder in any spelling a traceback or repr can produce.
HOME_PATTERN = re.compile(
    r"(?i)(?:[a-z]:)?(?:\\\\|\\|/)(?:users|home)(?:\\\\|\\|/)[^\\/\s'\"]+")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE)
DATE_CHARS = re.compile(r"^[0-9][0-9:.+\-TZ /]*$")
TAC_CODE = re.compile(r"TAC\d{3}")


def local_paths() -> list[str]:
    """Directories whose names identify this machine or user."""
    paths = {str(Path.home()), sys.prefix, sys.base_prefix}
    try:
        paths.update(site.getsitepackages())
    except AttributeError:  # some virtualenvs
        pass
    paths.add(site.getusersitepackages() if hasattr(site, "getusersitepackages")
              else "")
    return sorted((p for p in paths if p and len(p) > 3), key=len, reverse=True)


class Redactor:
    """Every secret that could leak, and the one place that removes them."""

    def __init__(self, keep_hosts: bool) -> None:
        self.keep_hosts = keep_hosts
        self.named: dict[str, str] = {
            k: v for k, v in os.environ.items()
            if v and len(v) >= 6 and k.startswith(("TACHYON_", "DDA_TACHYON__"))
            and not k.endswith(("_USE_API_GATEWAY", "_CERT_PATH"))}
        self.dynamic: set[str] = set()   # access tokens seen on the wire
        self.paths = local_paths()
        try:
            self.sdk_version = importlib.metadata.version("tachyon-sdk")
        except importlib.metadata.PackageNotFoundError:
            self.sdk_version = None

    @property
    def secrets(self) -> list[str]:
        return sorted(set(self.named.values()) | self.dynamic,
                      key=len, reverse=True)

    def add_secret(self, value: str) -> None:
        if value and len(value) >= 6:
            self.dynamic.add(value)

    def text(self, value: str) -> str:
        for secret in self.secrets:
            value = value.replace(secret, "<redacted:secret>")
        for path in self.paths:
            for spelling in {path, path.replace("\\", "\\\\")}:
                value = value.replace(spelling, "<local-path>")
        value = HOME_PATTERN.sub("<home>", value)
        if not self.keep_hosts:
            value = HOST_PATTERN.sub(
                lambda m: m.group(0).split("://")[0] + "://<host>", value)
        return value

    def url(self, url: str) -> dict[str, Any]:
        parts = urlsplit(url)
        return {
            "scheme": parts.scheme,
            "host": parts.netloc if self.keep_hosts else "<host>",
            "path": self.text(parts.path),
            "query_keys": [k for k, _ in parse_qsl(parts.query)],
        }

    def env_name_of(self, value: str) -> str | None:
        """The DDA_/TACHYON_ variable holding exactly this value, if any."""
        names = sorted(k for k, v in self.named.items() if v == value)
        tachyon = [n for n in names if n.startswith("TACHYON_")]
        return (tachyon or names or [None])[0]

    def fingerprint(self, name: str, value: str,
                    earlier: dict[str, str]) -> str:
        """Where a header value comes from, without the value itself."""
        if (env := self.env_name_of(value)):
            return f"= ${env}"
        if name == "authorization" and " " in value:
            scheme, credential = value.split(" ", 1)
            if scheme.lower() == "basic":
                return f"Basic {self.basic_fingerprint(credential)}"
            if credential in self.dynamic:
                return f"{scheme} <access_token from the token response>"
            if (env := self.env_name_of(credential)):
                return f"{scheme} ${env}"
            return f"{scheme} <unknown:len={len(credential)}>"
        for other, other_value in earlier.items():
            if other_value == value:
                return f"= header {other}"
        if (match := UUID_PATTERN.match(value)):
            return f"uuid (version {match.group(1)})"
        if self.sdk_version and value == self.sdk_version:
            return "= installed tachyon-sdk version"
        if DATE_CHARS.match(value):
            return "date/number template " + re.sub(r"\d", "9", value)
        for env, secret in self.named.items():
            if secret in value:
                return f"contains ${env} (len={len(value)})"
        return f"<unknown:len={len(value)}>"

    def basic_fingerprint(self, credential: str) -> str:
        try:
            user, _, password = base64.b64decode(credential).decode().partition(":")
        except Exception:
            return f"<not base64:len={len(credential)}>"
        left = self.env_name_of(user)
        right = self.env_name_of(password)
        return (f"base64(${left or f'<unknown:len={len(user)}>'}:"
                f"${right or f'<unknown:len={len(password)}>'})")

    def headers(self, headers: Any) -> dict[str, str]:
        out: dict[str, str] = {}
        earlier: dict[str, str] = {}
        for name, value in dict(headers).items():
            key = str(name).lower()
            value = value.decode() if isinstance(value, bytes) else str(value)
            if key in KEEP_HEADER_VALUES:
                out[key] = self.text(value)
            elif key in ("set-cookie", "cookie"):
                out[key] = "<present>"
            elif key in TRANSPORT_HEADERS or key.startswith("x-stainless"):
                out[key] = f"<redacted:len={len(value)}>"
            elif key in VERBATIM_HEADERS and not any(
                    s in value for s in self.secrets):
                out[key] = f"{value!r} (verbatim: SDK constant)"
            else:
                out[key] = (f"<redacted:len={len(value)}> "
                            f"{self.fingerprint(key, value, earlier)}")
            earlier[key] = value
        return out

    def shape(self, value: Any, key: str = "") -> Any:
        """The structure of a JSON value, with every string value redacted
        unless its key is a known protocol fact."""
        if isinstance(value, dict):
            return {k: self.shape(v, str(k).lower()) for k, v in value.items()}
        if isinstance(value, list):
            if not value:
                return []
            # first two items show the element shape without dumping history
            return [self.shape(v, key) for v in value[:2]] + (
                [f"<+{len(value) - 2} more>"] if len(value) > 2 else [])
        if isinstance(value, str):
            if key in KEEP_VALUE_KEYS and len(value) < 200:
                return self.text(value)
            if key == "detail":  # gateway error text: keep, minus hosts/secrets
                return self.text(value)[:300]
            return f"<str:len={len(value)}>"
        return value  # numbers, booleans, null: facts, not secrets

    def body(self, raw: bytes | str | None, content_type: str) -> Any:
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        if not raw:
            return ""
        if "event-stream" in content_type or raw.lstrip().startswith("data:"):
            return self.sse(raw)
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        if parsed is not None:
            if isinstance(parsed, dict) and isinstance(
                    parsed.get("access_token"), str):
                self.add_secret(parsed["access_token"])
            return self.shape(parsed)
        if "x-www-form-urlencoded" in content_type or (
                "=" in raw and " " not in raw[:200]):
            return {"form_keys": [k for k, _ in parse_qsl(raw)],
                    "form": {k: (v if k.lower() in KEEP_VALUE_KEYS
                                 else f"<redacted:len={len(v)}>")
                             for k, v in parse_qsl(raw)}}
        return f"<non-json:len={len(raw)}>"

    def sse(self, raw: str) -> dict[str, Any]:
        events = [line[5:].strip() for line in raw.splitlines()
                  if line.startswith("data:")]
        parsed = []
        for event in events:
            try:
                parsed.append(json.loads(event))
            except ValueError:
                pass
        return {
            "sse_events": len(events),
            "ends_with_done": bool(events) and events[-1] == "[DONE]",
            "first_event": self.shape(parsed[0]) if parsed else None,
            "last_json_event": self.shape(parsed[-1]) if parsed else None,
        }

    def error(self, error: BaseException) -> dict[str, Any]:
        text = f"{type(error).__name__}: {error}"
        codes = sorted(set(TAC_CODE.findall(text)))
        return {"error": self.text(text)[:600],
                "status_code": getattr(error, "status_code", None),
                "tac_codes": codes,
                "trace_tail": self.text("".join(
                    traceback.format_exc().splitlines(True)[-4:]))[:800]}


class WireRecorder:
    """Patches requests and httpx at class level so every client the SDK
    builds, including the OpenAI client inside it, is recorded."""

    def __init__(self, redactor: Redactor) -> None:
        self.redactor = redactor
        self.exchanges: list[dict[str, Any]] = []
        self.label = "setup"
        # Raw values, kept in memory ONLY, for the native check to copy
        # constants it cannot derive. Never written to the report.
        self.raw_token_url: str | None = None
        self.raw_chat_headers: dict[str, str] = {}

    def record(self, method: str, url: str, req_headers: Any,
               req_body: Any, status: int | None, resp_headers: Any,
               resp_body: Any, elapsed: float, error: str | None) -> None:
        r = self.redactor
        lower = {str(k).lower(): (v.decode() if isinstance(v, bytes) else str(v))
                 for k, v in dict(req_headers or {}).items()}
        if url.rstrip("/").endswith("/chat/completions") and \
                not self.label.startswith("native"):
            self.raw_chat_headers = lower
        elif "token" in urlsplit(url).path and self.raw_token_url is None:
            self.raw_token_url = url
        resp_ct = {str(k).lower(): str(v) for k, v in
                   dict(resp_headers or {}).items()}.get("content-type", "")
        response_body = r.body(resp_body, resp_ct)  # learns access tokens first
        self.exchanges.append({
            "test": self.label,
            "method": method,
            "url": r.url(url),
            "request_headers": r.headers(req_headers or {}),
            "request_body": r.body(req_body, lower.get("content-type", "")),
            "status": status,
            "response_headers": r.headers(resp_headers or {}),
            "response_body": response_body,
            "elapsed_s": round(elapsed, 3),
            "error": r.text(error) if error else None,
        })

    def install(self) -> None:
        self._patch_requests()
        for sync_cls, async_cls in httpx_classes():
            self._patch_httpx_pair(sync_cls, async_cls)

    def _patch_requests(self) -> None:
        try:
            import requests
        except ImportError:
            return
        original = requests.Session.send
        recorder = self

        def send(session: Any, request: Any, **kwargs: Any) -> Any:
            start = time.monotonic()
            try:
                response = original(session, request, **kwargs)
            except Exception as error:
                recorder.record(request.method, request.url, request.headers,
                                request.body, None, {}, None,
                                time.monotonic() - start, repr(error))
                raise
            body = None
            if not kwargs.get("stream"):
                body = response.content
            recorder.record(request.method, request.url, request.headers,
                            request.body, response.status_code,
                            response.headers, body,
                            time.monotonic() - start, None)
            return response

        requests.Session.send = send  # type: ignore[method-assign]

    def _patch_httpx_pair(self, sync_cls: Any, async_cls: Any) -> None:
        recorder = self
        sync_send, async_send = sync_cls.send, async_cls.send

        def body_of(request: Any) -> bytes | None:
            try:
                return request.content
            except Exception:
                return None

        def send(client: Any, request: Any, **kwargs: Any) -> Any:
            start = time.monotonic()
            try:
                response = sync_send(client, request, **kwargs)
                # read() caches the body; the caller's iteration then replays it
                response.read()
            except Exception as error:
                recorder.record(request.method, str(request.url),
                                request.headers, body_of(request), None, {},
                                None, time.monotonic() - start, repr(error))
                raise
            recorder.record(request.method, str(request.url), request.headers,
                            body_of(request), response.status_code,
                            response.headers, response.content,
                            time.monotonic() - start, None)
            return response

        async def asend(client: Any, request: Any, **kwargs: Any) -> Any:
            start = time.monotonic()
            try:
                response = await async_send(client, request, **kwargs)
                await response.aread()
            except Exception as error:
                recorder.record(request.method, str(request.url),
                                request.headers, body_of(request), None, {},
                                None, time.monotonic() - start, repr(error))
                raise
            recorder.record(request.method, str(request.url), request.headers,
                            body_of(request), response.status_code,
                            response.headers, response.content,
                            time.monotonic() - start, None)
            return response

        sync_cls.send = send
        async_cls.send = asend


def httpx_classes() -> list[tuple[Any, Any]]:
    """The (Client, AsyncClient) pairs to patch. Recent `openai` releases ship
    their own renamed copy of httpx (`httpx2`), so the classes are found both
    by module name and from the OpenAI client's own class hierarchy."""
    found: dict[int, tuple[Any, Any]] = {}
    for name in ("httpx", "httpx2"):
        try:
            module = importlib.import_module(name)
            found[id(module.Client)] = (module.Client, module.AsyncClient)
        except Exception:
            pass
    try:
        from openai import _base_client as base
        sync_base = next(c for c in base.SyncHttpxClientWrapper.__mro__
                         if c.__name__ == "Client")
        async_base = next(c for c in base.AsyncHttpxClientWrapper.__mro__
                          if c.__name__ == "AsyncClient")
        found[id(sync_base)] = (sync_base, async_base)
    except Exception:
        pass
    return list(found.values())


def prepare_env() -> dict[str, Any]:
    for sdk_name, dda_name in SDK_ENV.items():
        if not os.environ.get(sdk_name) and os.environ.get(dda_name):
            os.environ[sdk_name] = os.environ[dda_name]
    cert_note = None
    if not os.environ.get("TACHYON_CERT_PATH"):
        b64 = os.environ.get("DDA_TACHYON__CERT_B64") or os.environ.get(
            "TACHYON_CERT_B64")
        if b64:
            pem = b64 if b64.lstrip().startswith("-----BEGIN") else \
                base64.b64decode(b64).decode()
            path = Path(tempfile.gettempdir()) / "orbit-tachyon-ca.pem"
            path.write_text(pem, encoding="utf-8")
            os.environ["TACHYON_CERT_PATH"] = str(path)
            cert_note = "CA bundle materialised from CERT_B64 to a temp file"
    try:
        import truststore  # same as excel's container: OS trust store first
        truststore.inject_into_ssl()
        trust = "truststore injected (OS certificate store)"
    except ImportError:
        trust = "truststore not installed; Python default CA store"
    return {
        "set": sorted(k for k in SDK_ENV if os.environ.get(k)),
        "missing": [k for k in REQUIRED_ENV if not os.environ.get(k)],
        "use_api_gateway": os.environ.get("TACHYON_USE_API_GATEWAY", "<unset>"),
        "cert": cert_note or ("TACHYON_CERT_PATH set"
                              if os.environ.get("TACHYON_CERT_PATH")
                              else "no CA bundle configured"),
        "trust_store": trust,
        "dotenv_in_cwd": Path(".env").exists(),
    }


def sdk_facts(redactor: Redactor, max_hits: int, scan_all: bool,
              dump_files: list[str]) -> dict[str, Any]:
    facts: dict[str, Any] = {"python": sys.version.split()[0],
                             "platform": platform.platform()}
    for dist in ("tachyon-sdk", "tachyon_sdk", "langchain-openai",
                 "langchain-core", "openai", "httpx", "requests"):
        try:
            facts.setdefault("versions", {})[dist] = \
                importlib.metadata.version(dist)
        except importlib.metadata.PackageNotFoundError:
            pass
    try:
        package = importlib.import_module("tachyon_sdk")
    except Exception as error:
        facts["import_error"] = f"{type(error).__name__}: {error}"
        return facts
    root = Path(package.__file__).parent
    facts["package_dir"] = "<site-packages>/" + root.name
    files = sorted(root.rglob("*.py"))
    facts["modules"] = [f.relative_to(root).as_posix() for f in files]

    def lines_of(file: Path) -> list[str]:
        try:
            return file.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []

    # 1. the LLM request path, in full: never cut by the budget
    priority: list[str] = []
    others: list[str] = []
    skipped = 0
    for file in files:
        rel = file.relative_to(root).as_posix()
        if rel.startswith(PRIORITY_SOURCE):
            target = priority
        elif not scan_all and rel.startswith(SKIPPED_SOURCE):
            skipped += 1
            continue
        else:
            target = others
        for number, line in enumerate(lines_of(file), 1):
            if SOURCE_PATTERN.search(line):
                target.append(f"{rel}:{number}: {redactor.text(line.strip())[:240]}")
    facts["source_hits_priority"] = priority
    facts["source_hits_other"] = others[:max_hits]
    facts["source_hits_other_truncated"] = len(others) > max_hits
    facts["source_files_skipped"] = skipped
    # 2. whole files on request
    dumped: dict[str, Any] = {}
    for rel in dump_files:
        file = (root / rel).resolve()
        if root.resolve() not in file.parents or not file.is_file():
            dumped[rel] = "<not found in tachyon_sdk>"
            continue
        dumped[rel] = [f"{n}: {redactor.text(line)}"
                       for n, line in enumerate(lines_of(file), 1)]
    if dumped:
        facts["dumped_files"] = dumped
    try:
        from tachyon_sdk.langchain_client import TachyonLangchainClient
        facts["client_mro"] = [f"{c.__module__}.{c.__name__}"
                               for c in TachyonLangchainClient.__mro__[:4]]
        fields = getattr(TachyonLangchainClient, "model_fields", {})
        facts["client_fields"] = sorted(fields)
    except Exception as error:
        facts["client_import_error"] = f"{type(error).__name__}: {error}"
    return facts


# The output ceiling has two spellings and they are NOT interchangeable on
# Tachyon (excel: config/model-capabilities.json, maxTokensParam; probe v2):
#   max_tokens             Claude, Gemini, Llama, gpt4.1, gpt4o, gpt-oss
#   max_completion_tokens  the gpt-5.x family, which REJECTS raw max_tokens
#   both together          gpt4o (Azure backend) fails with TAC006
# The SDK's client is a ChatOpenAI: its `max_tokens` FIELD goes on the wire as
# `max_completion_tokens`; the raw name only arrives through `extra_body`.
# A model sent the spelling it ignores fails silently: the reply is cut at the
# platform default (1024) and still looks well-formed. So it is measured here,
# never inferred from the model name, and exactly ONE spelling is ever sent.
RAW, FIELD, BOTH = "max_tokens", "max_completion_tokens", "both"
PROBE_CEILING = 24
COUNT_PROMPT = ("Count from 1 to 400. Write one number per line and nothing "
                "else. Do not stop early.")


def build_client(model: str, spelling: str, ceiling: int = 64,
                 temperature: float = 0.0, **extra: Any) -> Any:
    """spelling: RAW (raw name only), FIELD (field only) or BOTH."""
    from tachyon_sdk.langchain_client import TachyonLangchainClient
    kwargs: dict[str, Any] = {}
    if spelling in (FIELD, BOTH):
        kwargs["max_tokens"] = ceiling
    if spelling in (RAW, BOTH):
        kwargs["extra_body"] = {"max_tokens": ceiling}
    # mirrors excel's TachyonGateway._model: explicit temperature, no retries
    return TachyonLangchainClient(model_name=model, timeout=90,
                                  temperature=temperature, max_retries=0,
                                  **kwargs, **extra)


def load_capabilities(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8")).get("models", {})


def recorded_spelling(capabilities: dict[str, Any], model: str) -> str | None:
    """excel's lookup: exact id first, then `name@version` against `name`."""
    entry = capabilities.get(model) or capabilities.get(model.split("@")[0])
    if entry is None:
        return None
    return entry.get("maxTokensParam", RAW)


async def measure_ceiling(model: str, redactor: Redactor) -> dict[str, Any]:
    """Ask for a long answer under a tiny ceiling, once per spelling.
    cut short -> honoured; ran long -> ignored; error -> rejected."""
    outcomes: dict[str, Any] = {}
    for spelling in (RAW, FIELD, BOTH):
        client = build_client(model, spelling, ceiling=PROBE_CEILING)
        try:
            reply = await client.ainvoke([("human", COUNT_PROMPT)])
        except Exception as error:
            failure = redactor.error(error)
            outcomes[spelling] = {"outcome": "rejected",
                                  "status_code": failure["status_code"],
                                  "tac_codes": failure["tac_codes"],
                                  "error_type": type(error).__name__,
                                  "error": failure["error"][:300]}
            continue
        finish = reply.response_metadata.get("finish_reason")
        used = (getattr(reply, "usage_metadata", None) or {}).get("output_tokens")
        # Judge by the token count, not finish_reason: a reply cut at the
        # PLATFORM default (1024) also says "length", which is exactly the
        # silent failure being measured.
        if used is not None:
            outcome = "honoured" if used <= PROBE_CEILING + 8 else "ignored"
        elif finish in ("length", "max_tokens"):
            outcome = "unclear"  # cut, but by whose ceiling is unknown
        else:
            outcome = "ignored"
        outcomes[spelling] = {"outcome": outcome, "finish_reason": finish,
                              "output_tokens": used}
    raw, field = outcomes[RAW]["outcome"], outcomes[FIELD]["outcome"]
    if "unclear" in (raw, field):
        verdict = None      # no usage data to tell the ceilings apart
    elif raw == "honoured":   # both honoured -> raw, as excel records it
        verdict = RAW
    elif field == "honoured":
        verdict = FIELD
    else:
        verdict = None      # unreachable or neither honoured: do not guess
    return {"verdict": verdict, "ceiling": PROBE_CEILING,
            "both_together_safe": outcomes[BOTH]["outcome"] != "rejected",
            **outcomes}


async def run_tests(model: str, recorded: str | None,
                    recorder: WireRecorder, skip: set[str]) -> dict[str, Any]:
    results: dict[str, Any] = {}
    redactor = recorder.redactor
    messages = [("system", "You are a test endpoint."),
                ("human", "Reply with the single word: ok")]

    async def test(name: str, body: Any) -> None:
        if name in skip:
            results[name] = "skipped"
            return
        recorder.label = f"{model}:{name}"
        try:
            results[name] = await body()
        except Exception as error:
            results[name] = redactor.error(error)

    await test("ceiling", lambda: measure_ceiling(model, redactor))
    measured = results["ceiling"].get("verdict") if isinstance(
        results["ceiling"], dict) else None
    spelling = measured or recorded or RAW
    results["max_tokens_param"] = {
        "measured": measured,
        "recorded_in_capabilities": recorded,
        "used_for_tests": spelling,
        "source": "measured" if measured else
                  "capabilities file" if recorded else "default (unverified)",
        "mismatch": bool(measured and recorded and measured != recorded),
    }

    async def plain() -> Any:
        reply = await build_client(model, spelling).ainvoke(messages)
        return {"reply_len": len(str(reply.content)),
                "response_metadata": redactor.shape(reply.response_metadata),
                "usage_metadata": getattr(reply, "usage_metadata", None)}

    async def streaming() -> Any:
        client = build_client(model, spelling)
        chunks, text = 0, ""
        async for chunk in client.astream(messages):
            chunks += 1
            text += str(chunk.content)
        wire = [x for x in recorder.exchanges if x["test"] == recorder.label]
        last = wire[-1] if wire else {}
        return {"chunks_received": chunks, "reply_len": len(text),
                "request_had_stream_true":
                    isinstance(last.get("request_body"), dict)
                    and last["request_body"].get("stream") is True,
                "response_content_type":
                    last.get("response_headers", {}).get("content-type")}

    async def tools() -> Any:
        tool = {"type": "function", "function": {
            "name": "get_weather",
            "description": "Get the weather for a city.",
            "parameters": {"type": "object",
                           "properties": {"city": {"type": "string"}},
                           "required": ["city"]}}}
        client = build_client(model, spelling).bind_tools(
            [tool], tool_choice="auto")
        reply = await client.ainvoke([("human",
                                       "What is the weather in Paris? Use the tool.")])
        calls = getattr(reply, "tool_calls", []) or []
        return {"tool_calls": [{"name": c.get("name"),
                                "arg_keys": sorted((c.get("args") or {}))}
                               for c in calls],
                "finish_reason": reply.response_metadata.get("finish_reason")}

    async def seed() -> Any:
        prompt = [("human", "Write one random 12-word sentence about the sea.")]
        replies = []
        for _ in range(2):
            client = build_client(model, spelling, temperature=1.0, seed=7)
            replies.append(str((await client.ainvoke(prompt)).content))
        wire = [x for x in recorder.exchanges if x["test"] == recorder.label]
        sent = any(isinstance(x.get("request_body"), dict)
                   and "seed" in x["request_body"] for x in wire)
        return {"seed_in_request": sent,
                "identical_outputs_at_temperature_1": replies[0] == replies[1],
                "note": "identical outputs suggest seed is honoured; "
                        "different outputs mean it is not"}

    await test("plain", plain)
    await test("streaming", streaming)
    await test("tools", tools)
    await test("seed", seed)
    return results


# ---------------------------------------------------------------- native check
# Everything below talks to Tachyon WITHOUT tachyon_sdk, exactly as Orbit's
# TypeScript provider will. Each header value is DERIVED from a rule (env var,
# fresh uuid, current time in the observed format, SDK constant); a value the
# probe cannot derive is copied from the SDK's own request and marked
# "copied", which means the recipe for that header is not yet known.

DATE_FORMATS = [  # candidate formats, matched against the observed template
    ("isoformat", lambda now: now.replace(tzinfo=None).isoformat()),
    ("isoformat-utc", lambda now: now.isoformat()),
    ("isoformat-ms", lambda now: now.replace(tzinfo=None).isoformat(
        timespec="milliseconds")),
    ("%Y-%m-%dT%H:%M:%S.%fZ", lambda now: now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")),
    ("%Y-%m-%d %H:%M:%S.%f", lambda now: now.strftime("%Y-%m-%d %H:%M:%S.%f")),
    ("%Y-%m-%dT%H:%M:%SZ", lambda now: now.strftime("%Y-%m-%dT%H:%M:%SZ")),
    ("%Y-%m-%dT%H:%M:%S", lambda now: now.strftime("%Y-%m-%dT%H:%M:%S")),
    ("%Y%m%d%H%M%S", lambda now: now.strftime("%Y%m%d%H%M%S")),
    ("epoch-ms", lambda now: str(int(now.timestamp() * 1000))),
    ("epoch-s", lambda now: str(int(now.timestamp()))),
]


def mask(value: str) -> str:
    return re.sub(r"\d", "9", value)


def common_prefix(a: str, b: str) -> int:
    return len(os.path.commonprefix([a, b]))


def derive_rule(name: str, value: str, redactor: Redactor,
                earlier: dict[str, str]) -> dict[str, Any]:
    """The rule that reproduces one observed header value."""
    if (env := redactor.env_name_of(value)):
        return {"rule": "env", "env": env}
    for other, other_value in earlier.items():
        if other_value == value:
            return {"rule": "same-as", "header": other}
    if UUID_PATTERN.match(value):
        return {"rule": "uuid4"}
    if redactor.sdk_version and value == redactor.sdk_version:
        return {"rule": "constant", "value": value, "why": "tachyon-sdk version"}
    if DATE_CHARS.match(value):
        for label, render in DATE_FORMATS:
            utc = render(datetime.now(timezone.utc))
            if mask(utc) != mask(value):
                continue
            # the mask cannot tell UTC from local time; the observed value was
            # taken moments ago, so the zone whose rendering shares the longer
            # prefix with it (same date and hour) is the one the SDK used
            local = render(datetime.now().astimezone())
            zone = "utc" if common_prefix(utc, value) >= common_prefix(
                local, value) else "local"
            return {"rule": "date", "format": label, "zone": zone,
                    "template": mask(value),
                    "zone_certain": utc[:13] != local[:13]}
    if name in VERBATIM_HEADERS:
        return {"rule": "constant", "value": value}
    return {"rule": "copied"}  # not derivable: the recipe is incomplete here


def render_rule(rule: dict[str, Any], observed: str,
                built: dict[str, str]) -> str:
    kind = rule["rule"]
    if kind == "env":
        return os.environ[rule["env"]]
    if kind == "same-as":
        return built[rule["header"]]
    if kind == "uuid4":
        return str(uuid.uuid4())
    if kind == "constant":
        return rule["value"]
    if kind == "date":
        zone = timezone.utc if rule["zone"] == "utc" else None
        now = datetime.now(zone) if zone else datetime.now().astimezone()
        return dict(DATE_FORMATS)[rule["format"]](now)
    return observed


def tls_context() -> ssl.SSLContext:
    """The OS trust store (as excel's container injects) plus the CA bundle."""
    try:
        import truststore
        context: ssl.SSLContext = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        context = ssl.create_default_context()
    cafile = os.environ.get("TACHYON_CERT_PATH")
    if cafile and Path(cafile).is_file():
        context.load_verify_locations(cafile=cafile)
    return context


def native_check(recorder: WireRecorder, model: str, spelling: str,
                 header_ablation: bool) -> dict[str, Any]:
    """Orbit's recipe, proven against the live gateway without the SDK."""
    import httpx
    redactor = recorder.redactor
    result: dict[str, Any] = {"model": model, "ceiling_param": spelling}
    if not recorder.raw_chat_headers:
        return {"skipped": "no SDK chat call was captured to derive a recipe from"}

    # --- the recipe: one rule per header the SDK sent ---
    rules: dict[str, dict[str, Any]] = {}
    earlier: dict[str, str] = {}
    for name, value in recorder.raw_chat_headers.items():
        if name in TRANSPORT_HEADERS or name.startswith("x-stainless"):
            continue
        if name == "authorization":
            rules[name] = {"rule": "bearer-token"}
        else:
            rules[name] = derive_rule(name, value, redactor, earlier)
        earlier[name] = value
    result["header_recipe"] = {
        k: ({**v, "value": "<shown in the verbatim headers above>"}
            if v["rule"] == "constant" else v) for k, v in rules.items()}
    copied = sorted(k for k, v in rules.items() if v["rule"] == "copied")
    result["headers_not_derivable"] = copied

    with httpx.Client(verify=tls_context(), timeout=90) as client:
        # --- token: the URL the SDK used, compared with the env setting ---
        token_url = recorder.raw_token_url or os.environ["TACHYON_APIGEE_URL"]
        configured = os.environ.get("TACHYON_APIGEE_URL", "")
        result["token_url"] = (
            "= $TACHYON_APIGEE_URL" if token_url == configured else
            "= $TACHYON_APIGEE_URL + " + redactor.text(
                token_url[len(configured):]) if token_url.startswith(configured)
            else "differs from $TACHYON_APIGEE_URL (path "
                 f"{redactor.url(token_url)['path']})")
        basic = base64.b64encode(
            f"{os.environ['TACHYON_CONSUMER_KEY']}:"
            f"{os.environ['TACHYON_CONSUMER_SECRET']}".encode()).decode()
        recorder.label = "native:token"
        response = client.post(token_url, data={"grant_type": "client_credentials"},
                               headers={"Authorization": f"Basic {basic}"})
        result["token_status"] = response.status_code
        if response.status_code != 200:
            result["token_error"] = redactor.body(response.content,
                                                  response.headers.get(
                                                      "content-type", ""))
            return result
        token = response.json()["access_token"]
        redactor.add_secret(token)

        def build_headers(drop: str | None = None) -> dict[str, str]:
            built: dict[str, str] = {}
            for name, rule in rules.items():
                if rule["rule"] == "bearer-token":
                    built[name] = f"Bearer {token}"
                else:
                    built[name] = render_rule(
                        rule, recorder.raw_chat_headers[name], built)
            if drop:
                built.pop(drop, None)
            built["content-type"] = "application/json"
            return built

        url = os.environ["TACHYON_CHAT_COMPLETION_BASE_URL"].rstrip("/") + \
            "/chat/completions"
        body: dict[str, Any] = {
            "model": model, "temperature": 0.0, spelling: 16,
            "messages": [{"role": "user",
                          "content": "Reply with the single word: ok"}]}

        def call(label: str, payload: dict[str, Any],
                 drop: str | None = None) -> dict[str, Any]:
            recorder.label = f"native:{label}"
            try:
                reply = client.post(url, json=payload,
                                    headers=build_headers(drop))
            except Exception as error:
                return redactor.error(error)
            outcome: dict[str, Any] = {"status": reply.status_code}
            if reply.status_code >= 400:
                outcome["tac_codes"] = sorted(set(TAC_CODE.findall(reply.text)))
                outcome["body"] = redactor.body(
                    reply.content, reply.headers.get("content-type", ""))
            return outcome

        result["plain"] = call("plain", body)
        stream = call("streaming", {**body, "stream": True,
                                    "stream_options": {"include_usage": True}})
        last = next((x for x in reversed(recorder.exchanges)
                     if x["test"] == "native:streaming"), {})
        stream["response_body"] = last.get("response_body")
        result["streaming"] = stream
        result["recipe_works"] = (result["plain"].get("status") == 200
                                  and stream.get("status") == 200)
        result["recipe_complete"] = result["recipe_works"] and not copied

        if header_ablation and result["recipe_works"]:
            required, optional = [], []
            for name in rules:
                outcome = call(f"without:{name}", body, drop=name)
                (optional if outcome.get("status") == 200 else required).append(
                    {"header": name, **outcome})
            result["required_headers"] = required
            result["optional_headers"] = [x["header"] for x in optional]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", action="append", required=True,
                        help="Tachyon model id; repeat for several")
    parser.add_argument("--capabilities", metavar="PATH",
                        help="excel's config/model-capabilities.json; its "
                             "maxTokensParam is compared with the measurement "
                             "and used if a model cannot be measured")
    parser.add_argument("--skip", action="append", default=[],
                        choices=["ceiling", "plain", "streaming", "tools", "seed"])
    parser.add_argument("--native-check", action="store_true",
                        help="repeat a plain and a streaming call without the "
                             "SDK, then once per header with it left out")
    parser.add_argument("--no-header-ablation", action="store_true",
                        help="with --native-check: skip the one-call-per-header "
                             "test of which headers are required")
    parser.add_argument("--dump-file", action="append", default=[],
                        metavar="REL_PATH",
                        help="include a whole tachyon_sdk file (relative to the "
                             "package, e.g. common/http_interceptor.py), with "
                             "secrets, hosts and local paths redacted")
    parser.add_argument("--scan-all", action="store_true",
                        help="also scan the SDK's a2a/, mcp_core/ and adk code")
    parser.add_argument("--keep-hosts", action="store_true",
                        help="keep hostnames in the report (default: <host>)")
    parser.add_argument("--max-source-hits", type=int, default=600,
                        help="cap for NON-priority source lines")
    parser.add_argument("--out", default="probe-report.json")
    args = parser.parse_args()

    env = prepare_env()
    redactor = Redactor(args.keep_hosts)  # built after env so it sees all secrets
    report: dict[str, Any] = {
        "probe_version": PROBE_VERSION, "env": env,
        "sdk": sdk_facts(redactor, args.max_source_hits, args.scan_all,
                         args.dump_file)}
    if env["missing"]:
        print("missing settings: " + ", ".join(env["missing"]), file=sys.stderr)
    capabilities = load_capabilities(args.capabilities)
    recorder = WireRecorder(redactor)
    recorder.install()
    async def probe_all() -> dict[str, Any]:
        # ONE event loop for every model: langchain-openai caches its async
        # HTTP client across clients, and a second asyncio.run() would hand
        # it a closed loop ("Event loop is closed")
        results = {}
        for model in args.model:
            print(f"probing {model} ...")
            results[model] = await run_tests(
                model, recorded_spelling(capabilities, model), recorder,
                set(args.skip))
        return results

    report["models"] = asyncio.run(probe_all())
    if args.native_check:
        model = args.model[0]
        spelling = report["models"][model]["max_tokens_param"]["used_for_tests"]
        print(f"native check (no SDK) with {model} ...")
        try:
            report["native_check"] = native_check(
                recorder, model, spelling, not args.no_header_ablation)
        except Exception as error:
            report["native_check"] = redactor.error(error)
    report["wire"] = recorder.exchanges

    text = json.dumps(report, indent=2, default=str)
    leaked = [s for s in redactor.secrets if s in text]
    home = str(Path.home())
    if leaked or (len(home) > 3 and home in text):
        # belt and braces: never write a report holding a secret or the user
        print(f"ABORTED: {len(leaked)} secret value(s) or the home folder "
              "survived redaction; no report written. Please report this bug.",
              file=sys.stderr)
        return 2
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"wrote {args.out} ({len(recorder.exchanges)} HTTP exchanges). "
          "Review it before sharing.")
    for model, results in report["models"].items():
        param = results["max_tokens_param"]
        flag = "  <-- differs from capabilities file" if param["mismatch"] else ""
        print(f"  {model:40} {'param':10} {param['used_for_tests']} "
              f"({param['source']}){flag}")
        ceiling = results.get("ceiling")
        if isinstance(ceiling, dict) and "both_together_safe" in ceiling:
            print(f"  {model:40} {'both':10} "
                  f"{'ok' if ceiling['both_together_safe'] else 'REJECTED'}"
                  f" {ceiling[BOTH].get('tac_codes') or ''}")
        for name, result in results.items():
            if name == "max_tokens_param":
                continue
            ok = "error" not in result if isinstance(result, dict) else result
            print(f"  {model:40} {name:10} {'ok' if ok is True else ok}")
    native = report.get("native_check")
    if isinstance(native, dict):
        print(f"  native check: works={native.get('recipe_works')} "
              f"complete={native.get('recipe_complete')} "
              f"not-derivable={native.get('headers_not_derivable')} "
              f"required={[x['header'] for x in native.get('required_headers', [])]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
