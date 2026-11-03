import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OmpAgentDriver, OmpEventTranslator, renderMessages } from '../src/driver.ts'
import type { OmpAgentEvent, OmpRpcCommand, OmpRpcFrame } from '../src/types.ts'

class FakeClient {
  readonly commands: OmpRpcCommand[] = []
  private readonly listeners = new Set<(frame: OmpRpcFrame) => void>()
  private readonly pending: Array<(value: unknown) => void> = []

  request(command: OmpRpcCommand): Promise<unknown> {
    this.commands.push(command)
    return new Promise((resolve) => { this.pending.push(resolve) })
  }

  onFrame(listener: (frame: OmpRpcFrame) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(frame: OmpAgentEvent): void {
    for (const listener of [...this.listeners]) listener(frame)
  }

  settle(value: unknown = {}): void {
    const next = this.pending.shift()
    if (next === undefined) throw new Error('no pending OMP command')
    next(value)
  }

  promptText(index: number): string {
    const prompt = this.commands.filter(command => command.type === 'prompt')[index]
    return String(prompt?.message)
  }
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

function promptId(client: FakeClient): string | undefined {
  return client.commands.filter(command => command.type === 'prompt').at(-1)?.id
}

function settlePrompt(client: FakeClient, status: 'completed' | 'aborted' | 'error' = 'completed', message?: string): void {
  client.emit({
    type: 'prompt_result',
    id: promptId(client),
    agentInvoked: true,
    status,
    sessionSettled: true,
    ...message === undefined ? {} : { error: { message } },
  })
}

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return { provider: 'omp', model: 'omp', messages }
}

const user = (id: string, text: string): GenerateOptions['messages'][number] => ({
  role: 'user',
  content: [{ type: 'text', text }],
  id: id as never,
  source: { kind: 'user' },
})

const assistant = (id: string, text: string): GenerateOptions['messages'][number] => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  id: id as never,
  source: { kind: 'model', provider: 'omp', model: 'omp' },
})

function messageUpdate(messageId: string, assistantMessageEvent: object, message: object): OmpAgentEvent {
  return { type: 'message_update', messageId, assistantMessageEvent, message }
}


function assistantMessage(text: string, stopReason: string, usage: object): object {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason, usage }
}

