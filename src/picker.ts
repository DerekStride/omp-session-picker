import { pickSessionReference } from "./fzf-picker.ts"
import { listPickerSessions, type SessionInfoLike } from "./session-data.ts"

const CONTEXT_PROMPT = "Read the context from session"

/**
 * Structural view of the host extension API used by the picker. Both OMP and Pi satisfy it;
 * host-specific runtime imports (SessionManager, extension labels) stay in the entrypoints.
 */
export interface PickerHost {
  /** List every persisted session the host knows about. */
  listSessions(): Promise<SessionInfoLike[]>
}

interface TuiHandle {
  stop(): void
  start(): void
  requestRender?(force?: boolean): void
}

interface PickerComponent {
  render(width: number): string[]
}

interface Notifier {
  notify(message: string, type?: "info" | "warning" | "error"): void
}

export interface PickerContext {
  hasUI: boolean
  /** Present on both hosts; a missing value must not disable the picker. */
  mode?: string
  sessionManager: { getSessionId(): string }
  ui: Notifier & {
    custom<T>(
      factory: (
        tui: TuiHandle,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => PickerComponent | Promise<PickerComponent>,
      options?: { overlay?: boolean },
    ): Promise<T>
    pasteToEditor(text: string): void
    getEditorText(): string
    setEditorText(text: string): void
  }
}

export interface PickerExtensionAPI {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: PickerContext) => Promise<void> },
  ): void
  registerShortcut(
    shortcut: string,
    options: { description: string; handler: (ctx: PickerContext) => Promise<void> | void },
  ): void
}

export function contextPrompt(selected: string): string {
  return `${CONTEXT_PROMPT} ${selected}`
}

export function appendPrompt(draft: string, selected: string): string {
  const trimmed = draft.trim()
  const prompt = contextPrompt(selected)
  return trimmed ? `${trimmed}\n\n${prompt}` : prompt
}

export function registerSessionPicker(pi: PickerExtensionAPI, host: PickerHost): void {
  const openPicker = async (ctx: PickerContext, insertAtCursor = false): Promise<void> => {
    // fzf takes over the terminal, so the picker needs the real TUI. RPC clients report
    // hasUI but cannot host custom components; a host without `mode` is treated as TUI.
    if (!ctx.hasUI || (ctx.mode !== undefined && ctx.mode !== "tui")) {
      ctx.ui.notify("/session-context requires an interactive terminal session", "warning")
      return
    }

    let sessions
    try {
      sessions = await listPickerSessions(ctx.sessionManager.getSessionId(), await host.listSessions())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.ui.notify(`Could not list sessions: ${message}`, "error")
      return
    }

    if (sessions.length === 0) {
      ctx.ui.notify("No other sessions found", "warning")
      return
    }

    // `done` fires before the factory returns, so no component is ever mounted. Overlay mode
    // matters on Pi: its non-overlay close path calls editor.setText(savedText), which moves
    // the cursor to the end before pasteToEditor runs; the overlay close path leaves the editor alone.
    const selected = await ctx.ui.custom<string | undefined>(
      async (tui, _theme, _keybindings, done) => {
        let selectedSession: string | undefined
        try {
          selectedSession = await pickSessionReference(tui, sessions)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`Session picker failed: ${message}`, "error")
        }
        done(selectedSession)
        return { render: () => [] }
      },
      { overlay: true },
    )

    if (!selected) return

    if (insertAtCursor) {
      ctx.ui.pasteToEditor(selected)
    } else {
      ctx.ui.setEditorText(appendPrompt(ctx.ui.getEditorText(), selected))
    }
    ctx.ui.notify(`Selected session ${selected}`, "info")
  }

  pi.registerCommand("session-context", {
    description: "Pick a session and prepare a prompt to read its context",
    handler: (_args, ctx) => openPicker(ctx),
  })
  pi.registerShortcut("alt+s", {
    description: "Insert a session slug or ID at the cursor",
    handler: (ctx) => openPicker(ctx, true),
  })
}
