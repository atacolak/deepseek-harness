/**
 * Cordis composition of the OMP RPC bridge: `/omp-attach` and `/omp-fork`
 * commands, per-agent step streams, host tools, extension UI, catalog sync,
 * and trajectory projection.
 * @module @deepseek-ai/dsh-omp-rpc
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import {
  OmpBridge,
  ompSessionDir,
  parseOmpCommandInput,
  type OmpAttachOptions,
  type OmpAttachment,
} from './bridge.ts'
import { DEFAULT_OMP_HOST_TOOLS } from './cordis-tools.ts'
import type { OmpUiAsker } from './ui.ts'
import type { OmpExtensionUiRequest } from './types.ts'

export * from './bridge.ts'
export * from './catalog.ts'
export * from './client.ts'
export * from './cordis-tools.ts'
export * from './driver.ts'
export * from './host-tools.ts'
export * from './launch.ts'
export * from './presets.ts'
export * from './ui.ts'
export * from './types.ts'

export const DEFAULT_SESSION_DIR = join(homedir(), '.dsh', 'omp', 'sessions')

export const name = 'omp-rpc'
export const inject = ['commands', 'subprocess', 'tools']

/** Plugin configuration for the OMP bridge. */
export interface OmpRpcConfig {
  /** OMP executable name or absolute path. */
  readonly executable?: string
  /** Root directory for per-session OMP transcript directories. */
  readonly sessionDir?: string
  /** Default `<agent>.md` profile passed as `--agent`. */
  readonly preset?: string
  /** Harness tools published to every OMP process. */
  hostTools?: string[]
  /** Working directory when a session header does not record one. */
  readonly cwd?: string
  /** Optional extension UI answerer supplied by a composed surface. */
  readonly asker?: OmpUiAsker
  /** Receives non-interactive OMP extension UI surfaces. */
  readonly onSurface?: (request: OmpExtensionUiRequest) => void
}

export const Config: Schema<OmpRpcConfig> = Schema.object({
  executable: Schema.string(),
  sessionDir: Schema.string(),
  preset: Schema.string(),
  hostTools: Schema.array(Schema.string()),
  cwd: Schema.string(),
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

/**
 * Mount the OMP bridge and its two human commands.
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

  const attachOptions = (agent: Parameters<typeof bridge.attach>[0], options: {
    readonly mode: OmpAttachOptions['mode']
    readonly preset?: string
    readonly sessionId?: string
  }): OmpAttachOptions => {
    const cwd = agent.session.header.cwd ?? config.cwd
    if (cwd === undefined) throw new Error('OMP bridge has no working directory: set omp-rpc cwd or start the session in one')
    const preset = options.preset ?? config.preset
    return {
      ...options,
      ...preset === undefined ? {} : { preset },
      sessionDir: ompSessionDir(config.sessionDir ?? DEFAULT_SESSION_DIR, agent.id),
      hostTools: config.hostTools ?? DEFAULT_OMP_HOST_TOOLS,
      cwd,
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'omp-attach',
    description: 'Attach this session to an OMP RPC process and continue its existing transcript.',
    input: { hint: '<preset> [session]' },
    async handler(invocation) {
      try {
        const input = parseOmpCommandInput(invocation.rawInput)
        const attachment = await bridge.attach(invocation.agent, attachOptions(invocation.agent, {
          mode: 'attach',
          ...input,
        }))
        return { kind: 'success', text: attachmentSummary('attach', attachment) }
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
        return { kind: 'success', text: attachmentSummary('fork', attachment) }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'omp-rpc /omp-fork')
}
