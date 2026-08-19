import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TUI } from "@oh-my-pi/pi-tui"
import { compactField, displayPath, formatModified, previewText, type PickerSession } from "./session-data"

const FIELD_SEPARATOR = "\t"

interface FzfRow {
  line: string
  preview: string
}

function fzfRow(session: PickerSession): FzfRow {
  const title = compactField(session.title)
  const cwd = compactField(displayPath(session.cwd))
  const lastUserMessage = previewText(session.lastUserMessage?.trim() || "No user message found.")
  const description = `${formatModified(session.modified)}  ${title}  ${cwd}`

  return {
    line: [session.id, description].join(FIELD_SEPARATOR),
    preview: [
      title,
      `Session:  ${session.id}`,
      `Project:  ${displayPath(session.cwd)}`,
      `Modified: ${formatModified(session.modified)}`,
      "",
      "Last user message",
      "─────────────────",
      lastUserMessage,
      "",
    ].join("\n"),
  }
}

export async function pickSessionId(tui: TUI, sessions: PickerSession[]): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "omp-session-picker-"))
  const inputPath = join(directory, "sessions.tsv")

  try {
    const rows = sessions.map(fzfRow)
    await Promise.all([
      writeFile(inputPath, `${rows.map((row) => row.line).join("\n")}\n`),
      ...rows.map((row, index) => writeFile(join(directory, `${index}.txt`), row.preview)),
    ])

    tui.stop()
    let code: number
    let stdout: string

    try {
      const process = Bun.spawn(
        [
          "fzf",
          "--no-multi",
          "--height=80%",
          "--min-height=20",
          "--layout=reverse",
          "--border=rounded",
          "--prompt=Session › ",
          "--header=Enter: select · Esc: cancel",
          "--scheme=history",
          "--delimiter",
          FIELD_SEPARATOR,
          "--with-nth=2",
          "--nth=1,2",
          "--accept-nth=1",
          "--preview",
          `cat ${join(directory, "{n}.txt")}`,
          "--preview-label=Last user message",
          "--preview-window=right,60%,wrap,border-left,<100(down,50%,border-top)",
        ],
        {
          stdin: Bun.file(inputPath),
          stdout: "pipe",
          stderr: "inherit",
        },
      )
      const output = new Response(process.stdout).text()
      code = await process.exited
      stdout = await output
    } finally {
      tui.start()
    }

    if (code === 130 || code === 1) return undefined
    if (code !== 0) throw new Error(`fzf exited with code ${code}`)
    return stdout.trim() || undefined
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