describe('OmpEventTranslator', () => {
  it('streams text deltas as one text block and settles from the final message', () => {
    const translator = new OmpEventTranslator()
    const usage = { input: 12, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 19 }
    const chunks = [
      ...translator.push(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', usage))),
      ...translator.push(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'Hel' }, assistantMessage('Hel', 'stop', usage))),
      ...translator.push(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'lo' }, assistantMessage('Hello', 'stop', usage))),
      ...translator.push(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'Hello' }, assistantMessage('Hello', 'stop', usage))),
      ...translator.finish(),
    ]
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, totalTokens: 19 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('keeps thinking and reply text in separate blocks', () => {
    const translator = new OmpEventTranslator()
    const message = (thinking: string, text: string): object => ({
      role: 'assistant',
      content: [{ type: 'thinking', thinking }, { type: 'text', text }],
      stopReason: 'stop',
      usage: { input: 1, output: 2 },
    })
    const chunks = [
      ...translator.push(messageUpdate('m2', { type: 'thinking_start', contentIndex: 0 }, message('', ''))),
      ...translator.push(messageUpdate('m2', { type: 'thinking_delta', contentIndex: 0, delta: 'plan' }, message('plan', ''))),
      ...translator.push(messageUpdate('m2', { type: 'thinking_end', contentIndex: 0, content: 'plan' }, message('plan', ''))),
      ...translator.push(messageUpdate('m2', { type: 'text_start', contentIndex: 1 }, message('plan', ''))),
      ...translator.push(messageUpdate('m2', { type: 'text_delta', contentIndex: 1, delta: 'done' }, message('plan', 'done'))),
      ...translator.push(messageUpdate('m2', { type: 'text_end', contentIndex: 1, content: 'done' }, message('plan', 'done'))),
      ...translator.finish(),
    ]
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-start', index: 1, blockType: 'text' },
    ])
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
    ])
  })

  it('drops tool-call blocks OMP already executed and settles a tool-use stop as stop', () => {
    const translator = new OmpEventTranslator()
    const message = (): object => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp' } }],
      stopReason: 'toolUse',
      usage: { input: 1, output: 1 },
    })
    const chunks = [
      ...translator.push(messageUpdate('m3', { type: 'toolcall_start', contentIndex: 0 }, message())),
      ...translator.push(messageUpdate('m3', { type: 'toolcall_delta', contentIndex: 0, delta: '{"path"' }, message())),
      ...translator.push(messageUpdate('m3', { type: 'toolcall_end', contentIndex: 0 }, message())),
      ...translator.finish(),
    ]
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('reports an errored run with the process failure text', () => {
    const translator = new OmpEventTranslator()
    const chunks = [
      ...translator.push(messageUpdate('m4', {
        type: 'error',
        reason: 'error',
        error: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'upstream exploded', usage: { input: 2, output: 0 } },
      }, {})),
      ...translator.finish({ status: 'error', message: 'upstream exploded' }),
    ]
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'upstream exploded' } },
    })
  })

  it('continues through per-message done events and settles once for the run', () => {
    const translator = new OmpEventTranslator()
    const first = [
      ...translator.push(messageUpdate('m5', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'toolUse', { input: 1, output: 1 }))),
      ...translator.push(messageUpdate('m5', { type: 'text_delta', contentIndex: 0, delta: 'step one' }, assistantMessage('step one', 'toolUse', { input: 1, output: 1 }))),
      ...translator.push(messageUpdate('m5', { type: 'text_end', contentIndex: 0, content: 'step one' }, assistantMessage('step one', 'toolUse', { input: 1, output: 1 }))),
      ...translator.push(messageUpdate('m5', { type: 'done', reason: 'toolUse', message: assistantMessage('step one', 'toolUse', { input: 1, output: 1 }) }, assistantMessage('step one', 'toolUse', { input: 1, output: 1 }))),
    ]
    expect(first.filter(chunk => chunk.type === 'finish')).toEqual([])
    const second = [
      ...translator.push(messageUpdate('m6', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 2, output: 2 }))),
      ...translator.push(messageUpdate('m6', { type: 'text_delta', contentIndex: 0, delta: 'step two' }, assistantMessage('step two', 'stop', { input: 2, output: 2 }))),
      ...translator.push(messageUpdate('m6', { type: 'text_end', contentIndex: 0, content: 'step two' }, assistantMessage('step two', 'stop', { input: 2, output: 2 }))),
      ...translator.push(messageUpdate('m6', { type: 'done', reason: 'stop', message: assistantMessage('step two', 'stop', { input: 2, output: 2 }) }, assistantMessage('step two', 'stop', { input: 2, output: 2 }))),
      ...translator.finish({ status: 'completed' }),
    ]
    expect(second.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 1, block: { type: 'text', text: 'step two' } },
    ])
    expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})

describe('renderMessages', () => {
  it('renders every message from the requested index with its role', () => {
    const text = renderMessages([user('u1', 'first'), assistant('a1', 'reply'), user('u2', 'second')], 1)
    expect(text).toBe('<assistant>\nreply\n</assistant>\n\n<user>\nsecond\n</user>')
  })
})

