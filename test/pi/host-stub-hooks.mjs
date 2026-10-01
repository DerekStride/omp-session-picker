// Node module hooks for the Pi unit suite: resolve the host-provided package that only Pi's
// extension loader supplies to a stub, so index.pi.ts can be imported and its wiring asserted.
const HOST = "@earendil-works/pi-coding-agent"
const STUB = `data:text/javascript,${encodeURIComponent(`
export const SessionManager = {
  calls: 0,
  async listAll() { SessionManager.calls += 1; return [] },
}
`)}`

export async function resolve(specifier, context, next) {
  if (specifier === HOST) return { url: STUB, shortCircuit: true }
  return next(specifier, context)
}
