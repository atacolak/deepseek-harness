import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { OmpRpcClient } from '../src/client.ts'

interface Harness {
  readonly client: OmpRpcClient
  /** Frames the client wrote toward the OMP process. */
  readonly written: string[]
  /** Push one frame from the OMP process toward the client. */
  readonly receive: (frame: unknown) => void
  /** Close the OMP-to-client stream, as process exit does. */
  readonly end: () => void
}

function harness(): Harness {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const written: string[] = []
  outbound.setEncoding('utf8')
  let pendingText = ''
  outbound.on('data', (chunk: string) => {
    pendingText += chunk
    let newline = pendingText.indexOf('\n')
    while (newline !== -1) {
      written.push(pendingText.slice(0, newline))
      pendingText = pendingText.slice(newline + 1)
      newline = pendingText.indexOf('\n')
    }
  })
  const client = new OmpRpcClient({ input: inbound, output: outbound })
  return {
    client,
    written,
    receive: (frame) => { inbound.write(`${JSON.stringify(frame)}\n`) },
    end: () => { inbound.end() },
  }
}

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setImmediate(() => { resolve(undefined) })
  return promise.then(() => {})
}

describe('OmpRpcClient correlation', () => {
  it('resolves a request with the data of its matching response id', async () => {
    const io = harness()
    const pending = io.client.request({ type: 'get_state' })
    await tick()

    const command = JSON.parse(io.written[0] ?? '{}') as { id?: string; type?: string }
    expect(command.type).toBe('get_state')
    expect(typeof command.id).toBe('string')

    io.receive({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 's-1' } })
    await expect(pending).resolves.toEqual({ sessionId: 's-1' })
  })
})

describe('OmpRpcClient failure and closure', () => {
  it('rejects a request with the failure text of its response', async () => {
    const io = harness()
    const pending = io.client.request({ type: 'set_model', provider: 'cpa', modelId: 'nope' })
    await tick()
    const command = JSON.parse(io.written[0] ?? '{}') as { id?: string }
    io.receive({ id: command.id, type: 'response', command: 'set_model', success: false, error: 'unknown model' })
    await expect(pending).rejects.toThrow('unknown model')
  })

  it('rejects every pending request when the process stream closes', async () => {
    const io = harness()
    const first = io.client.request({ type: 'get_state' })
    const second = io.client.request({ type: 'get_available_models' })
    await tick()
    io.end()
    await expect(first).rejects.toThrow('OMP RPC connection closed')
    await expect(second).rejects.toThrow('OMP RPC connection closed')
  })
})

describe('OmpRpcClient protocol v2', () => {
  it('negotiates v2 when the process advertises it', async () => {
    const io = harness()
    const negotiated = io.client.negotiateProtocol()
    io.receive({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 })
    await tick()
    const command = JSON.parse(io.written[0] ?? '{}') as { id?: string; type?: string; protocolVersion?: number }
    expect(command).toMatchObject({ type: 'negotiate_protocol', protocolVersion: 2 })
    io.receive({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } })
    await expect(negotiated).resolves.toBe(2)
    expect(io.client.protocol).toBe(2)
  })

  it('stays on v1 when the process offers only v1', async () => {
    const io = harness()
    const negotiated = io.client.negotiateProtocol()
    io.receive({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576 })
    await expect(negotiated).resolves.toBe(1)
    expect(io.written).toEqual([])
  })

  it('reassembles a logical frame from ordered chunks', async () => {
    const io = harness()
    const seen: string[] = []
    io.client.onFrame((frame) => { seen.push(frame.type) })
    const logical = {
      type: 'message_end',
      messageId: 'm-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1_200_000) }] },
    }
    const bytes = Buffer.from(JSON.stringify(logical), 'utf8')
    const payload = 256 * 1024
    const count = Math.ceil(bytes.length / payload)
    for (let index = 0; index < count; index += 1) {
      io.receive({
        type: 'rpc_chunk',
        chunkId: 'chunk-1',
        index,
        count,
        byteLength: bytes.length,
        data: bytes.subarray(index * payload, (index + 1) * payload).toString('base64'),
      })
    }
    await tick()
    expect(seen).toEqual(['message_end'])
  })

  it('surfaces one transport error and drops the partial sequence on a gap', async () => {
    const io = harness()
    const seen: Record<string, unknown>[] = []
    io.client.onFrame((frame) => { seen.push(frame as unknown as Record<string, unknown>) })
    io.receive({
      type: 'rpc_chunk',
      chunkId: 'chunk-2',
      index: 0,
      count: 2,
      byteLength: 2 * 1024 * 1024,
      data: Buffer.from('{"type":"agent_start"}').toString('base64'),
    })
    io.receive({
      type: 'rpc_chunk',
      chunkId: 'chunk-2',
      index: 1,
      count: 2,
      byteLength: 2 * 1024 * 1024,
      data: Buffer.from(' ').toString('base64'),
    })
    await tick()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'rpc_frame_error' })
  })
})

describe('OmpRpcClient frames', () => {
  it('forwards non-response frames until the listener unsubscribes', async () => {
    const io = harness()
    const seen: string[] = []
    const off = io.client.onFrame((frame) => { seen.push(frame.type) })
    io.receive({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 })
    io.receive({ type: 'agent_start' })
    await tick()
    expect(seen).toEqual(['ready', 'agent_start'])
    off()
    io.receive({ type: 'agent_end' })
    await tick()
    expect(seen).toEqual(['ready', 'agent_start'])
  })

  it('writes a raw frame to the process', async () => {
    const io = harness()
    io.client.send({ type: 'host_tool_result', id: 'h-1', result: { content: [{ type: 'text', text: 'ok' }] } })
    await tick()
    expect(JSON.parse(io.written[0] ?? '{}')).toEqual({
      type: 'host_tool_result',
      id: 'h-1',
      result: { content: [{ type: 'text', text: 'ok' }] },
    })
  })
})
