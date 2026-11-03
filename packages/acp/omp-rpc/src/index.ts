/**
 * Cordis composition of the OMP RPC bridge: auto-discovered `omp:<profile>`
 * agent presets, durable reattachment of OMP-preset sessions, `/omp-attach`,
 * `/omp-resume`, and `/omp-fork` commands, `POST /api/exocortex/omp/open`,
 * per-agent step streams, host tools, extension UI, catalog sync, and
 * trajectory projection.
 * @module @deepseek-ai/dsh-omp-rpc
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import Schema from '@deepseek-ai/schemastery'
import { defaultOmpBindingsFile, OmpBindings } from './bindings.ts'
import {
  OmpBridge,
  parseOmpCommandInput,
  type OmpAttachOptions,
  type OmpAttachment,
} from './bridge.ts'
import { DEFAULT_OMP_HOST_TOOLS } from './cordis-tools.ts'
import { OMP_OPEN_PATH, serveOmpOpen } from './open.ts'
import {
  discoverOmpPresets,
  ompPresetDefinition,
  ompPresetId,
  ompPresetOrder,
  ompProfileOfPreset,
} from './presets.ts'
import {
  hydrateOmpSession,
  OmpResumeError,
  parseOmpResumeInput,
  probeOmpSessionLease,
  resolveOmpTranscript,
  type OmpResumeRequest,
  type OmpTranscriptMatch,
} from './resume.ts'
import type { OmpUiAsker } from './ui.ts'
import type { OmpExtensionUiRequest } from './types.ts'

export * from './bindings.ts'
export * from './bridge.ts'
export * from './catalog.ts'
export * from './client.ts'
export * from './cordis-tools.ts'
export * from './driver.ts'
export * from './host-tools.ts'
export * from './launch.ts'
export * from './open.ts'
export * from './presets.ts'
export * from './resume.ts'
export * from './ui.ts'
export * from './types.ts'

export const DEFAULT_OMP_SESSIONS_ROOT = join(homedir(), '.omp', 'agent', 'sessions')

export const name = 'omp-rpc'
export const inject = ['commands', 'subprocess', 'tools']

/** Plugin configuration for the OMP bridge. */
export interface OmpRpcConfig {
  /** OMP executable name or absolute path. */
  readonly executable?: string
  /** Root directory holding every OMP transcript; defaults to the OMP sessions root. */
  readonly sessionDir?: string
  /** Root of the live OMP transcripts `/omp-resume` resolves and resumes. */
  readonly ompSessionsRoot?: string
  /** Default `<agent>.md` profile passed as `--agent`. */
  readonly preset?: string
  /** Harness tools published to every OMP process. */
  hostTools?: string[]
  /** Working directory when a session header does not record one. */
  readonly cwd?: string
  /** Home directory owning `~/.omp/agent/agents`; defaults to the process home. */
  readonly home?: string
  /** Attach every OMP-preset session to OMP before its first step, resuming its durable transcript binding. */
  readonly autoAttach?: boolean
  /** Durable session-to-transcript bindings file; defaults to `$DSH_HOME/omp/bindings.json`. */
  readonly bindingsFile?: string
  /** Optional extension UI answerer supplied by a composed surface. */
  readonly asker?: OmpUiAsker
  /** Receives non-interactive OMP extension UI surfaces. */
  readonly onSurface?: (request: OmpExtensionUiRequest) => void
}

export const Config: Schema<OmpRpcConfig> = Schema.object({
  executable: Schema.string(),
  sessionDir: Schema.string(),
  ompSessionsRoot: Schema.string(),
  preset: Schema.string(),
  hostTools: Schema.array(Schema.string()),
  cwd: Schema.string(),
  home: Schema.string(),
  autoAttach: Schema.boolean(),
  bindingsFile: Schema.string(),
  asker: Schema.any(),
  onSurface: Schema.any(),
})

