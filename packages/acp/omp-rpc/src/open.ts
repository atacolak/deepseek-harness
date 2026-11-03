/**
 * The `/api/exocortex/omp/open` route: open one harness session onto an
 * existing OMP transcript, hydrating its recorded messages into real chat
 * bubbles and attaching the OMP process when the caller does not name a live
 * session.
 * @module @deepseek-ai/dsh-omp-rpc/open
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  OmpResumeError,
  type OmpTranscriptMatch,
} from './resume.ts'

/** Exact shared-API route that opens an OMP transcript in a harness session. */
export const OMP_OPEN_PATH = '/api/exocortex/omp/open'

/** Bound on one open request body; it carries only ids and paths. */
export const OMP_OPEN_MAX_BODY_BYTES = 64 * 1024

/** One validated open request. */
export interface OmpOpenRequest {
  /** OMP session id, id prefix, or absolute transcript path. */
  readonly ompSession: string
  /** Existing harness session to hydrate; omitted creates a new one. */
  readonly sessionId?: string
  /** OMP profile passed as `--agent`, overriding the transcript's root agent. */
  readonly profile?: string
  /** Working directory for a newly created session. */
  readonly cwd?: string
}

/** One opened transcript outcome returned to the caller. */
export interface OmpOpenedSession {
  readonly summary: string
  readonly hydrated: number
}

/** Collaborators of the open endpoint. */
export interface OmpOpenDeps {
  /** Resolve one transcript id or path. */
  readonly resolveTranscript: (prefix: string) => Promise<OmpTranscriptMatch>
  /** Resolve a live harness agent, or create a session for the transcript. */
  readonly openAgent: (request: {
    readonly sessionId?: string
    readonly cwd: string
    readonly profile?: string
  }) => Promise<{ readonly agent: Agent; readonly agentPreset?: string }>
  /** Attach the agent to the transcript and hydrate a blank session. */
  readonly openTranscript: (request: {
    readonly agent: Agent
    readonly transcript: OmpTranscriptMatch
    readonly cwd: string
    readonly profile?: string
  }) => Promise<OmpOpenedSession>
  /** Working directory when neither the request nor the transcript records one. */
  readonly defaultCwd?: string
  /** Profile when neither the request nor the transcript records one. */
  readonly defaultProfile?: string
  /** Receives unexpected failures before the generic response leaves. */
  readonly logError?: (error: unknown) => void
}

function invalid(message: string): OmpResumeError {
  return new OmpResumeError('request/invalid', message, 400)
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`"${field}" must be a non-empty string`)
  return value.trim()
}

/**
 * Validate one open request body.
 * @param value - decoded JSON body.
 * @returns the request with trimmed non-empty fields.
 */
export function parseOmpOpenInput(value: unknown): OmpOpenRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('A JSON object body is required.')
  const record = value as Record<string, unknown>
  const ompSession = optionalString(record.ompSession, 'ompSession')
  if (ompSession === undefined) throw invalid('"ompSession" is required.')
  const sessionId = optionalString(record.sessionId, 'sessionId')
  const profile = optionalString(record.profile, 'profile')
  const cwd = optionalString(record.cwd, 'cwd')
  return {
    ompSession,
    ...sessionId === undefined ? {} : { sessionId },
    ...profile === undefined ? {} : { profile },
    ...cwd === undefined ? {} : { cwd },
  }
}

function fail(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > OMP_OPEN_MAX_BODY_BYTES) {
    throw new OmpResumeError('request/too-large', 'Request body is too large.', 413)
  }
  if (request.body === null) throw invalid('A JSON body is required.')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of request.body) {
    total += chunk.byteLength
    if (total > OMP_OPEN_MAX_BODY_BYTES) {
      throw new OmpResumeError('request/too-large', 'Request body is too large.', 413)
    }
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw invalid('Request body must be JSON.')
  }
}

/**
 * Serve one `POST /api/exocortex/omp/open` after transport admission.
 * @param request - authenticated Fetch request.
 * @param deps - transcript resolution, session opening, and attachment.
 * @returns JSON success with the session and transcript identity, or a stable error body.
 */
export async function serveOmpOpen(request: Request, deps: OmpOpenDeps): Promise<Response> {
  try {
    const input = parseOmpOpenInput(await jsonBody(request))
    let transcript: OmpTranscriptMatch
    try {
      transcript = await deps.resolveTranscript(input.ompSession)
    } catch (error: unknown) {
      throw new OmpResumeError(
        'omp/transcript-not-found',
        error instanceof Error ? error.message : String(error),
        404,
      )
    }
    const cwd = input.cwd ?? transcript.cwd ?? deps.defaultCwd
    if (cwd === undefined) throw invalid('"cwd" is required when the transcript records no working directory.')
    const profile = input.profile ?? transcript.profile ?? deps.defaultProfile
    const opened = await deps.openAgent({
      cwd,
      ...input.sessionId === undefined ? {} : { sessionId: input.sessionId },
      ...profile === undefined ? {} : { profile },
    })
    const outcome = await deps.openTranscript({
      agent: opened.agent,
      transcript,
      cwd,
      ...profile === undefined ? {} : { profile },
    })
    return new Response(JSON.stringify({
      sessionId: opened.agent.id,
      ...opened.agentPreset === undefined ? {} : { agentPreset: opened.agentPreset },
      ompSession: {
        id: transcript.id,
        path: transcript.path,
        ...transcript.cwd === undefined ? {} : { cwd: transcript.cwd },
        ...transcript.profile === undefined ? {} : { profile: transcript.profile },
      },
      hydrated: outcome.hydrated,
      summary: outcome.summary,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error: unknown) {
    if (error instanceof OmpResumeError) return fail(error.status, error.code, error.message)
    deps.logError?.(error)
    return fail(500, 'gateway/internal', 'Internal error.')
  }
}
