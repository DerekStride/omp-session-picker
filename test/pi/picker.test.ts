// Pi host suite (Node). Mirror every shared-behavior assertion in test/picker.test.ts.
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { register } from "node:module"
import { afterEach, describe, test } from "node:test"
import { appendPrompt, registerSessionPicker, type PickerHost } from "../../src/picker.ts"
import { listPickerSessions } from "../../src/session-data.ts"
import { assignment, fakeContext, fakeExtensionAPI, fixtureEnv, hasCommand, requireFzfInCI } from "../fixtures/picker-harness.ts"

requireFzfInCI()
const withFzf = { skip: hasCommand("fzf") ? false : "fzf not on PATH" }
const cleanups: string[] = []
const savedEnv = { ...process.env }
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

function hostWith(sessions: Awaited<ReturnType<PickerHost["listSessions"]>>): PickerHost {
  return { listSessions: async () => sessions }
}

// Pi supplies @earendil-works/pi-coding-agent at load time; stub it for the unit run only.
register("./host-stub-hooks.mjs", import.meta.url)
const { default: sessionPicker } = await import("../../index.pi.ts")
const host = (await import("@earendil-works/pi-coding-agent")) as unknown as { SessionManager: { calls: number } }

describe("Pi entrypoint", () => {
  test("registers the command and shortcut and never calls Pi's entry-label setLabel", async () => {
    const labels: unknown[][] = []
    const api = Object.assign(fakeExtensionAPI(), {
      setLabel: (...args: unknown[]) => {
        labels.push(args)
        throw new Error(`Entry ${String(args[0])} not found`)
      },
    })
    sessionPicker(api as never)
    assert.deepEqual(labels, [])
    assert.deepEqual([...api.commands.keys()], ["session-context"])
    assert.deepEqual([...api.shortcuts.keys()], ["alt+s"])

    // The entry wires SessionManager.listAll() from the Pi host package.
    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const before = host.SessionManager.calls
    await api.commands.get("session-context")!("", fakeContext())
    assert.equal(host.SessionManager.calls, before + 1)
  })

  test("Pi module resolution: entrypoint imports the @earendil-works host package", async () => {
    const { readFile } = await import("node:fs/promises")
    const source = await readFile(new URL("../../index.pi.ts", import.meta.url), "utf8")
    assert.match(source, /from "@earendil-works\/pi-coding-agent"/)
    assert.doesNotMatch(source, /@oh-my-pi/)
  })
})

describe("registerSessionPicker", () => {
  test("refuses without UI and does not query sessions", async () => {
    let listed = 0
    const api = fakeExtensionAPI()
    registerSessionPicker(api, { listSessions: async () => (listed++, []) })
    const ctx = fakeContext({ hasUI: false })
    await api.commands.get("session-context")!("", ctx)
    assert.equal(listed, 0)
    assert.deepEqual(ctx.notifications, [{ message: "/session-context requires an interactive terminal session", type: "warning" }])
  })

  test("refuses in RPC mode but runs when mode is absent", async () => {
    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([]))
    const rpc = fakeContext({ mode: "rpc" })
    await api.commands.get("session-context")!("", rpc)
    assert.equal(rpc.notifications[0]?.type, "warning")

    const noMode = fakeContext()
    await api.commands.get("session-context")!("", noMode)
    assert.deepEqual(noMode.notifications, [{ message: "No other sessions found", type: "warning" }])
  })

  test("reports listing failures and excludes the current session", async () => {
    const api = fakeExtensionAPI()
    registerSessionPicker(api, { listSessions: async () => { throw new Error("disk gone") } })
    const failing = fakeContext()
    await api.commands.get("session-context")!("", failing)
    assert.deepEqual(failing.notifications, [{ message: "Could not list sessions: disk gone", type: "error" }])

    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const onlyCurrent = fakeExtensionAPI()
    registerSessionPicker(onlyCurrent, hostWith([
      { id: "current", path: "/none", cwd: "/p", modified: new Date(0), firstMessage: "x" },
    ]))
    const ctx = fakeContext({ sessionId: "current" })
    await onlyCurrent.commands.get("session-context")!("", ctx)
    assert.deepEqual(ctx.notifications, [{ message: "No other sessions found", type: "warning" }])
    assert.equal(ctx.customCalls, 0)
  })

  test("appendPrompt preserves the draft and separates with a blank line", () => {
    assert.equal(appendPrompt("", "abc"), "Read the context from session abc")
    assert.equal(appendPrompt("  draft \n", "abc"), "draft\n\nRead the context from session abc")
  })

  test("selects a session, appends the prompt, and restores the terminal", withFzf, async () => {
    const fixture = await fixtureEnv("target", assignment("target", "oak-smoke", []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First", title: "T" },
    ]))
    const ctx = fakeContext({ editor: "existing draft" })
    await api.commands.get("session-context")!("", ctx)
    assert.equal(ctx.editorText, "existing draft\n\nRead the context from session oak-smoke")
    assert.equal(ctx.tuiStops, 1)
    assert.equal(ctx.tuiStarts, 1)
    assert.deepEqual(ctx.renders, [true])
    assert.deepEqual(ctx.notifications, [{ message: "Selected session oak-smoke", type: "info" }])
  })

  test("shortcut pastes the selection at the cursor instead of rewriting the draft", withFzf, async () => {
    const fixture = await fixtureEnv("target", assignment("target", null, []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First" },
    ]))
    const ctx = fakeContext({ editor: "keep me" })
    await api.shortcuts.get("alt+s")!(ctx)
    assert.deepEqual(ctx.pasted, ["target"])
    assert.equal(ctx.editorText, "keep me")
    // Overlay mode keeps Pi from calling editor.setText(savedText), which would move the cursor to the end.
    assert.deepEqual(ctx.customOptions, [{ overlay: true }])
  })

  test("cancel (no match → fzf exit 1) leaves the editor untouched and restarts the TUI", withFzf, async () => {
    const fixture = await fixtureEnv("no-such-session", assignment("target", null, []))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const api = fakeExtensionAPI()
    registerSessionPicker(api, hostWith([
      { id: "target", path: fixture.sessionPath, cwd: "/project", modified: new Date(0), firstMessage: "First" },
    ]))
    const ctx = fakeContext({ editor: "untouched" })
    await api.commands.get("session-context")!("", ctx)
    assert.equal(ctx.editorText, "untouched")
    assert.deepEqual(ctx.notifications, [])
    assert.equal(ctx.tuiStarts, 1)
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
    assert.equal(ctx.editorText, "untouched")
    assert.equal(ctx.tuiStarts, 1)
    assert.deepEqual(ctx.renders, [true])
    assert.equal(ctx.notifications.length, 1)
    assert.equal(ctx.notifications[0]!.type, "error")
    assert.match(ctx.notifications[0]!.message, /^Session picker failed: /)
  })

  test("prefers Pi session names over OMP titles and falls back to the first message", async () => {
    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    Object.assign(process.env, { ...fixture.env, PATH: fixture.directory })
    const rows = await listPickerSessions("current", [
      { id: "a", path: "/missing", cwd: "/p", modified: new Date(1), firstMessage: "first", name: "Named", title: "Titled" },
      { id: "b", path: "/missing", cwd: "/p", modified: new Date(2), firstMessage: "first", title: "Titled" },
      { id: "c", path: "/missing", cwd: "/p", modified: new Date(3), firstMessage: "(no messages)" },
    ])
    assert.deepEqual(rows.map((row) => [row.id, row.title]), [["c", "Untitled"], ["b", "Titled"], ["a", "Named"]])
  })
})
