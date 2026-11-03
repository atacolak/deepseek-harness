/**
 * Resolve a real OMP transcript and resume it in place: prefix lookup over the
 * OMP session root, ownership-lease probing before a second process opens the
 * file, and chat-bubble hydration of its recorded messages into a blank harness
 * session.
 * @module @deepseek-ai/dsh-omp-rpc/resume
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** A resume or open request the HTTP surface can report with a stable status. */
export class OmpResumeError extends Error {
  /**
   * @param code - stable machine code reported to the caller.
   * @param message - caller-facing explanation.
   * @param status - HTTP status when the error crosses the open endpoint.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'OmpResumeError'
  }
}

/** One `/omp-resume` argument list. */
export interface OmpResumeRequest {
  /** Session UUID prefix, full UUID, or transcript path. */
  readonly prefix: string
  /** OMP profile overriding the transcript's recorded root agent. */
  readonly profile?: string
}

/**
 * Parse `<session-id-or-prefix> [profile]`.
 * @param rawInput - command text after the command name.
 * @returns the prefix and optional profile.
 */
export function parseOmpResumeInput(rawInput: string): OmpResumeRequest {
  const [prefix, profile, ...rest] = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  if (prefix === undefined) throw new Error('expected <session-id-or-prefix> [profile]')
  if (rest.length > 0) throw new Error('expected at most two arguments: <session-id-or-prefix> [profile]')
  return {
    prefix,
    ...profile === undefined ? {} : { profile },
  }
}

/** Facts read from one transcript's `session` header. */
export interface OmpTranscriptHeader {
  /** Absolute transcript path. */
  readonly path: string
  /** Session id recorded in the header. */
  readonly id: string
  /** Working directory the session was started in. */
  readonly cwd?: string
  /** Root agent profile recorded by `--agent`, when one was used. */
  readonly profile?: string
  /** Session creation timestamp. */
  readonly timestamp?: string
}

interface SessionEntry {
  readonly type?: unknown
  readonly id?: unknown
  readonly cwd?: unknown
  readonly rootAgent?: unknown
  readonly timestamp?: unknown
}

/**
 * Read the `session` header out of one transcript.
 * @param path - absolute transcript path.
 * @returns header facts, including the path.
 * @throws when the file holds no session header.
 */
export async function readOmpTranscriptHeader(path: string): Promise<OmpTranscriptHeader> {
  const text = await readFile(path, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: SessionEntry
    try {
      entry = JSON.parse(line) as SessionEntry
    } catch {
      continue
    }
    if (entry.type !== 'session' || typeof entry.id !== 'string' || entry.id.length === 0) continue
    return {
      path: resolve(path),
      id: entry.id,
      ...typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {},
      ...typeof entry.rootAgent === 'string' && entry.rootAgent.length > 0 ? { profile: entry.rootAgent } : {},
      ...typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {},
    }
  }
  throw new Error(`OMP transcript has no session header: ${path}`)
}

/**
 * List the transcripts directly under one OMP session root's project
 * directories, newest file first.
 * @param root - OMP session root (`~/.omp/agent/sessions`).
 * @returns transcript paths; unreadable directories contribute nothing.
 */
export async function listOmpTranscripts(root: string): Promise<string[]> {
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const project of projects) {
    if (!project.isDirectory() && !project.isSymbolicLink()) continue
    const dir = join(root, project.name)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith('.jsonl')) continue
      paths.push(join(dir, entry.name))
    }
  }
  return paths.sort((left, right) => right.localeCompare(left))
}

/** One resolved transcript and its header. */
export interface OmpTranscriptMatch extends OmpTranscriptHeader {
  /** Filename stem before the session id, useful in diagnostics. */
  readonly file: string
}

function transcriptIdOf(path: string): string | undefined {
  const stem = basename(path, '.jsonl')
  const underscore = stem.lastIndexOf('_')
  if (underscore === -1 || underscore === stem.length - 1) return undefined
  return stem.slice(underscore + 1)
}

