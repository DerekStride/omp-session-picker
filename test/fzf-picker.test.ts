import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, expect, test } from "bun:test"

const temporaryDirectories: string[] = []
const testWithFzf = test.skipIf(!Bun.which("fzf"))
const sessionDataUrl = new URL("../src/session-data.ts", import.meta.url).href
const pickerUrl = new URL("../src/fzf-picker.ts", import.meta.url).href

const searchScript = `
import { listPickerSessions } from ${JSON.stringify(sessionDataUrl)}
import { pickSessionReference } from ${JSON.stringify(pickerUrl)}
const sessions = await listPickerSessions("current", [{
  id: "target", cwd: "/project", title: "Session title", firstMessage: "First prompt",
  path: process.env.PICKER_TEST_DIRECTORY + "/session.jsonl", modified: new Date(0)
}])
const selected = await pickSessionReference({ stop() {}, start() {} }, sessions)
process.stdout.write(JSON.stringify(selected ?? null))
`

const discoveryScript = `#!/bin/sh
case "$*" in
  *--all*) printf '%s\\n' "$PICKER_ALL_AGENTS" ;;
  *) printf '%s\\n' "$PICKER_ACTIVE_AGENTS" ;;
esac
`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function searchSession(
  query: string,
  activeLocations: unknown,
  { allLocations = activeLocations, slug = "oak-smoke" }: { allLocations?: unknown; slug?: string | null } = {},
): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), "omp-picker-search-test-"))
  temporaryDirectories.push(directory)
  await Promise.all([
    writeFile(join(directory, "agent-id"), discoveryScript, { mode: 0o755 }),
    writeFile(join(directory, "session.jsonl"), '{"type":"message","message":{"role":"user","content":"Context"}}\n'),
  ])
  const assignment = (locations: unknown) => JSON.stringify([{
    session_id: "target",
    slug,
    runtime: { provider: "herdr", locations },
  }])
  const process = Bun.spawn([globalThis.process.execPath, "-e", searchScript], {
    env: {
      ...globalThis.process.env,
      PATH: [directory, globalThis.process.env.PATH].join(delimiter),
      PICKER_TEST_DIRECTORY: directory,
      PICKER_ACTIVE_AGENTS: assignment(activeLocations),
      PICKER_ALL_AGENTS: assignment(allLocations),
      FZF_DEFAULT_OPTS: `--filter=${JSON.stringify(query)}`,
      FZF_DEFAULT_OPTS_FILE: "/dev/null",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(stderr || `Search process exited with code ${code}`)
  return JSON.parse(stdout)
}

testWithFzf("searches secondary workspace/tab names and the slug", async () => {
  const locations = [
    { workspace_label: "Commerce", tab_label: "Checkout" },
    { workspace_label: "Finance", tab_label: "VAT" },
  ]
  expect(await searchSession("Finance VAT", locations)).toBe("oak-smoke")
  expect(await searchSession("oak-smoke", locations)).toBe("oak-smoke")
})

testWithFzf("searches workspace-only and tab-only locations", async () => {
  expect(await searchSession("Returns", [{ workspace_label: " Returns ", tab_label: null }])).toBe("oak-smoke")
  expect(await searchSession("Inventory", [{ workspace_label: " \t", tab_label: " Inventory " }])).toBe("oak-smoke")
})

testWithFzf("ignores blank active labels when all-session metadata has usable names", async () => {
  const activeLocations = [{ workspace_label: " \t", tab_label: "\n " }]
  const allLocations = [{ workspace_label: "Commerce", tab_label: "Checkout" }]
  expect(await searchSession("Commerce Checkout", activeLocations, { allLocations })).toBe("oak-smoke")
})

testWithFzf("keeps slug and title search when location metadata is missing", async () => {
  expect(await searchSession("oak-smoke", undefined)).toBe("oak-smoke")
  expect(await searchSession("Session title", undefined)).toBe("oak-smoke")
})

testWithFzf("returns the session ID when no usable slug is available", async () => {
  expect(await searchSession("Session title", undefined, { slug: null })).toBe("target")
  expect(await searchSession("Session title", undefined, { slug: " \t " })).toBe("target")
})