function attachmentSummary(mode: OmpAttachOptions['mode'], attachment: OmpAttachment): string {
  const version = attachment.client.protocol
  const catalog = attachment.catalog.status === 'applied'
    ? `model ${attachment.catalog.model.id}`
    : attachment.catalog.status === 'not-offered'
      ? 'harness model not offered by the OMP gateway'
      : 'OMP default model'
  return `${mode === 'fork' ? 'forked' : 'attached'} OMP RPC v${String(version)} (${catalog})`
}

function sessionIsBlank(session: { snapshotEvents(): readonly { readonly type: string }[] }): boolean {
  return !session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'assistant/message')
}

async function existingDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isDirectory() === true
}

async function existingFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() === true
}

/** What one resolved transcript open produced. */
interface OmpTranscriptOpened {
  readonly transcript: OmpTranscriptMatch
  readonly summary: string
  readonly hydrated: number
}

/**
 * Mount the OMP bridge, its auto-discovered presets, its commands, and the
 * Exocortex open route that hydrates a real transcript into a session.
 * @param ctx - Cordis context carrying commands, tools, and subprocess.
 * @param config - executable, transcript root, profile, and host tool selection.
 */
export function apply(ctx: Context, config: OmpRpcConfig): void {
  const bridge = new OmpBridge({
    ctx,
    subprocess: ctx.subprocess,
    executable: config.executable ?? 'omp',
    ...config.asker === undefined ? {} : { asker: config.asker },
    ...config.onSurface === undefined ? {} : { onSurface: config.onSurface },
  })
  ctx.effect(() => () => bridge.dispose(), 'omp-rpc bridge')

  const sessionsRoot = config.ompSessionsRoot ?? DEFAULT_OMP_SESSIONS_ROOT
  const attachOptions = (agent: Agent, options: {
    readonly mode: OmpAttachOptions['mode']
    readonly preset?: string
    readonly sessionId?: string
    readonly resumePath?: string
    readonly cwd?: string
  }): OmpAttachOptions => {
    const cwd = options.cwd ?? agent.session.header.cwd ?? config.cwd
    if (cwd === undefined) throw new Error('OMP bridge has no working directory: set omp-rpc cwd or start the session in one')
    const preset = options.preset ?? config.preset
    return {
      ...options,
      ...preset === undefined ? {} : { preset },
      sessionDir: config.sessionDir ?? sessionsRoot,
      hostTools: config.hostTools ?? DEFAULT_OMP_HOST_TOOLS,
      cwd,
    }
  }

  const profileOf = (agent: Agent): string | undefined => {
    const preset = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)
    return preset === undefined ? undefined : ompProfileOfPreset(preset)
  }

  const bindings = new OmpBindings(config.bindingsFile ?? defaultOmpBindingsFile())

  const warn = (message: string, error?: unknown): void => {
    ctx.logger.warn(`[omp-rpc] ${message}${error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`}`)
  }

  const forgetBinding = async (id: SessionId): Promise<void> => {
    try {
      await bindings.delete(id)
    } catch (error: unknown) {
      warn(`cannot drop binding for session "${id}"`, error)
    }
  }

  const rememberBinding = async (agent: Agent, attachment: OmpAttachment, profile?: string): Promise<void> => {
    if (attachment.session.path === undefined) {
      await forgetBinding(agent.id)
      return
    }
    try {
      await bindings.set(agent.id, {
        ompSessionId: attachment.session.id,
        path: attachment.session.path,
        cwd: attachment.cwd,
        ...profile === undefined ? {} : { profile },
        updatedAt: new Date().toISOString(),
      })
    } catch (error: unknown) {
      warn(`cannot persist binding for session "${agent.id}"`, error)
    }
  }

  const readBinding = async (id: SessionId) => {
    try {
      return await bindings.get(id)
    } catch (error: unknown) {
      warn(`cannot read binding for session "${id}"`, error)
      return undefined
    }
  }

  const pinOpenedSession = async (agent: Agent, profile: string | undefined): Promise<void> => {
    if (profile !== 'argon') return
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    try {
      await registry.pinSession(agent.id)
    } catch (error: unknown) {
      warn(`cannot pin argon session "${agent.id}"`, error)
    }
  }

  const resolveTranscript = async (prefix: string): Promise<OmpTranscriptMatch> => {
    try {
      return await resolveOmpTranscript(sessionsRoot, prefix)
    } catch (error: unknown) {
      throw new OmpResumeError(
        'omp/transcript-not-found',
        error instanceof Error ? error.message : String(error),
        404,
      )
    }
  }

  const openTranscript = async (request: {
    readonly agent: Agent
    readonly transcript: OmpTranscriptMatch
    readonly cwd: string
    readonly profile?: string
  }): Promise<OmpTranscriptOpened> => {
    const { agent, transcript, cwd, profile } = request
    const executable = await ctx.subprocess.resolveExecutable(config.executable ?? 'omp', undefined)
    const lease = await probeOmpSessionLease(ctx.subprocess, executable, transcript.id, cwd)
    if (lease.held.includes(transcript.id) || lease.unknown.includes(transcript.id)) {
      const reason = lease.held.includes(transcript.id)
        ? 'is still open in a terminal pane'
        : 'ownership could not be probed'
      throw new OmpResumeError(
        'omp/session-busy',
        `session ${transcript.id.slice(0, 8)} ${reason} — close/exit that pane first, then run /omp-resume ${transcript.id.slice(0, 8)}`,
        409,
      )
    }
    const attachment = await bridge.attach(agent, attachOptions(agent, {
      mode: 'attach',
      resumePath: transcript.path,
      cwd,
      ...profile === undefined ? {} : { preset: profile },
    }))
    const hydrated = sessionIsBlank(agent.session)
      ? await hydrateOmpSession(agent.session, transcript.path)
      : 0
    await rememberBinding(agent, attachment, profile)
    await pinOpenedSession(agent, profile)
    return {
      transcript,
      hydrated,
      summary: `resumed OMP session ${transcript.id.slice(0, 8)}${profile === undefined ? '' : ` as ${profile}`} (${attachmentSummary('attach', attachment)})`,
    }
  }

  const resume = async (agent: Agent, request: OmpResumeRequest): Promise<OmpTranscriptOpened> => {
    const transcript = await resolveTranscript(request.prefix)
    const cwd = transcript.cwd !== undefined && await existingDirectory(transcript.cwd)
      ? transcript.cwd
      : agent.session.header.cwd ?? config.cwd
    if (cwd === undefined) {
      throw new OmpResumeError(
        'omp/cwd-unavailable',
        'OMP bridge has no working directory: set omp-rpc cwd or start the session in one',
        400,
      )
    }
    const profile = request.profile ?? transcript.profile ?? config.preset
    return await openTranscript({
      agent,
      transcript,
      cwd,
      ...profile === undefined ? {} : { profile },
    })
  }

  ctx.inject(['agentPresets'], (presetCtx) => {
    if (config.autoAttach !== false) {
      ctx.on('agent/pre-step', async (payload, next) => {
        if (bridge.attached(payload.agent.id)) return next()
        const profile = profileOf(payload.agent)
        if (profile === undefined) return next()
        const binding = await readBinding(payload.agent.id)
        const resumePath = binding !== undefined && await existingFile(binding.path) ? binding.path : undefined
        let attachment: OmpAttachment
        try {
          attachment = await bridge.attach(payload.agent, attachOptions(payload.agent, {
            mode: 'attach',
            preset: profile,
            ...resumePath === undefined ? {} : { resumePath },
          }))
        } catch (error: unknown) {
          if (resumePath === undefined) throw error
          warn(`cannot resume transcript ${resumePath}; starting a fresh OMP session`, error)
          await forgetBinding(payload.agent.id)
          attachment = await bridge.attach(payload.agent, attachOptions(payload.agent, {
            mode: 'attach',
            preset: profile,
          }))
        }
        await rememberBinding(payload.agent, attachment, profile)
        return next()
      })
    }
    return discoverOmpPresets({
      cwd: config.cwd ?? process.cwd(),
      ...config.home === undefined ? {} : { home: config.home },
    }).then(async presets => {
      const ordered = presets.sort((left, right) => left.name.localeCompare(right.name))
      for (const preset of ordered) {
        await presetCtx.agentPresets.register(ompPresetDefinition(preset, ompPresetOrder(preset.name)))
      }
    })
  })

  ctx.effect(() => ctx.commands.register({
    name: 'omp-resume',
    description: 'Resume a live OMP transcript from ~/.omp/agent/sessions in place and hydrate its recorded chat bubbles into this session.',
    input: { hint: '<session-id-or-prefix> [profile]' },
    async handler(invocation) {
      try {
        return { kind: 'success', text: (await resume(invocation.agent, parseOmpResumeInput(invocation.rawInput))).summary }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'omp-rpc /omp-resume')

  ctx.effect(() => ctx.commands.register({
    name: 'omp-attach',
    description: 'Attach this session to an OMP RPC process and continue an OMP transcript.',
    input: { hint: '<session-id-or-prefix> [profile]' },
    async handler(invocation) {
      try {
        return { kind: 'success', text: (await resume(invocation.agent, parseOmpResumeInput(invocation.rawInput))).summary }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'omp-rpc /omp-attach')

  ctx.effect(() => ctx.commands.register({
    name: 'omp-fork',
    description: 'Start a fresh OMP RPC process and replay this session history into it.',
    input: { hint: '<preset>' },
    async handler(invocation) {
      try {
        const input = parseOmpCommandInput(invocation.rawInput)
        if (input.sessionId !== undefined) throw new Error('/omp-fork starts a fresh transcript and accepts only a preset')
        const attachment = await bridge.attach(invocation.agent, attachOptions(invocation.agent, {
          mode: 'fork',
          ...input,
        }))
        await rememberBinding(invocation.agent, attachment, input.preset)
        return { kind: 'success', text: attachmentSummary('fork', attachment) }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'omp-rpc /omp-fork')

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: OMP_OPEN_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => serveOmpOpen(request, {
        resolveTranscript,
        ...config.cwd === undefined ? {} : { defaultCwd: config.cwd },
        ...config.preset === undefined ? {} : { defaultProfile: config.preset },
        async openAgent(input) {
          const controller = connectionCtx.get('sessionController')
          if (controller === undefined) {
            throw new OmpResumeError(
              'omp/session-controller-unavailable',
              'The session controller is not mounted; pass an existing live sessionId instead.',
              503,
            )
          }
          if (input.sessionId !== undefined) {
            const resolved = await controller.resolveAgent(SessionId(input.sessionId))
            if ('error' in resolved) {
              throw new OmpResumeError(
                resolved.error.code,
                resolved.error.message,
                resolved.error.code === 'session/not-found' ? 404 : 409,
              )
            }
            return { agent: resolved.agent }
          }
          try {
            const created = await controller.create({
              cwd: input.cwd,
              ...input.profile === undefined ? {} : { agentPreset: ompPresetId(input.profile) },
            })
            const resolved = await controller.resolveAgent(created.sessionId)
            if ('error' in resolved) {
              throw new OmpResumeError(resolved.error.code, resolved.error.message, 409)
            }
            return {
              agent: resolved.agent,
              ...created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset },
            }
          } catch (error: unknown) {
            if (error instanceof OmpResumeError) throw error
            throw new OmpResumeError(
              'session/create-failed',
              error instanceof Error ? error.message : String(error),
              409,
            )
          }
        },
        async openTranscript(input) {
          const opened = await openTranscript({
            agent: input.agent,
            transcript: input.transcript,
            cwd: input.cwd,
            ...input.profile === undefined ? {} : { profile: input.profile },
          })
          return { summary: opened.summary, hydrated: opened.hydrated }
        },
        logError(error) {
          connectionCtx.logger.error(`[exocortex/omp/open] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        },
      }),
    }), 'omp-rpc /api/exocortex/omp/open')
  })
}