/**
 * Resolve one transcript by UUID prefix or exact path.
 *
 * A prefix matches the session id recorded in the header or the id embedded in
 * the filename. An exact header id wins over prefix matches; several distinct
 * prefix matches are refused rather than guessed.
 * @param root - OMP session root.
 * @param prefix - UUID prefix, full id, or transcript path.
 * @returns the single matching transcript.
 */
export async function resolveOmpTranscript(root: string, prefix: string): Promise<OmpTranscriptMatch> {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) throw new Error('expected a session id or prefix')
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.endsWith('.jsonl')) {
    const path = resolve(trimmed)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`OMP transcript not found: ${path}`)
    const header = await readOmpTranscriptHeader(path)
    return { ...header, file: basename(path) }
  }
  const wanted = trimmed.toLowerCase()
  const matches: OmpTranscriptMatch[] = []
  for (const path of await listOmpTranscripts(root)) {
    const id = transcriptIdOf(path)
    const fileMatch = id?.toLowerCase().startsWith(wanted) === true
      || basename(path, '.jsonl').toLowerCase().startsWith(wanted)
    if (!fileMatch) continue
    const header = await readOmpTranscriptHeader(path).catch(() => undefined)
    if (header === undefined) continue
    matches.push({ ...header, file: basename(path) })
  }
  if (matches.length === 0) throw new Error(`no OMP transcript matches "${trimmed}" under ${root}`)
  const exact = matches.filter(match => match.id.toLowerCase() === wanted)
  if (exact.length === 1) return exact[0] as OmpTranscriptMatch
  const distinct = [...new Map(matches.map(match => [match.id, match])).values()]
  if (distinct.length === 1) return distinct[0] as OmpTranscriptMatch
  const listing = distinct.slice(0, 5).map(match => `${match.id.slice(0, 8)} (${match.path})`).join(', ')
  throw new Error(`"${trimmed}" matches ${String(distinct.length)} OMP sessions: ${listing}`)
}

/** Whether a process still owns one session's write lease. */
export interface OmpLeaseReport {
  /** Session ids a running process owns. */
  readonly held: readonly string[]
  /** Session ids whose lease could not be probed. */
  readonly unknown: readonly string[]
}

/**
 * Parse `omp session lease --json` output.
 * @param text - command stdout.
 * @returns the held and unknown id lists.
 */
export function parseOmpLeaseReport(text: string): OmpLeaseReport {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('omp session lease returned no report')
  const record = parsed as { held?: unknown; unknown?: unknown }
  const held = Array.isArray(record.held) ? record.held.filter((id): id is string => typeof id === 'string') : []
  const unknown = Array.isArray(record.unknown) ? record.unknown.filter((id): id is string => typeof id === 'string') : []
  return { held, unknown }
}

/**
 * Probe one session's ownership lease through OMP's own lock implementation.
 * @param runtime - host subprocess provider.
 * @param executable - resolved OMP executable.
 * @param id - session id from the transcript header.
 * @param cwd - existing working directory for the probe process.
 * @returns the report, or throws when the probe cannot produce one.
 */
export async function probeOmpSessionLease(
  runtime: SubprocessRuntime,
  executable: string,
  id: string,
  cwd: string,
): Promise<OmpLeaseReport> {
  const handle = runtime.spawn({
    argv: [executable, 'session', 'lease', '--json', '--', id],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 2_000,
    signal: AbortSignal.timeout(15_000),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    throw new Error(`omp session lease failed (${String(outcome.exitCode ?? outcome.signal)}): ${stderr.trim().slice(-400)}`)
  }
  try {
    return parseOmpLeaseReport(stdout)
  } catch (error: unknown) {
    throw new Error(`omp session lease returned unreadable output: ${stdout.trim().slice(-200)}`, { cause: error })
  }
}

/** One harness surface event reconstructed from a recorded OMP message. */
export type OmpHydrationEvent =
  | { readonly type: 'user/message'; readonly data: SessionEvent<'user/message'>['data'] }
  | { readonly type: 'assistant/message'; readonly data: SessionEvent<'assistant/message'>['data'] }
  | { readonly type: 'tool/result'; readonly data: SessionEvent<'tool/result'>['data'] }

interface TranscriptContentPart {
  readonly type?: unknown
  readonly text?: unknown
  readonly thinking?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
}

interface TranscriptMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly provider?: unknown
  readonly model?: unknown
  readonly toolCallId?: unknown
  readonly isError?: unknown
}

