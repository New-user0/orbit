import { Mime } from "@orbit/core/mime"

// A child process for tests that must run under a deadline. With a file and a media type it prints one line of JSON with
// the size the header declares (null when it declares none). With a file and `batch` the file holds a JSON list of
// `{ base64, mime }` cases and the line is the list of answers in the same order.
const [file, mime] = process.argv.slice(2)
if (mime === "batch") {
  const cases: Array<{ base64: string; mime: string }> = await Bun.file(file).json()
  console.log(JSON.stringify(cases.map((item) => Mime.dimensions(Buffer.from(item.base64, "base64"), item.mime) ?? null)))
} else console.log(JSON.stringify(Mime.dimensions(new Uint8Array(await Bun.file(file).arrayBuffer()), mime) ?? null))
