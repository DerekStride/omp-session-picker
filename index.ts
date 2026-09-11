import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import type { Component } from "@oh-my-pi/pi-tui"
import { pickSessionReference } from "./src/fzf-picker"
import { listPickerSessions } from "./src/session-data"

const CONTEXT_PROMPT = "Read the context from session"

export default function sessionPicker(pi: ExtensionAPI): void {
  pi.setLabel("Session Picker")

  const openPicker = async (ctx: ExtensionContext, insertAtCursor = false): Promise<void> => {
    if (!ctx.hasUI) {
      ctx.ui.notify("/session-context requires an interactive OMP session", "warning")
      return
    }

    let sessions
    try {
      sessions = await listPickerSessions(ctx.sessionManager.getSessionId(), await SessionManager.listAll())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.ui.notify(`Could not list OMP sessions: ${message}`, "error")
      return
    }

    if (sessions.length === 0) {
      ctx.ui.notify("No other persisted OMP sessions found", "warning")
      return
    }

    const selected = await ctx.ui.custom<string | undefined>(async (tui, _theme, _keybindings, done) => {
      let selectedSession: string | undefined
      try {
        selectedSession = await pickSessionReference(tui, sessions)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`Session picker failed: ${message}`, "error")
      }
      done(selectedSession)
      return { render: () => [] } satisfies Component
    })

    if (!selected) return

    if (insertAtCursor) {
      ctx.ui.pasteToEditor(selected)
    } else {
      const prompt = `${CONTEXT_PROMPT} ${selected}`
      const draft = ctx.ui.getEditorText().trim()
      ctx.ui.setEditorText(draft ? `${draft}\n\n${prompt}` : prompt)
    }
    ctx.ui.notify(`Selected session ${selected}`, "info")
  }

  pi.registerCommand("session-context", {
    description: "Pick an OMP session and prepare a prompt to read its context",
    handler: (_args, ctx) => openPicker(ctx),
  })
  pi.registerShortcut("alt+s", {
    description: "Insert an OMP session slug or ID at the cursor",
    handler: (ctx) => openPicker(ctx, true),
  })
}