interface TranscriptMessageEntry {
  readonly type?: unknown
  readonly message?: TranscriptMessage
}

function partsOf(content: unknown): TranscriptContentPart[] {
  if (!Array.isArray(content)) return []
  return content.filter((part): part is TranscriptContentPart => typeof part === 'object' && part !== null)
}

function textBlocks(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of partsOf(content)) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') blocks.push({ type: 'text', text: '[image]' })
  }
  return blocks
}

function assistantBlocks(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of partsOf(content)) {
    if (part.type === 'thinking' && typeof part.thinking === 'string') {
      if (part.thinking.length > 0) blocks.push({ type: 'reasoning', text: part.thinking })
      continue
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') {
      blocks.push({ type: 'text', text: '[image]' })
      continue
    }
    if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
      const raw = part.arguments
      blocks.push({
        type: 'tool-call',
        id: ToolCallId(part.id),
        name: part.name,
        arguments: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}),
      })
    }
  }
  return blocks
}

/**
 * Rebuild the harness surface events a real OMP transcript recorded, so an
 * opened or resumed session shows the same user, assistant, and tool bubbles
 * instead of one summarized seed message.
 * @param path - transcript path.
 * @param limit - maximum surface events returned, newest last.
 * @returns ordered events ready to append to a blank harness session.
 */
export async function ompHydrationEvents(path: string, limit = 200): Promise<OmpHydrationEvent[]> {
  const text = await readFile(path, 'utf8')
  const events: OmpHydrationEvent[] = []
  let turn = 0
  let step = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: TranscriptMessageEntry
    try {
      entry = JSON.parse(line) as TranscriptMessageEntry
    } catch {
      continue
    }
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message === undefined) continue
    if (message.role === 'user') {
      const content = textBlocks(message.content)
      if (content.length === 0) continue
      turn += 1
      step = 0
      events.push({
        type: 'user/message',
        data: createUserMessage({ content, source: { kind: 'user' } }),
      })
      continue
    }
    if (message.role === 'assistant') {
      const content = assistantBlocks(message.content)
      if (content.length === 0) continue
      if (turn === 0) turn = 1
      step += 1
      const provider = typeof message.provider === 'string' && message.provider.length > 0 ? message.provider : 'omp'
      const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : 'omp'
      events.push({
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: createAssistantMessage({ content, source: { provider, model } }),
          stream: [],
        },
      })
      continue
    }
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
      const content = textBlocks(message.content)
      if (turn === 0) turn = 1
      step += 1
      events.push({
        type: 'tool/result',
        data: {
          turn,
          step,
          message: createToolResultMessage({
            callId: ToolCallId(message.toolCallId),
            content,
            isError: message.isError === true,
          }),
        },
      })
    }
  }
  return events.slice(-limit)
}

/**
 * Append a transcript's recorded surface events to a blank harness session.
 * @param session - live session receiving the events.
 * @param path - transcript path.
 * @param limit - maximum surface events hydrated, newest last.
 * @returns number of appended events.
 */
export async function hydrateOmpSession(session: Session, path: string, limit = 200): Promise<number> {
  const events = await ompHydrationEvents(path, limit)
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        session.append('user/message', event.data, { surfaceOp: 'append' })
        break
      case 'assistant/message':
        session.append('assistant/message', event.data, { surfaceOp: 'append' })
        break
      case 'tool/result':
        session.append('tool/result', event.data, { surfaceOp: 'append' })
        break
    }
  }
  return events.length
}
