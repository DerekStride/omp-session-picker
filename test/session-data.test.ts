import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { compactField, previewText, readLastUserMessage } from "../src/session-data"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function sessionFile(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-picker-test-"))
  temporaryDirectories.push(directory)
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
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "latest prompt" },
            { type: "image", data: "ignored" },
            { type: "text", text: "second block" },
          ],
        },
      },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "latest reply" }] } },
    ])

    expect(await readLastUserMessage(path, 23)).toBe("latest prompt\nsecond block")
  })

  test("returns undefined when no user message exists", async () => {
    const path = await sessionFile([
      { type: "session", id: "session" },
      { type: "message", message: { role: "assistant", content: "reply" } },
    ])

    expect(await readLastUserMessage(path, 16)).toBeUndefined()
  })

  test("reports a user message that has no text blocks", async () => {
    const path = await sessionFile([
      { type: "session", id: "session" },
      { type: "message", message: { role: "user", content: [{ type: "image", data: "image" }] } },
    ])

    expect(await readLastUserMessage(path, 17)).toBe("User message contains no text.")
  })

  test("skips malformed lines", async () => {
    const path = await sessionFile([
      { type: "session", id: "session" },
      { type: "message", message: { role: "user", content: "kept" } },
    ])
    await writeFile(path, `${await Bun.file(path).text()}{"type":"message","message":{"role":"user"\n`)

    expect(await readLastUserMessage(path, 11)).toBe("kept")
  })
})

test("sanitizes list and preview fields without flattening preview paragraphs", () => {
  expect(compactField("title\twith\ncontrols\u0000")).toBe("title with controls")
  expect(previewText("first\r\nsecond\tcolumn\u0000")).toBe("first\nsecond    column")
})
