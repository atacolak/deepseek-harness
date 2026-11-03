import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStepStream } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OmpModelCatalogSync, type CatalogSyncOutcome, type OmpModelSelection } from './catalog.ts'
import { OmpRpcClient } from './client.ts'
import { DEFAULT_OMP_HOST_TOOLS, ompCordisHostTools } from './cordis-tools.ts'
import { OmpAgentDriver, type OmpToolEvent } from './driver.ts'
import { OmpHostToolBridge } from './host-tools.ts'
import { launchOmp, type LaunchedOmp } from './launch.ts'
import { OmpUiBridge, type OmpUiAsker } from './ui.ts'
import type { OmpExtensionUiRequest } from './types.ts'

/** How a harness agent joins an OMP process. */
export type OmpAttachMode = 'attach' | 'fork'

/** One attach or fork request. */
export interface OmpAttachOptions {
  readonly mode: OmpAttachMode
  /** Profile name passed as `--agent`; omitted uses OMP's default profile. */
  readonly preset?: string
  /** Existing OMP transcript for `attach`; omitted starts a fresh transcript. */
  readonly sessionId?: string
  /** Exact transcript path to resume for `attach`; wins over {@link sessionId}. */
  readonly resumePath?: string
  /** Provider/model the OMP gateway should serve for this attachment. */
  readonly selection?: OmpModelSelection
  /** Directory holding OMP transcripts for this attachment. */
  readonly sessionDir: string
  /** Harness tools published to OMP; defaults to the Cordis discovery set. */
  readonly hostTools?: readonly string[]
  /** Working directory for the OMP process. */
  readonly cwd: string
}

/** What one successful attachment exposes to callers. */
export interface OmpAttachment {
  readonly client: OmpRpcClient
  readonly launched: LaunchedOmp
  readonly catalog: CatalogSyncOutcome
  /** Session identity and transcript path OMP reports as active. */
  readonly session: { readonly id: string; readonly path?: string }
  /** Working directory the OMP process was launched in. */
  readonly cwd: string
}

async function activeSessionOf(client: OmpRpcClient): Promise<OmpAttachment['session']> {
  const state = await client.request({ type: 'get_state' })
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new Error('OMP get_state returned no session state')
  }
  const record = state as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    throw new Error('OMP get_state returned no session id')
  }
  return {
    id: record.sessionId,
    ...typeof record.sessionFile === 'string' && record.sessionFile.length > 0
      ? { path: record.sessionFile }
      : {},
  }
}

/** Collaborators shared by every attachment in one bridge plugin. */
export interface OmpBridgeOptions {
  readonly ctx: Context
  readonly subprocess: SubprocessRuntime
  /** OMP executable name or absolute path resolved by the subprocess provider. */
  readonly executable: string
  readonly asker?: OmpUiAsker
  readonly onSurface?: (request: OmpExtensionUiRequest) => void
}

/** A profile typed into `/omp-attach` or `/omp-fork`. */
export interface OmpCommandInput {
  readonly preset?: string
  readonly sessionId?: string
}

/** Parse the optional `<preset> [session]` argument grammar. */
export function parseOmpCommandInput(rawInput: string): OmpCommandInput {
  const [preset, sessionId, ...rest] = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  if (rest.length > 0) throw new Error('expected at most two arguments: <preset> [session]')
  return {
    ...preset === undefined ? {} : { preset },
    ...sessionId === undefined ? {} : { sessionId },
  }
}

/**
 * Build the OMP RPC argv for one attachment. Fork starts a fresh transcript so
 * the harness history is replayed into it; attach resumes an explicitly named
 * transcript, and starts a fresh one in the shared OMP root when none is named.
 * @param options - executable, mode, profile, and transcript directory.
 * @returns argv beginning with the OMP executable.
 */
export function ompLaunchArgv(options: {
  readonly executable: string
  readonly mode: OmpAttachMode
  readonly sessionDir: string
  readonly preset?: string
  readonly sessionId?: string
  readonly resumePath?: string
}): string[] {
  const argv = [options.executable, '--mode', 'rpc', '--session-dir', options.sessionDir]
  if (options.preset !== undefined) argv.push('--agent', options.preset)
  if (options.mode === 'attach') {
    if (options.resumePath !== undefined) argv.push('--resume', options.resumePath)
    else if (options.sessionId !== undefined) argv.push('--resume', options.sessionId)
  }
  return argv
}

interface LiveAttachment {
  readonly agent: Agent
  readonly launched: LaunchedOmp
  readonly driver: OmpAgentDriver
  readonly hostTools: OmpHostToolBridge
  readonly ui: OmpUiBridge
  detachStream: () => void
  readonly cursor: LiveCursor
}

interface LiveCursor {
  readonly agent: Agent
  turn: number
  step: number
}

