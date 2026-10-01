// Runtime-neutral fixtures shared by the OMP (bun:test) and Pi (node:test) suites.
// Uses only node: APIs so both runtimes execute the same code paths.
import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { PickerContext, PickerExtensionAPI } from "../../src/picker.ts"

export const DISCOVERY_SCRIPT = `#!/bin/sh
case "$*" in
  *--all*) printf '%s\\n' "$PICKER_ALL_AGENTS" ;;
  *) printf '%s\\n' "$PICKER_ACTIVE_AGENTS" ;;
esac
`

export const SESSION_LINE = '{"type":"message","message":{"role":"user","content":"Context"}}\n'

export interface Registered {
  commands: Map<string, (args: string, ctx: PickerContext) => Promise<void>>
  shortcuts: Map<string, (ctx: PickerContext) => Promise<void> | void>
}

export function fakeExtensionAPI(): PickerExtensionAPI & Registered {
  const commands: Registered["commands"] = new Map()
  const shortcuts: Registered["shortcuts"] = new Map()
  return {
    commands,
    shortcuts,
    registerCommand(name, options) {
      commands.set(name, options.handler)
    },
    registerShortcut(shortcut, options) {
      shortcuts.set(shortcut, options.handler)
    },
  }
}

export interface FakeContextOptions {
  hasUI?: boolean
  mode?: string
  sessionId?: string
  editor?: string
  /** Result the custom component would resolve with; defaults to running the factory. */
  runCustom?: boolean
}

export interface FakeContext extends PickerContext {
  notifications: { message: string; type: string | undefined }[]
  editorText: string
  pasted: string[]
  tuiStops: number
  tuiStarts: number
  /** Arguments of each tui.requestRender call made after the terminal is restored. */
  renders: (boolean | undefined)[]
  customCalls: number
  customOptions: ({ overlay?: boolean } | undefined)[]
}

export function fakeContext(options: FakeContextOptions = {}): FakeContext {
  const ctx: FakeContext = {
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionId: () => options.sessionId ?? "current" },
    notifications: [],
    editorText: options.editor ?? "",
    pasted: [],
    tuiStops: 0,
    tuiStarts: 0,
    renders: [],
    customCalls: 0,
    customOptions: [],
    ui: {
      notify(message, type) {
        ctx.notifications.push({ message, type })
      },
      async custom(factory, options) {
        ctx.customCalls += 1
        ctx.customOptions.push(options)
        return new Promise((resolve) => {
          const tui = {
            stop: () => {
              ctx.tuiStops += 1
            },
            start: () => {
              ctx.tuiStarts += 1
            },
            requestRender: (force?: boolean) => {
              ctx.renders.push(force)
            },
          }
          void factory(tui, undefined, undefined, resolve)
        })
      },
      pasteToEditor(text) {
        ctx.pasted.push(text)
      },
      getEditorText: () => ctx.editorText,
      setEditorText(text) {
        ctx.editorText = text
      },
    },
  }
  if (options.mode !== undefined) ctx.mode = options.mode
  return ctx
}

export interface FixtureEnv {
  directory: string
  sessionPath: string
  env: NodeJS.ProcessEnv
}

/**
 * Create a temp directory with a fake `agent-id` on PATH, a one-line session file, and an
 * environment that forces fzf into non-interactive `--filter` mode with the given query.
 */
export async function fixtureEnv(
  query: string | undefined,
  activeAgents: unknown,
  allAgents: unknown = activeAgents,
): Promise<FixtureEnv> {
  const directory = await mkdtemp(join(tmpdir(), "session-picker-fixture-"))
  const sessionPath = join(directory, "session.jsonl")
  await Promise.all([
    writeFile(join(directory, "agent-id"), DISCOVERY_SCRIPT, { mode: 0o755 }),
    writeFile(sessionPath, SESSION_LINE),
  ])
  // PATH holds only the fixture dir plus fzf's real dir, so the host machine's agent-id
  // and live sessions can never leak into a test.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [directory, ...(fzfDir() ? [fzfDir()!] : [])].join(delimiter),
    PICKER_ACTIVE_AGENTS: JSON.stringify(activeAgents),
    PICKER_ALL_AGENTS: JSON.stringify(allAgents),
    FZF_DEFAULT_OPTS_FILE: "/dev/null",
  }
  if (query !== undefined) env.FZF_DEFAULT_OPTS = `--filter=${JSON.stringify(query)}`
  return { directory, sessionPath, env }
}

export function assignment(sessionId: string, slug: string | null, locations: unknown): unknown[] {
  return [{ session_id: sessionId, slug, runtime: { provider: "herdr", locations } }]
}

/** Run a script under the given executable (node or bun) and return parsed JSON stdout. */
export function runScript(execPath: string, script: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, ["-e", script], { env, stdio: ["ignore", "pipe", "pipe"] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString()
      if (code !== 0) return reject(new Error(stderr || `script exited with ${code}`))
      try {
        resolve(JSON.parse(Buffer.concat(out).toString()))
      } catch (error) {
        reject(new Error(`bad JSON from script: ${Buffer.concat(out).toString()}\n${stderr}`))
      }
    })
  })
}

export function fzfDir(): string | undefined {
  return (process.env.PATH ?? "").split(delimiter).find((dir) => {
    try {
      return statSync(join(dir, "fzf")).isFile()
    } catch {
      return false
    }
  })
}

/** In CI, fzf-dependent tests must run: a missing fzf is a setup failure, not a skip. */
export function requireFzfInCI(): void {
  if (process.env.CI && !hasCommand("fzf")) throw new Error("fzf is required on PATH in CI")
}

export function hasCommand(name: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => {
      try {
        return statSync(join(dir, name)).isFile()
      } catch {
        return false
      }
    })
}
