import { open } from "node:fs/promises"
import { homedir } from "node:os"
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent"

const READ_CHUNK_BYTES = 64 * 1024
const SESSION_READ_CONCURRENCY = 16
const USER_ROLE_MARKER = Buffer.from("\"role\":\"user\"")
const NO_TEXT_USER_MESSAGE = "User message contains no text."

export interface PickerSession {
  id: string
  slug?: string
  herdrLocations?: {
    workspace?: string
    tab?: string
  }[]
  /** Undefined when agent-id discovery is unavailable. */
  active?: boolean
  cwd: string
  title: string
  modified: Date
  lastUserMessage: string | undefined
}

type AgentMetadata = Pick<PickerSession, "slug" | "herdrLocations">

type SessionMessageEntry = {
  type?: unknown
  message?: {
    role?: unknown
    content?: unknown
  }
}

function userMessageFromLine(line: Buffer): string | undefined {
  if (line.length === 0) return undefined
  if (line.indexOf(USER_ROLE_MARKER) === -1) return undefined

  try {
    const entry = JSON.parse(line.toString("utf8")) as SessionMessageEntry
    if (entry.type !== "message" || entry.message?.role !== "user") return undefined
    const content = entry.message.content
    if (typeof content === "string") return content || NO_TEXT_USER_MESSAGE
    if (!Array.isArray(content)) return NO_TEXT_USER_MESSAGE

    const text = content.flatMap((block) => {
      if (block === null || typeof block !== "object") return []
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : []
    })
    return text.length > 0 ? text.join("\n") : NO_TEXT_USER_MESSAGE
  } catch {
    return undefined
  }
}

export async function readLastUserMessage(
  sessionPath: string,
  chunkBytes = READ_CHUNK_BYTES,
): Promise<string | undefined> {
  const file = await open(sessionPath, "r")

  try {
    const { size } = await file.stat()
    let position = size
    let suffix = Buffer.alloc(0)

    while (position > 0) {
      const start = Math.max(0, position - chunkBytes)
      const chunk = Buffer.allocUnsafe(position - start)
      const { bytesRead } = await file.read(chunk, 0, chunk.length, start)
      const data = Buffer.concat([chunk.subarray(0, bytesRead), suffix])
      let lineEnd = data.length

      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue
        const message = userMessageFromLine(data.subarray(index + 1, lineEnd))
        if (message !== undefined) return message
        lineEnd = index
      }

      suffix = Buffer.from(data.subarray(0, lineEnd))
      position = start
    }

    return userMessageFromLine(suffix)
  } finally {
    await file.close()
  }
}

function sessionTitle(session: SessionInfo): string {
  const title = session.title?.trim()
  if (title) return title

  const firstMessage = session.firstMessage.trim()
  return firstMessage && firstMessage !== "(no messages)" ? firstMessage : "Untitled"
}

export function compactField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
}

export function previewText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

export function displayPath(value: string): string {
  const home = homedir()
  return value === home ? "~" : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value
}

export function formatModified(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

async function discoverAgents(includeAll: boolean): Promise<Map<string, AgentMetadata> | undefined> {
  try {
    const process = Bun.spawn(["agent-id", "discover", "--limit", "0", "--json", ...(includeAll ? ["--all"] : [])], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited])
    if (code !== 0) return undefined

    const assignments: unknown = JSON.parse(output)
    if (!Array.isArray(assignments)) return undefined
    const agents = new Map<string, AgentMetadata>()
    for (const assignment of assignments) {
      if (typeof assignment?.session_id !== "string") continue
      const herdrLocations: NonNullable<PickerSession["herdrLocations"]> = []
      const locations = assignment.runtime?.provider === "herdr" && Array.isArray(assignment.runtime.locations)
        ? assignment.runtime.locations
        : []
      for (const location of locations) {
        const workspace = typeof location?.workspace_label === "string"
          ? compactField(location.workspace_label) || undefined
          : undefined
        const tab = typeof location?.tab_label === "string"
          ? compactField(location.tab_label) || undefined
          : undefined
        if (!workspace && !tab) continue
        if (!herdrLocations.some((existing) => existing.workspace === workspace && existing.tab === tab)) {
          herdrLocations.push({ workspace, tab })
        }
      }
      agents.set(assignment.session_id, {
        slug: typeof assignment.slug === "string" ? assignment.slug : undefined,
        herdrLocations: herdrLocations.length > 0 ? herdrLocations : undefined,
      })
    }
    return agents
  } catch {
    // Identity metadata is optional; missing or unavailable agent-id must not prevent picking a session.
    return undefined
  }
}

export async function listPickerSessions(
  currentSessionId: string,
  sessions: SessionInfo[],
): Promise<PickerSession[]> {
  sessions = sessions.filter((session) => session.id !== currentSessionId)
  const result: PickerSession[] = []
  if (sessions.length === 0) return result
  const [allAgents, activeAgents] = await Promise.all([discoverAgents(true), discoverAgents(false)])

  for (let offset = 0; offset < sessions.length; offset += SESSION_READ_CONCURRENCY) {
    const batch = sessions.slice(offset, offset + SESSION_READ_CONCURRENCY)
    result.push(
      ...(await Promise.all(
        batch.map(async (session) => {
          const allMetadata = allAgents?.get(session.id)
          const activeMetadata = activeAgents?.get(session.id)
          return {
            id: session.id,
            slug: allMetadata?.slug ?? activeMetadata?.slug,
            herdrLocations: activeMetadata?.herdrLocations ?? allMetadata?.herdrLocations,
            active: activeAgents?.has(session.id),
            cwd: session.cwd,
            title: sessionTitle(session),
            modified: session.modified,
            lastUserMessage: await readLastUserMessage(session.path).catch(() => undefined),
          }
        }),
      )),
    )
  }

  return result
}
