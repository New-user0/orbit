import { Mime } from "@orbit/core/mime"

// A child process for tests that must run under a deadline. Arguments: a file, then its media type. It prints one line
// of JSON with the size the header declares (null when it declares none).
const [file, mime] = process.argv.slice(2)
console.log(JSON.stringify(Mime.dimensions(new Uint8Array(await Bun.file(file).arrayBuffer()), mime) ?? null))