describe('OmpAgentDriver', () => {
  it('replays the history once and then sends only new messages', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const first = request([user('u1', 'hello')])

    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(first, new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    await tick()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_delta', contentIndex: 0, delta: 'hi' }, assistantMessage('hi', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'hi' }, assistantMessage('hi', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    const chunks = await consume

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(client.commands.map(command => command.type)).toEqual(['new_session', 'prompt'])
    expect(client.promptText(0)).toBe('<user>\nhello\n</user>')

    const second = request([...first.messages, assistant('a1', 'hi'), user('u2', 'again')])
    const consumeAgain = (async () => {
      for await (const _chunk of driver.stream(second, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.emit(messageUpdate('m2', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m2', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    await consumeAgain
    expect(client.commands.filter(command => command.type === 'new_session')).toHaveLength(1)
    expect(client.promptText(1)).toBe('<user>\nagain\n</user>')
  })

  it('restarts a replay session when the assembled history shrinks', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const first = request([user('u1', 'one'), assistant('a1', 'two'), user('u2', 'three')])
    const consume = (async () => {
      for await (const _chunk of driver.stream(first, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    await tick()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    await consume

    const compacted = request([user('u9', 'fresh start')])
    const consumeCompacted = (async () => {
      for await (const _chunk of driver.stream(compacted, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    await tick()
    client.emit(messageUpdate('m2', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m2', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    await consumeCompacted
    expect(client.commands.filter(command => command.type === 'new_session')).toHaveLength(2)
    expect(client.promptText(1)).toBe('<user>\nfresh start\n</user>')
  })

  it('sends only the newest user message when attaching to an existing session', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client, { transcript: 'latest' })
    const attached = request([user('u1', 'old'), assistant('a1', 'old reply'), user('u2', 'new question')])
    const consume = (async () => {
      for await (const _chunk of driver.stream(attached, new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.emit(messageUpdate('m1', { type: 'text_start', contentIndex: 0 }, assistantMessage('', 'stop', { input: 1, output: 1 })))
    client.emit(messageUpdate('m1', { type: 'text_end', contentIndex: 0, content: 'ok' }, assistantMessage('ok', 'stop', { input: 1, output: 1 })))
    client.settle()
    settlePrompt(client)
    await consume
    expect(client.commands.map(command => command.type)).toEqual(['prompt'])
    expect(client.promptText(0)).toBe('<user>\nnew question\n</user>')
  })

  it('settles an errored run from prompt_result even without a terminal message error', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(request([user('u1', 'hello')]), new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    await tick()
    client.settle()
    settlePrompt(client, 'error', 'gateway overloaded')
    const chunks = await consume
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'gateway overloaded' } },
    })
  })

  it('closes a local-only prompt from its agentInvoked response', async () => {
    const client = new FakeClient()
    const driver = new OmpAgentDriver(client)
    const consume = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of driver.stream(request([user('u1', '/status')]), new AbortController().signal)) chunks.push(chunk)
      return chunks
    })()
    await tick()
    client.settle()
    await tick()
    client.settle({ agentInvoked: false })
    const chunks = await consume
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('projects OMP tool executions in order', async () => {
    const client = new FakeClient()
    const events: unknown[] = []
    const driver = new OmpAgentDriver(client, { onTool: (event) => { events.push(event) } })
    const consume = (async () => {
      for await (const _chunk of driver.stream(request([user('u1', 'use a tool')]), new AbortController().signal)) { /* drain */ }
    })()
    await tick()
    client.settle()
    await tick()
    client.settle()
    client.emit({ type: 'tool_execution_start', toolCallId: 't-1', toolName: 'cordis_inspect_list', args: { platform: 'host' } })
    client.emit({ type: 'tool_execution_end', toolCallId: 't-1', toolName: 'cordis_inspect_list', result: { content: [{ type: 'text', text: '[]' }] }, isError: false })
    settlePrompt(client)
    await consume
    expect(events).toEqual([
      { kind: 'start', toolCallId: 't-1', toolName: 'cordis_inspect_list', arguments: { platform: 'host' } },
      { kind: 'end', toolCallId: 't-1', toolName: 'cordis_inspect_list', content: [{ type: 'text', text: '[]' }], isError: false },
    ])
  })
})
