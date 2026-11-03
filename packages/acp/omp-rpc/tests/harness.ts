import { PassThrough } from 'node:stream'
import { OmpRpcClient } from '../src/client.ts'

/** One in-memory OMP RPC endpoint plus the frames each direction carried. */
export interface RpcHarness {
  readonly client: OmpRpcClient
  /** Frames the client wrote toward the OMP process. */
  readonly written: string[]
  /** Push one frame from the OMP process toward the client. */
  readonly receive: (frame: unknown) => void
  /** Close the OMP-to-client stream, as process exit does. */
  readonly end: () => void
}

function splitLines(onLine: (line: string) => void): (chunk: string) => void {
  let buffered = ''
  return (chunk) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      onLine(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
}

/** Build one in-memory RPC endpoint. */
export function rpcHarness(): RpcHarness {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const written: string[] = []
  outbound.setEncoding('utf8')
  outbound.on('data', splitLines((line) => { written.push(line) }))
  return {
    client: new OmpRpcClient({ input: inbound, output: outbound }),
    written,
    receive: (frame) => { inbound.write(`${JSON.stringify(frame)}\n`) },
    end: () => { inbound.end() },
  }
}

/** Yield to the event loop so stream writes settle. */
export function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setImmediate(() => { resolve(undefined) })
  return promise.then(() => {})
}

/** Parse one written frame, failing loudly when the client wrote nothing. */
export function frameAt(written: readonly string[], index: number): Record<string, unknown> {
  const line = written[index]
  if (line === undefined) throw new Error(`no frame written at index ${index}`)
  return JSON.parse(line) as Record<string, unknown>
}
