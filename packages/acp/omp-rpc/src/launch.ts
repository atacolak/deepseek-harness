import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OmpRpcClient } from './client.ts'
import type { OmpRpcFrame, OmpRpcReadyFrame } from './types.ts'

/** The one protocol version this bridge implements. */
export const OMP_RPC_PROTOCOL_VERSION = 1

/** Everything needed to start one OMP RPC process; no ambient defaults are applied. */
export interface OmpLaunchSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Grace period handed to the subprocess provider for termination escalation. */
  readonly graceMs?: number | undefined
}

/** A launched OMP process and the RPC client speaking to it. */
export interface LaunchedOmp {
  readonly client: OmpRpcClient
  /** Resolves once the process announces a compatible protocol version. */
  readonly ready: Promise<OmpRpcReadyFrame>
  /** Settles with the process exit facts; rejects only on spawn/provider failure. */
  readonly exited: Promise<SubprocessOutcome>
  /** Ends the request stream, then terminates the process when it does not exit within the grace period. */
  close(): Promise<void>
}

const DEFAULT_GRACE_MS = 2_000

function isReadyFrame(frame: OmpRpcFrame): frame is OmpRpcReadyFrame {
  return frame.type === 'ready'
}

/**
 * Start an OMP process in RPC mode and attach a client to its pipes.
 *
 * The child is spawned by the configured subprocess provider, so the same
 * bridge works for a local host and a remote execution world. A process whose
 * announced protocol version is not the one this bridge implements fails the
 * `ready` promise instead of being driven half-compatible.
 * @param runtime - the host subprocess provider.
 * @param spec - executable, arguments, directory, environment, and grace.
 * @returns the client, the readiness promise, exit facts, and a bounded close.
 */
export function launchOmp(runtime: SubprocessRuntime, spec: OmpLaunchSpec): LaunchedOmp {
  const handle: SubprocessHandle = runtime.spawn({
    argv: spec.argv,
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
    graceMs: spec.graceMs ?? DEFAULT_GRACE_MS,
    ...spec.env === undefined ? {} : { env: { ...spec.env } },
  })
  const stdin = handle.stdin as (NodeJS.WritableStream & { writableEnded?: boolean }) | undefined
  const stdout = handle.stdout as NodeJS.ReadableStream | undefined
  if (stdin === undefined || stdout === undefined) {
    handle.terminate()
    throw new Error('OMP RPC launch requires piped stdin and stdout')
  }
  const client = new OmpRpcClient({ input: stdout, output: stdin })
  const exited = handle.done

  const ready = new Promise<OmpRpcReadyFrame>((resolve, reject) => {
    const stop = client.onFrame((frame: OmpRpcFrame): void => {
      if (!isReadyFrame(frame)) return
      stop()
      resolve(frame)
    })
    exited.then(
      () => { reject(new Error('OMP exited before announcing its RPC protocol')) },
      (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })

  return {
    client,
    ready,
    exited,
    async close(): Promise<void> {
      if (!stdin.writableEnded) stdin.end()
      const grace = spec.graceMs ?? DEFAULT_GRACE_MS
      const exitedInTime = await Promise.race([
        exited.then(() => true, () => true),
        new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, grace).unref() }),
      ])
      if (!exitedInTime) handle.terminate()
      await ready.catch(() => {})
    },
  }
}
