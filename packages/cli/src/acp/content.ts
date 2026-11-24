import type { ContentBlock, ContentChunk, ResourceLink } from "@agentclientprotocol/sdk"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export type PromptPart =
  | { readonly type: "text"; readonly text: string; readonly synthetic?: boolean; readonly ignored?: boolean }
  | { readonly type: "file"; readonly url: string; readonly filename?: string; readonly mime: string }

export type ReplayPart = PromptPart | { readonly type: "reasoning"; readonly text: string }

export function promptContentToParts(content: readonly ContentBlock[]): PromptPart[] {
  return content.flatMap(contentBlockToParts)
}

export function contentBlockToParts(block: ContentBlock): PromptPart[] {
  switch (block.type) {
    case "text": {
      const audience = block.annotations?.audience
      if (audience?.length === 1 && audience[0] === "assistant") {
        return [{ type: "text", text: block.text, synthetic: true }]
      }
      if (audience?.length === 1 && audience[0] === "user") {
        return [{ type: "text", text: block.text, ignored: true }]
      }
      return [{ type: "text", text: block.text }]
    }
    case "image":
      if (block.data) {
        return [
          {
            type: "file",
            url: `data:${block.mimeType};base64,${block.data}`,
            filename: filenameFromUri(block.uri ?? undefined) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      if (block.uri?.startsWith("data:") || block.uri?.startsWith("http://") || block.uri?.startsWith("https://")) {
        return [
          {
            type: "file",
            url: block.uri,
            filename: filenameFromUri(block.uri) ?? "image",
            mime: block.mimeType,
          },
        ]
      }
      return []
    case "resource_link":
      return [resourceLinkToPart(block)]
    case "resource":
      if (block.resource.uri.startsWith("file:")) return [fileResource(block.resource.uri, block.resource.mimeType)]
      if ("text" in block.resource) {
        // Sent as a text attachment, not as prompt text: the core escapes an attachment's text as data, while a plain
        // text part would reach the model as the person's own words.
        return [
          {
            type: "file",
            url: `data:text/plain;base64,${Buffer.from(block.resource.text, "utf8").toString("base64")}`,
            filename: resourceLabel(block.resource.uri),
            mime: "text/plain",
          },
        ]
      }
      if (!block.resource.mimeType) return []
      return [
        {
          type: "file",
          url: block.resource.uri.startsWith("data:")
            ? block.resource.uri
            : `data:${block.resource.mimeType};base64,${block.resource.blob}`,
          filename: filenameFromUri(block.resource.uri) ?? "file",
          mime: block.resource.mimeType,
        },
      ]
    default:
      return []
  }
}

export function partsToContentChunks(parts: readonly ReplayPart[]): ContentChunk[] {
  return parts.flatMap((part): ContentChunk[] => {
    if (part.type === "text") {
      if (!part.text) return []
      return [
        {
          content: {
            type: "text",
            text: part.text,
            ...(part.synthetic ? { annotations: { audience: ["assistant" as const] } } : {}),
            ...(!part.synthetic && part.ignored ? { annotations: { audience: ["user" as const] } } : {}),
          },
        },
      ]
    }
    if (part.type === "reasoning") {
      return part.text ? [{ content: { type: "text", text: part.text } }] : []
    }
    if (part.url.startsWith("file://")) {
      return [
        {
          content: {
            type: "resource_link",
            uri: part.url,
            name: part.filename ?? "file",
            mimeType: part.mime,
          },
        },
      ]
    }
    if (!part.url.startsWith("data:")) return []
    const match = /^data:([^;]+);base64,(.*)$/.exec(part.url)
    if (!match?.[1] || match[2] === undefined) return []
    const mime = match[1]
    const data = match[2]
    if (mime.startsWith("image/")) {
      return [
        {
          content: {
            type: "image",
            mimeType: mime,
            data,
            uri: pathToFileURL(part.filename ?? "image").href,
          },
        },
      ]
    }
    // A label that is a URL (mcp://server/context) stays as it is; a file name gets a file URL without a :line suffix.
    const uri = (fallback: string) => {
      const label = part.filename ?? fallback
      return /^[a-z][a-z0-9+.-]+:\/\//i.test(label) && URL.canParse(label)
        ? label
        : pathToFileURL(label.replace(/:\d+(?:-\d+)?$/, "")).href
    }
    return [
      {
        content: {
          type: "resource",
          resource:
            mime.startsWith("text/") || mime === "application/json"
              ? {
                  uri: uri("file"),
                  mimeType: mime,
                  text: Buffer.from(data, "base64").toString("utf8"),
                }
              : {
                  uri: uri("file"),
                  mimeType: mime,
                  blob: data,
                },
        },
      },
    ]
  })
}

function resourceLabel(uri: string) {
  if (!URL.canParse(uri)) return uri
  const parsed = new URL(uri)
  if (parsed.protocol !== "file:") return uri
  const line = parsed.hash.match(/^#L(\d+)/)?.[1]
  const decoded = (() => {
    try {
      return fileURLToPath(parsed)
    } catch {
      return decodeURIComponent(parsed.pathname)
    }
  })()
  return `${path.sep === "\\" ? decoded.replace(/\\/g, "/") : decoded}${line ? `:${line}` : ""}`
}

// An embedded resource with a `file:` URI is the editor's copy of a file on disk, which an editor sends for an
// @-mention. It goes as a mention of that file, as a resource link does, so the server reads it only after the person's
// read rules and policies have decided its path, and leaves it out when they refuse it (classes 3 and 8). The lines of a
// `#L12-14` or `#L12:14` fragment become the mention's range. A URI that names another host is never read.
function fileResource(uri: string, mime: string | null | undefined): PromptPart {
  const url = URL.canParse(uri) ? new URL(uri) : undefined
  if (url?.protocol !== "file:" || (url.host !== "" && url.host !== "localhost")) return linkReference(undefined, uri)
  const lines = /^#L(\d+)(?:[-:]L?(\d+))?$/.exec(url.hash)
  url.hash = ""
  if (lines?.[1]) {
    url.searchParams.set("start", lines[1])
    url.searchParams.set("end", lines[2] ?? lines[1])
  }
  return { type: "file", url: url.href, filename: resourceLabel(uri), mime: mime ?? "text/plain" }
}

function resourceLinkToPart(link: ResourceLink): PromptPart {
  if (link.uri.startsWith("file://")) {
    return {
      type: "file",
      url: link.uri,
      filename: link.name || filenameFromUri(link.uri) || "file",
      mime: link.mimeType ?? "text/plain",
    }
  }
  if (link.uri.startsWith("zed://") && URL.canParse(link.uri)) {
    const pathname = new URL(link.uri).searchParams.get("path")
    if (pathname)
      return {
        type: "file",
        url: pathToFileURL(pathname).href,
        filename: link.name || path.basename(pathname) || "file",
        mime: link.mimeType ?? "text/plain",
      }
  }
  return linkReference(link.name, link.uri)
}

export function linkReference(name: string | undefined, uri: string): PromptPart {
  return { type: "text", text: name ? `[${name}](${uri})` : uri }
}

function filenameFromUri(uri: string | undefined): string | undefined {
  if (!uri || uri.startsWith("data:")) return undefined
  if (URL.canParse(uri)) return path.basename(new URL(uri).pathname) || undefined
  return path.basename(uri) || undefined
}

export * as ACPContent from "./content"
