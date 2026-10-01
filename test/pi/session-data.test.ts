// Pi host suite (Node) mirroring test/session-data.test.ts and the discovery/search cases
// of test/fzf-picker.test.ts. Runs the shared src/ under Node's ESM loader, as Pi's jiti does.
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, test } from "node:test"
import { compactField, listPickerSessions, previewText, readLastUserMessage } from "../../src/session-data.ts"
import { pickSessionReference } from "../../src/fzf-picker.ts"
import { assignment, fixtureEnv, hasCommand, requireFzfInCI } from "../fixtures/picker-harness.ts"

requireFzfInCI()
const withFzf = { skip: hasCommand("fzf") ? false : "fzf not on PATH" }
const cleanups: string[] = []
const savedEnv = { ...process.env }
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function sessionFile(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "session-picker-pi-test-"))
  cleanups.push(directory)
  const path = join(directory, "session.jsonl")
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  return path
}

describe("readLastUserMessage", () => {
  test("returns the newest user-authored text across small read chunks", async () => {
    const path = await sessionFile([
      { type: "session", id: "session" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "first prompt" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "latest prompt" }, { type: "image", data: "x" }, { type: "text", text: "second block" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "latest reply" }] } },
    ])
    assert.equal(await readLastUserMessage(path, 23), "latest prompt\nsecond block")
  })

  test("returns undefined when no user message exists", async () => {
    const path = await sessionFile([{ type: "session", id: "s" }, { type: "message", message: { role: "assistant", content: "reply" } }])
    assert.equal(await readLastUserMessage(path, 16), undefined)
  })

  test("reports a user message that has no text blocks", async () => {
    const path = await sessionFile([{ type: "message", message: { role: "user", content: [{ type: "image", data: "image" }] } }])
    assert.equal(await readLastUserMessage(path, 17), "User message contains no text.")
  })

  test("skips malformed lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-picker-pi-test-"))
    cleanups.push(directory)
    const path = join(directory, "session.jsonl")
    await writeFile(path, '{"type":"message","message":{"role":"user","content":"ok"}}\n{"type":"message","message":{"role":"user"\n')
    assert.equal(await readLastUserMessage(path, 8), "ok")
  })
})

test("sanitizes list and preview fields without flattening preview paragraphs", () => {
  assert.equal(compactField("a\tb\n\nc"), "a b c")
  assert.equal(previewText("a\r\nb\tc\u0007"), "a\nb    c")
})

describe("agent-id discovery under Node", () => {
  test("includes active agents without persisted sessions", async () => {
    const fixture = await fixtureEnv(undefined, [{
      session_id: "live",
      name: "Live Agent of Lighthouse",
      slug: "live-agent-lighthouse",
      cwd: "/project",
      state: { value: "working" },
      updated_at: "2025-01-02T00:00:00Z",
      runtime: { provider: "herdr", state: "working", locations: [{ workspace_label: "workspace", tab_label: "tab", cwd: "/project" }] },
    }])
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const rows = await listPickerSessions("current", [
      { id: "target", cwd: "/project", title: "Session title", firstMessage: "First prompt", path: "/missing/session.jsonl", modified: new Date("2025-01-01T00:00:00Z") },
    ])
    assert.equal(rows.length, 2)
    const live = rows.find((row) => row.id === "live")!
    assert.equal(live.name, "Live Agent of Lighthouse")
    assert.equal(live.active, true)
    assert.equal(live.persisted, false)
    assert.equal(live.status, "working")
    assert.deepEqual(live.herdrLocations, [{ workspace: "workspace", tab: "tab" }])
    assert.equal(live.lastUserMessage, undefined)
  })

  test("agent-id failure or absence degrades to title/path search", async () => {
    const fixture = await fixtureEnv(undefined, [])
    cleanups.push(fixture.directory)
    await writeFile(join(fixture.directory, "agent-id"), "#!/bin/sh\nexit 3\n", { mode: 0o755 })
    Object.assign(process.env, fixture.env)
    const rows = await listPickerSessions("current", [
      { id: "target", cwd: "/project", firstMessage: "First", path: fixture.sessionPath, modified: new Date(0) },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.active, undefined)
    assert.equal(rows[0]!.lastUserMessage, "Context")
  })
})

describe("fzf search under Node", () => {
  async function search(
    query: string,
    locations: unknown,
    slug: string | null = "oak-smoke",
    allLocations: unknown = locations,
  ): Promise<string | undefined> {
    const fixture = await fixtureEnv(query, assignment("target", slug, locations), assignment("target", slug, allLocations))
    cleanups.push(fixture.directory)
    Object.assign(process.env, fixture.env)
    const sessions = await listPickerSessions("current", [
      { id: "target", cwd: "/project", title: "Session title", firstMessage: "First prompt", path: fixture.sessionPath, modified: new Date(0) },
    ])
    let stops = 0
    let starts = 0
    const selected = await pickSessionReference({ stop: () => stops++, start: () => starts++ }, sessions)
    assert.equal(stops, 1)
    assert.equal(starts, 1)
    return selected
  }

  test("searches secondary workspace/tab names and the slug", withFzf, async () => {
    const locations = [{ workspace_label: "Commerce", tab_label: "Checkout" }, { workspace_label: "Finance", tab_label: "VAT" }]
    assert.equal(await search("Finance VAT", locations), "oak-smoke")
    assert.equal(await search("oak-smoke", locations), "oak-smoke")
  })

  test("searches workspace-only and tab-only locations", withFzf, async () => {
    assert.equal(await search("Returns", [{ workspace_label: " Returns ", tab_label: null }]), "oak-smoke")
    assert.equal(await search("Inventory", [{ workspace_label: " \t", tab_label: " Inventory " }]), "oak-smoke")
  })

  test("ignores blank active labels when all-session metadata has usable names", withFzf, async () => {
    const active = [{ workspace_label: " \t", tab_label: "\n " }]
    const all = [{ workspace_label: "Commerce", tab_label: "Checkout" }]
    assert.equal(await search("Commerce Checkout", active, "oak-smoke", all), "oak-smoke")
  })

  test("keeps slug and title search when location metadata is missing", withFzf, async () => {
    assert.equal(await search("Session title", []), "oak-smoke")
  })

  test("returns the session ID when no usable slug is available", withFzf, async () => {
    assert.equal(await search("target", [], null), "target")
    assert.equal(await search("Session title", [], " \t "), "target")
  })

  test("no match yields undefined (cancel semantics)", withFzf, async () => {
    assert.equal(await search("zzz-nothing", []), undefined)
  })
})
