// Structural declaration of the Pi host surface used by index.pi.ts. Pi supplies the real
// module at load time; this keeps typechecking portable without bundling a host runtime copy.
declare module "@earendil-works/pi-coding-agent" {
  import type { PickerExtensionAPI } from "../src/picker.ts"
  import type { SessionInfoLike } from "../src/session-data.ts"

  export type ExtensionAPI = PickerExtensionAPI
  export const SessionManager: { listAll(): Promise<SessionInfoLike[]> }
}