/**
 * Owns the OMP processes attached to harness agents. One attachment serves
 * every step of its agent through `agent/step-stream`, publishes host tools,
 * answers extension UI, projects OMP's internal tool executions into the
 * trajectory, and closes with the agent's scope.
 */
export class OmpBridge {
  private readonly options: OmpBridgeOptions
  private readonly attachments = new Map<SessionId, LiveAttachment>()

  constructor(options: OmpBridgeOptions) {
    this.options = options
  }

  /**
   * Start or resume one OMP process and bind it to an agent.
   * @param agent - the live harness agent to serve.
   * @param options - attach/fork mode, transcript identity, and launch inputs.
   * @returns the launched process and the catalog synchronization outcome.
   */
  async attach(agent: Agent, options: OmpAttachOptions): Promise<OmpAttachment> {
    await this.detach(agent.id)
    await mkdir(options.sessionDir, { recursive: true })
    const executable = await this.options.subprocess.resolveExecutable(this.options.executable, undefined)
    const launched = launchOmp(this.options.subprocess, {
      argv: ompLaunchArgv({ ...options, executable }),
      cwd: options.cwd,
    })
    let client: OmpRpcClient | undefined
    try {
      await launched.ready
      client = launched.client
      await client.negotiateProtocol()
      const session = await activeSessionOf(client)
      const selection = options.selection ?? agent.model.current()
      const catalog = await new OmpModelCatalogSync(client, selection).sync()
      const hostTools = new OmpHostToolBridge({
        client,
        tools: () => ompCordisHostTools({
          ctx: this.options.ctx,
          agent,
          names: options.hostTools ?? DEFAULT_OMP_HOST_TOOLS,
        }),
      })
      const ui = new OmpUiBridge({
        client,
        asker: this.options.asker ?? (() => Promise.resolve({ type: 'extension_ui_response', id: '', cancelled: true } as const)),
        ...this.options.onSurface === undefined ? {} : { onSurface: this.options.onSurface },
      })
      const cursor = { agent, turn: 0, step: 0 }
      const driver = new OmpAgentDriver(client, {
        transcript: options.mode === 'fork' ? 'replay' : 'latest',
        onTool: (event) => { this.projectTool(cursor, event) },
      })
      const live: LiveAttachment = {
        agent,
        launched,
        driver,
        hostTools,
        ui,
        detachStream: () => {},
        cursor,
      }
      live.detachStream = this.bindStream(live)
      await hostTools.sync()
      this.attachments.set(agent.id, live)
      agent.ctx.effect(() => () => this.detach(agent.id), 'omp-rpc attachment')
      return { client, launched, catalog, session, cwd: options.cwd }
    } catch (error: unknown) {
      await launched.close()
      throw error
    }
  }

  /**
   * Whether one harness session already has a live OMP process bound to it.
   * @param id - harness session identity.
   * @returns true while an attachment is registered.
   */
  attached(id: SessionId): boolean {
    return this.attachments.has(id)
  }

  /**
   * Stop the OMP process attached to one session.
   * @param id - harness session identity.
   */
  async detach(id: SessionId): Promise<void> {
    const live = this.attachments.get(id)
    if (live === undefined) return
    this.attachments.delete(id)
    live.detachStream()
    live.hostTools.close()
    live.ui.close()
    await live.launched.close()
  }

  /** Stop every attachment, as when the owning plugin unloads. */
  async dispose(): Promise<void> {
    await Promise.all([...this.attachments.keys()].map(id => this.detach(id)))
  }

  private bindStream(live: LiveAttachment): () => void {
    return live.agent.ctx.on('agent/step-stream', async (payload, next) => {
      if (payload.agent !== live.agent) return next()
      live.cursor.turn = payload.turn
      live.cursor.step = payload.step
      const stream: AgentStepStream = (request, signal) => live.driver.stream(request, signal)
      return stream
    })
  }

  private projectTool(cursor: LiveCursor, event: OmpToolEvent): void {
    const callId = ToolCallId(event.toolCallId)
    if (event.kind === 'start') {
      cursor.agent.session.append('tool/call', {
        turn: cursor.turn,
        step: cursor.step,
        callId,
        name: event.toolName,
        arguments: JSON.stringify(event.arguments),
      })
      return
    }
    const content = event.content.map(block => block.type === 'image'
      ? { type: 'text' as const, text: `[image: ${block.mimeType ?? 'unknown'}]` }
      : { type: 'text' as const, text: block.text ?? '' })
    cursor.agent.session.append('tool/result', {
      turn: cursor.turn,
      step: cursor.step,
      message: createToolResultMessage({ callId, content, isError: event.isError }),
    }, { surfaceOp: 'append' })
  }
}

