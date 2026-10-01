// OMP host suite (Bun). Mirror every shared-behavior assertion in test/pi/picker.test.ts.
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import sessionPicker from "../index.ts"
import { appendPrompt, registerSessionPicker, type PickerHost } from "../src/picker.ts"
import { assignment, fakeContext, fakeExtensionAPI, fixtureEnv, hasCommand, requireFzfInCI } from "./fixtures/picker-harness.ts"

requireFzfInCI()
const testWithFzf = test.skipIf(!hasCommand("fzf"))
const cleanups: string[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const savedEnv = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

function hostWith(sessions: Awaited<ReturnType<PickerHost["listSessions"]>>): PickerHost {
  return { listSessions: async () => sessions }
}

describe("OMP entrypoint", () => {
  test("sets the extension label and registers the command and shortcut", () => {
    const labels: unknown[][] = []
    const api = Object.assign(fakeExtensionAPI(), { setLabel: (...args: unknown[]) => labels.push(args) })
    sessionPicker(api as never)
    expect(labels).toEqual([["Session Picker"]])
    expect([...api.commands.keys()]).toEqual(["session-context"])
    expect([...api.shortcuts.keys()]).toEqual(["alt+s"])
  })
})

describe("registerSessionPicker", () => {
  test("refuses without UI and does not query sessions", async () => {
    let listed = 0
    const api = fakeExtensionAPI()
    registerSessionPicker(api, { listSessions: async () => (listed++, []) })
    const ctx = fakeContext({ hasUI: false })
    await api.commands.get("session-context")!("", ctx)
    expect(listed).toBe(0)
    expect(ctx.notifications).toEqual([{ message: "/session-context requires an interactive terminal session", type: "warning" }])
  })

  test("refuses in RPC mode but runs when mode is absent", async () => {
    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([]))
    const rpc = fakeContext({ mode: "rpc" })
    await api.commands.get("session-context")!("", rpc)
    expect(rpc.notifications[0]?.type).toBe("warning")

    const noMode = fakeContext()
    await api.commands.get("session-context")!("", noMode)
    expect(noMode.notifications).toEqual([{ message: "No other sessions found", type: "warning" }])
  })

  test("reports listing failures and excludes the current session", async () => {
    const api = fakeExtensionAPI()
    registerSessionPicker(api, { listSessions: async () => { throw new Error("disk gone") } })
    const failing = fakeContext()
    await api.commands.get("session-context")!("", failing)
    expect(failing.notifications).toEqual([{ message: "Could not list sessions: disk gone", type: "error" }])

    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const onlyCurrent = fakeExtensionAPI()
    registerSessionPicker(onlyCurrent, hostWith([
      { id: "current", path: "/none", cwd: "/p", modified: new Date(0), firstMessage: "x" },
    ]))
    const ctx = fakeContext({ sessionId: "current" })
    await onlyCurrent.commands.get("session-context")!("", ctx)
    expect(ctx.notifications).toEqual([{ message: "No other sessions found", type: "warning" }])
    expect(ctx.customCalls).toBe(0)
  })

  test("appendPrompt preserves the draft and separates with a blank line", () => {
    expect(appendPrompt("", "abc")).toBe("Read the context from session abc")
    expect(appendPrompt("  draft \n", "abc")).toBe("draft\n\nRead the context from session abc")
  })

  testWithFzf("selects a session, appends the prompt, and restores the terminal", async () => {
    const fixture = await fixtureEnv("target", assignment("target", "oak-smoke", []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First", title: "T" },
    ]))
    const ctx = fakeContext({ editor: "existing draft" })
    await api.commands.get("session-context")!("", ctx)
    expect(ctx.editorText).toBe("existing draft\n\nRead the context from session oak-smoke")
    expect(ctx.tuiStops).toBe(1)
    expect(ctx.tuiStarts).toBe(1)
    expect(ctx.renders).toEqual([true])
    expect(ctx.notifications).toEqual([{ message: "Selected session oak-smoke", type: "info" }])
  })

  testWithFzf("shortcut pastes the selection at the cursor instead of rewriting the draft", async () => {
    const fixture = await fixtureEnv("target", assignment("target", null, []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First" },
    ]))
    const ctx = fakeContext({ editor: "keep me" })
    await api.shortcuts.get("alt+s")!(ctx)
    expect(ctx.pasted).toEqual(["target"])
    expect(ctx.editorText).toBe("keep me")
    // Overlay mode keeps the host from resetting the editor (and cursor) on close.
    expect(ctx.customOptions).toEqual([{ overlay: true }])
  })

  testWithFzf("cancel (no match → fzf exit 1) leaves the editor untouched and restarts the TUI", async () => {
    const fixture = await fixtureEnv("no-such-session", assignment("target", null, []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First" },
    ]))
    const ctx = fakeContext({ editor: "untouched" })
    await api.commands.get("session-context")!("", ctx)
    expect(ctx.editorText).toBe("untouched")
    expect(ctx.notifications).toEqual([])
    expect(ctx.tuiStarts).toBe(1)
  })

  test("missing fzf reports an error, restarts the TUI, and leaves the editor untouched", async () => {
    const fixture = await fixtureEnv(undefined, assignment("target", null, []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, { ...fixture.env, PATH: fixture.directory })
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First" },
    ]))
    const ctx = fakeContext({ editor: "untouched" })
    await api.commands.get("session-context")!("", ctx)
    expect(ctx.editorText).toBe("untouched")
    expect(ctx.tuiStarts).toBe(1)
    expect(ctx.renders).toEqual([true])
    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0]!.type).toBe("error")
    expect(ctx.notifications[0]!.message).toMatch(/^Session picker failed: /)
  })

  test("prefers Pi session names over OMP titles and falls back to the first message", async () => {
    const { listPickerSessions } = await import("../src/session-data.ts")
    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, { ...fixture.env, PATH: fixture.directory })
    const rows = await listPickerSessions("current", [
      { id: "a", path: "/missing", cwd: "/p", modified: new Date(1), firstMessage: "first", name: "Named", title: "Titled" },
      { id: "b", path: "/missing", cwd: "/p", modified: new Date(2), firstMessage: "first", title: "Titled" },
      { id: "c", path: "/missing", cwd: "/p", modified: new Date(3), firstMessage: "(no messages)" },
    ])
    expect(rows.map((row) => [row.id, row.title])).toEqual([["c", "Untitled"], ["b", "Titled"], ["a", "Named"]])
  })
})
