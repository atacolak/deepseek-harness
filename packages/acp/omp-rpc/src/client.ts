import { randomUUID } from 'node:crypto'
import type {
  OmpExtensionUiResponse,
  OmpHostToolResultFrame,
  OmpHostToolUpdateFrame,
  OmpRpcChunkFrame,
  OmpRpcCommand,
  OmpRpcFrame,
  OmpRpcIo,
  OmpRpcReadyFrame,
  OmpRpcResponseFrame,
} from './types.ts'

/** Frames a bridge may write that are not commands. */
export type OmpOutboundFrame = OmpHostToolResultFrame | OmpHostToolUpdateFrame | OmpExtensionUiResponse

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Maximum UTF-8 size of one logical frame reassembled from protocol-v2 chunks. */
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024
/** Raw payload size OMP uses for one chunk before base64 transport encoding. */
const CHUNK_PAYLOAD_BYTES = 256 * 1024
/** Header and metadata allowance for one physical JSONL line. */
const MAX_FRAME_BYTES = 1024 * 1024

/** Chunks of one logical frame, concatenated in index order before parsing. */
interface PendingChunks {
  readonly chunkId: string
  readonly count: number
  readonly byteLength: number
  nextIndex: number
  readonly parts: Buffer[]
  receivedBytes: number
}

function decodeChunkData(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0) throw new Error('invalid rpc chunk data')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new Error('invalid rpc chunk data')
  return bytes
}

/** One command/response client over an OMP RPC byte path. */
export class OmpRpcClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(frame: OmpRpcFrame) => void>()
  private readonly output: OmpRpcIo['output']
  private readonly handshake = Promise.withResolvers<OmpRpcReadyFrame>()
  private buffered = ''
  private chunks: PendingChunks | undefined
  private protocolVersion = 1
  private readyResolved = false

  constructor(io: OmpRpcIo) {
    this.output = io.output
    io.input.setEncoding('utf8')
    io.input.on('data', (chunk: string) => { this.consume(chunk) })
    io.input.on('end', () => { this.abandon('OMP RPC connection closed') })
    io.input.on('close', () => { this.abandon('OMP RPC connection closed') })
  }

  /** The ready frame this process announced, once it arrives. */
  get ready(): Promise<OmpRpcReadyFrame> {
    return this.handshake.promise
  }

  /** Negotiated protocol version; starts at 1 until {@link negotiateProtocol} succeeds. */
  get protocol(): number {
    return this.protocolVersion
  }

  /**
   * Negotiate the highest shared protocol version, preferring lossless v2.
   * @returns the negotiated version, or 1 when the process offers only v1.
   */
  async negotiateProtocol(): Promise<number> {
    const ready = await this.handshake.promise
    if (this.protocolVersion === 2 || !ready.supportedProtocolVersions.includes(2)) return this.protocolVersion
    await this.request({ type: 'negotiate_protocol', protocolVersion: 2 })
    this.protocolVersion = 2
    return 2
  }

  /**
   * Send one command and resolve with its response data.
   * @param command - command frame; an absent `id` is minted here.
   * @returns the response's `data`, rejecting for a failed response.
   */
  request(command: OmpRpcCommand): Promise<unknown> {
    const id = command.id ?? randomUUID()
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    this.pending.set(id, { resolve, reject })
    this.write({ ...command, id })
    return promise
  }

  /**
   * Observe every inbound frame this client does not consume itself.
   * @param listener - receives ready, chunk, and event frames in arrival order.
   * @returns a function that stops delivery to this listener.
   */
  onFrame(listener: (frame: OmpRpcFrame) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Write one non-command frame to the OMP process.
   * @param frame - host tool result/update or extension UI response.
   */
  send(frame: OmpOutboundFrame): void {
    this.write(frame)
  }

  private abandon(message: string): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.reject(new Error(message))
  }

  private write(frame: object): void {
    this.output.write(`${JSON.stringify(frame)}\n`)
  }

  private consume(chunk: string): void {
    this.buffered += chunk
    let newline = this.buffered.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      this.dispatch(line)
      newline = this.buffered.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    if (line.trim().length === 0) return
    let frame: OmpRpcFrame
    try {
      frame = JSON.parse(line) as OmpRpcFrame
    } catch {
      return
    }
    this.accept(frame)
  }

  private accept(frame: OmpRpcFrame): void {
    if (frame.type === 'rpc_chunk') {
      const reassembled = this.reassemble(frame as OmpRpcChunkFrame)
      if (reassembled === undefined) return
      this.accept(reassembled)
      return
    }
    if (frame.type === 'ready') {
      if (!this.readyResolved) {
        this.readyResolved = true
        this.handshake.resolve(frame as OmpRpcReadyFrame)
      }
      this.publish(frame)
      return
    }
    if (frame.type === 'response') {
      this.settle(frame as OmpRpcResponseFrame)
      return
    }
    this.publish(frame)
  }

  /**
   * Accumulate one protocol-v2 fragment and return the logical frame once complete.
   * A malformed sequence drops the in-flight frame and surfaces one transport
   * error frame; no partial object reaches a listener.
   */
  private reassemble(chunk: OmpRpcChunkFrame): OmpRpcFrame | undefined {
    try {
      const { chunkId, index, count, byteLength } = chunk
      if (
        typeof chunkId !== 'string' || chunkId.length === 0 || chunkId.length > 128
        || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength)
        || index < 0 || count < 2 || count > Math.ceil(MAX_REASSEMBLED_FRAME_BYTES / CHUNK_PAYLOAD_BYTES)
        || index >= count || byteLength < MAX_FRAME_BYTES || byteLength > MAX_REASSEMBLED_FRAME_BYTES
      ) throw new Error('invalid rpc chunk metadata')
      const bytes = decodeChunkData(chunk.data)
      if (bytes.byteLength > CHUNK_PAYLOAD_BYTES) throw new Error('rpc chunk payload exceeds the transport limit')
      if (this.chunks === undefined) {
        if (index !== 0) throw new Error('rpc chunk sequence must start at index 0')
        this.chunks = { chunkId, count, byteLength, nextIndex: 0, parts: [], receivedBytes: 0 }
      }
      const pending = this.chunks
      if (
        pending.chunkId !== chunkId || pending.count !== count
        || pending.byteLength !== byteLength || pending.nextIndex !== index
      ) throw new Error('rpc chunk sequence mismatch')
      pending.parts.push(bytes)
      pending.receivedBytes += bytes.byteLength
      pending.nextIndex += 1
      if (pending.receivedBytes > pending.byteLength) throw new Error('rpc chunk sequence exceeds declared length')
      if (pending.nextIndex < pending.count) return undefined
      if (pending.receivedBytes !== pending.byteLength) throw new Error('rpc chunk sequence length mismatch')
      this.chunks = undefined
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.parts))
      const frame: unknown = JSON.parse(decoded)
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('rpc frame must be an object')
      return frame as OmpRpcFrame
    } catch (error: unknown) {
      this.chunks = undefined
      this.publish({
        type: 'rpc_frame_error',
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private publish(frame: OmpRpcFrame): void {
    for (const listener of [...this.listeners]) listener(frame)
  }

  private settle(response: OmpRpcResponseFrame): void {
    const id = response.id
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (response.success) {
      pending.resolve(response.data)
      return
    }
    pending.reject(new Error(response.error ?? `OMP command "${response.command}" failed`))
  }
}
