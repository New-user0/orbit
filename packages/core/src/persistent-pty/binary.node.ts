export async function resolveBinary() {
  return process.env.ORBIT_PTY_BIN || "orbit-pty"
}
