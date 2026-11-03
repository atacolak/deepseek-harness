import { describe, expect, it } from 'vitest'
import { OmpHostToolBridge } from '../src/host-tools.ts'
import { frameAt, rpcHarness, tick } from './harness.ts'

const readFile = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

function bridge(execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<{ content: { type: 'text'; text: string }[] }>) {
  const io = rpcHarness()
  const tools = new OmpHostToolBridge({
    client: io.client,
    tools: () => [{ definition: readFile, execute }],
  })
  return { io, tools }
}

describe('OmpHostToolBridge publication', () => {
  it('publishes the current host tool definitions to the process', async () => {
    const { io, tools } = bridge(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const publishing = tools.sync()
    await tick()
    const command = frameAt(io.written, 0)
    expect(command.type).toBe('set_host_tools')
    expect(command.tools).toEqual([readFile])
    io.receive({ id: command.id, type: 'response', command: 'set_host_tools', success: true })
    await expect(publishing).resolves.toBeUndefined()
  })
})

describe('OmpHostToolBridge execution', () => {
  it('executes a host tool call and returns its content as a result frame', async () => {
    const seen: { args: Record<string, unknown> }[] = []
    const { io } = bridge(async (args) => {
      seen.push({ args })
      return { content: [{ type: 'text', text: 'file body' }] }
    })
    io.receive({
      type: 'host_tool_call',
      id: 'call-1',
      toolCallId: 'toolu-1',
      toolName: 'read',
      arguments: { path: '/tmp/a.txt' },
    })
    await tick()
    expect(seen).toEqual([{ args: { path: '/tmp/a.txt' } }])
    expect(frameAt(io.written, 0)).toEqual({
      type: 'host_tool_result',
      id: 'call-1',
      result: { content: [{ type: 'text', text: 'file body' }] },
    })
  })

  it('reports a failing host tool as an error result carrying its message', async () => {
    const { io } = bridge(async () => { throw new Error('permission denied') })
    io.receive({
      type: 'host_tool_call',
      id: 'call-2',
      toolCallId: 'toolu-2',
      toolName: 'read',
      arguments: { path: '/etc/shadow' },
    })
    await tick()
    expect(frameAt(io.written, 0)).toEqual({
      type: 'host_tool_result',
      id: 'call-2',
      isError: true,
      result: { content: [{ type: 'text', text: 'permission denied' }] },
    })
  })

  it('aborts a running host tool call when the process cancels it', async () => {
    const aborted: boolean[] = []
    const { io } = bridge(async (_args, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted.push(true)
          resolve()
        }, { once: true })
      })
      return { content: [{ type: 'text', text: 'late' }] }
    })
    io.receive({
      type: 'host_tool_call',
      id: 'call-3',
      toolCallId: 'toolu-3',
      toolName: 'read',
      arguments: { path: '/tmp/b.txt' },
    })
    await tick()
    io.receive({ type: 'host_tool_cancel', id: 'cancel-1', targetId: 'call-3' })
    await tick()
    expect(aborted).toEqual([true])
    expect(io.written.filter(line => line.includes('host_tool_result'))).toEqual([])
  })
})
