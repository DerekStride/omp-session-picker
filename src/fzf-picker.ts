import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TUI } from "@oh-my-pi/pi-tui"
import { compactField, displayPath, formatModified, previewText, type PickerSession } from "./session-data"

const FIELD_SEPARATOR = "\t"
const ACTIVE_PROMPT = "Active sessions › "
const ALL_PROMPT = "All sessions › "
const ACTIVE_HEADER = "Enter: select · Ctrl+A: show all · Esc: cancel"
const ALL_HEADER = "Enter: select · Ctrl+A: show active · Esc: cancel"

interface FzfRow {
  line: string
  preview: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function fzfRow(session: PickerSession, index: number): FzfRow {
  const title = compactField(session.title)
  const slug = session.slug ? compactField(session.slug) : undefined
  const cwd = compactField(displayPath(session.cwd))
  const lastUserMessage = previewText(session.lastUserMessage?.trim() || "No user message found.")
  const description = `${formatModified(session.modified)}  ${slug ? `${slug}  ` : ""}${title}  ${cwd}`

  return {
    line: [session.id, description, String(index)].join(FIELD_SEPARATOR),
    preview: [
      title,
      `Session:  ${session.id}`,
      ...(slug ? [`Agent:    ${slug}`] : []),
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
  const activePath = join(directory, "active.tsv")
  const hasActivity = sessions.some((session) => session.active !== undefined)

  try {
    const rows = sessions.map(fzfRow)
    const activeRows = rows.filter((_row, index) => sessions[index].active)
    const activeHeader = activeRows.length > 0 ? ACTIVE_HEADER : "No active sessions · Ctrl+A: show all · Esc: cancel"
    await Promise.all([
      writeFile(inputPath, rows.map((row) => row.line).join("\n")),
      writeFile(activePath, activeRows.map((row) => row.line).join("\n")),
      ...rows.map((row, index) => writeFile(join(directory, `${index}.txt`), row.preview)),
    ])

    const showAll = `change-prompt(${ALL_PROMPT})+change-header(${ALL_HEADER})+reload:cat ${shellQuote(inputPath)}`
    const showActive = `change-prompt(${ACTIVE_PROMPT})+change-header(${activeHeader})+reload:cat ${shellQuote(activePath)}`
    const toggleView = `if [ "$FZF_PROMPT" = ${shellQuote(ACTIVE_PROMPT)} ]; then printf '%s\\n' ${shellQuote(showAll)}; else printf '%s\\n' ${shellQuote(showActive)}; fi`

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
          `--prompt=${hasActivity ? ACTIVE_PROMPT : ALL_PROMPT}`,
          `--header=${hasActivity ? activeHeader : "Enter: select · Esc: cancel"}`,
          ...(hasActivity ? ["--bind", `ctrl-a:transform:${toggleView}`] : []),
          "--with-shell=sh -c",
          "--scheme=history",
          "--delimiter",
          FIELD_SEPARATOR,
          "--with-nth=2",
          "--nth=1,2",
          "--accept-nth=1",
          "--preview",
          `cat ${shellQuote(directory)}/{3}.txt`,
          "--preview-label=Last user message",
          "--preview-window=right,60%,wrap,border-left,<100(down,50%,border-top)",
        ],
        {
          stdin: Bun.file(hasActivity ? activePath : inputPath),
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
