import { describe, expect, test } from "bun:test"
import { Message, ToolResultPart, Media } from "@orbit/ai"
import { Agent } from "@orbit/core/agent"
import { baseTranscript, boundImages, unsupportedParts } from "@orbit/core/session/model-request"
import { SessionSystemPrompt } from "@orbit/core/session/system-prompt"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", media: Media.base64("aGVsbG8=", "image/png"), filename: "logo.png" },
          { type: "media", media: Media.base64("JVBERg==", "application/pdf"), filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "Read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const messages = [
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "first.png" }),
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "second.png" }),
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "third.png" }),
    ]
    const result = boundImages(messages)

    expect(result[0]?.content[0]).toMatchObject({ type: "text" })
    expect(result[1]?.content[0]).toMatchObject({ type: "text" })
    expect(result[2]?.content[0]).toMatchObject({ type: "media", filename: "third.png" })
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "Read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})

describe("SessionModelRequest.baseTranscript", () => {
  const input = (system: string | undefined, tools: string[]) => ({
    agent: { ...Agent.Info.default(Agent.ID.make("a")), system },
    model: { model: { route: {}, provider: "test" }, ref: { providerID: "test", id: "model" } } as never,
    tools: { definitions: tools.map((name) => ({ name })) } as never,
    initial: "",
    messages: [],
  })

  test("renders the guidance of a custom prompt that has the placeholder, in guidance order", () => {
    const text = baseTranscript(input("Own.\n${ORBIT_TOOL_GUIDANCE}\nEnd.", ["Read", "Bash"])).system[0]?.text ?? ""
    expect(text).not.toContain("${ORBIT_TOOL_GUIDANCE}")
    expect(text.startsWith("Own.\n- Bash is for")).toBe(true)
    expect(text.indexOf("- Use Read")).toBeGreaterThan(text.indexOf("- Bash is for"))
    expect(text.endsWith("\nEnd.")).toBe(true)
  })

  test("keeps a custom prompt without the placeholder as written", () => {
    expect(baseTranscript(input("Own prompt.", ["Read"])).system[0]?.text).toBe("Own prompt.")
  })

  test("gives an agent without a prompt the main template, and an empty prompt counts as none", () => {
    const expected = SessionSystemPrompt.make(["Read"])
    expect(baseTranscript(input(undefined, ["Read"])).system[0]?.text).toBe(expected)
    expect(baseTranscript(input("", ["Read"])).system[0]?.text).toBe(expected)
  })
})
