// OMP entrypoint. Host-specific: `@oh-my-pi` imports and the one-argument extension label.
import { SessionManager, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { registerSessionPicker } from "./src/picker.ts"

export default function sessionPicker(pi: ExtensionAPI): void {
  pi.setLabel("Session Picker")
  registerSessionPicker(pi, { listSessions: () => SessionManager.listAll() })
}
