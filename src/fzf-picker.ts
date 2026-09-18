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
function statusMarker(status: string | undefined): string | undefined {
  if (!status) return undefined
  switch (status.toLowerCase()) {
    case "idle":
      return "\x1b[32m○\x1b[0m"
    case "working":
    case "waiting":
      return "\x1b[33m●\x1b[0m"
    case "blocked":
      return "\x1b[31m●\x1b[0m"
    case "done":
      return "\x1b[34m●\x1b[0m"
    default:
      return "\x1b[90m●\x1b[0m"
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function fzfRow(session: PickerSession, index: number): FzfRow {
  const title = compactField(session.title)
  const slug = session.slug ? compactField(session.slug) : undefined
  const identity = compactField(session.name?.trim() || session.id)
  const herdrLabels: string[] = []
  const herdrPreview: string[] = []
  for (const location of session.herdrLocations ?? []) {
    const workspace = compactField(location.workspace ?? "")
    const tab = compactField(location.tab ?? "")
    if (!workspace && !tab) continue
    herdrLabels.push(workspace && tab ? `${workspace} / ${tab}` : workspace || tab)
    if (workspace) herdrPreview.push(`Workspace: ${workspace}`)
    if (tab) herdrPreview.push(`Tab:       ${tab}`)
  }
  const status = statusMarker(session.status)
  const persistence = session.persisted ? undefined : "\x1b[90m◇\x1b[0m"
  const markers = [status, persistence].filter(Boolean).join(" ")
  const locationText = herdrLabels.join(" · ")
  const lastUserMessage = session.persisted
    ? previewText(session.lastUserMessage?.trim() || "No user message found.")
    : "Not persisted yet; no transcript is available."
  const project = compactField(displayPath(session.cwd))
  const description = [markers, locationText, identity].filter(Boolean).join("  ")
  const searchText = [slug, title, project, session.id].filter(Boolean).join(" ")
  const searchableDescription = searchText
    ? `${description}\x1b[8m ${searchText}\x1b[0m`
    : description

  return {
    line: [slug || session.id, searchableDescription, String(index)].join(FIELD_SEPARATOR),
    preview: [
      title,
      ...herdrPreview,
      `Session:  ${session.id}`,
      ...(slug ? [`Agent:    ${slug}`] : []),
      ...(session.persisted ? [] : ["Persistence: not persisted yet"]),
      ...(project ? [`Project:  ${project}`] : []),
      ...(session.persisted ? [`Modified: ${formatModified(session.modified)}`] : []),
      "",
      "Last user message",
      "─────────────────",
      lastUserMessage,
      "",
    ].join("\n"),
  }
}

export async function pickSessionReference(tui: TUI, sessions: PickerSession[]): Promise<string | undefined> {
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
          "--ansi",
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
          "--nth=1",
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
