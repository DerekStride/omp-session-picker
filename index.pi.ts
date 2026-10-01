// Pi entrypoint. Host-specific: `@earendil-works` imports. Pi's `setLabel(entryId, label)`
// labels transcript entries and throws for unknown ids, so no extension label is set here.
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSessionPicker } from "./src/picker.ts"

export default function sessionPicker(pi: ExtensionAPI): void {
  registerSessionPicker(pi, { listSessions: () => SessionManager.listAll() })
}
