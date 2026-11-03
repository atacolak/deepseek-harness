import { randomUUID } from 'node:crypto'
import type { FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { OmpRpcClient } from './client.ts'
import type { OmpAgentEvent, OmpPromptResultFrame, OmpRpcFrame } from './types.ts'

/** The client surface a driver needs; narrowed for tests and composition. */
export type OmpDriverClient = Pick<OmpRpcClient, 'request' | 'onFrame'>

interface OmpUsage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly totalTokens?: number
}

interface OmpContent {
  readonly type?: string
  readonly text?: string
  readonly thinking?: string
}

interface OmpAssistantMessage {
  readonly content?: readonly OmpContent[]
  readonly usage?: OmpUsage
  readonly stopReason?: string
  readonly errorMessage?: string
}

interface OmpAssistantMessageEvent {
  readonly type: string
  readonly contentIndex?: number
  readonly delta?: string
  readonly content?: string
  readonly reason?: string
  readonly error?: OmpAssistantMessage
}

interface OmpMessageUpdate {
  readonly type: 'message_update'
  readonly assistantMessageEvent?: OmpAssistantMessageEvent
  readonly message?: OmpAssistantMessage
}

/**
 * Frames one open assistant block accumulates until its end event.
 * `text` and `reasoning` blocks stream deltas; tool calls never reach the
 * harness because OMP executes bridged host tools inside its own run.
 */
type OpenBlock = { readonly kind: 'text' | 'reasoning' }

/** One content block OMP reports for an executed tool. */
export interface OmpToolContentBlock {
  readonly type?: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** One OMP-executed tool step, projected for the harness trajectory ledger. */
export type OmpToolEvent =
  | {
    readonly kind: 'start'
    readonly toolCallId: string
    readonly toolName: string
    readonly arguments: Record<string, unknown>
  }
  | {
    readonly kind: 'end'
    readonly toolCallId: string
    readonly toolName: string
    readonly content: readonly OmpToolContentBlock[]
    readonly isError: boolean
  }

/** Terminal status carried by `prompt_result`, independent of its wire shape. */
export interface OmpPromptOutcome {
  readonly status: 'completed' | 'aborted' | 'error'
  readonly message?: string
}

/** Finish text for an OMP run whose terminal event carried no details. */
const UNKNOWN_FAILURE = 'the OMP run ended without a terminal assistant message'

/**
 * Map OMP RPC assistant events onto the harness chunk vocabulary.
 *
 * OMP owns its own agent loop and may execute several assistant messages in
 * one prompt, so a per-message `done` only closes that message's blocks. The
 * run settles once, driven by the prompt's terminal `prompt_result`.
 */
export class OmpEventTranslator {
  private readonly open = new Map<number, OpenBlock>()
  private readonly indexes = new Map<number, number>()
  private nextIndex = 0
  private message: OmpAssistantMessage | undefined
  private failure: OmpAssistantMessage | undefined
  private settled = false

  /**
   * Translate one inbound process event.
   * @param frame - any inbound frame; events other than message updates are ignored.
   * @returns chunks to publish, in order.
   */
  push(frame: OmpRpcFrame | OmpAgentEvent): StreamChunk[] {
    if (frame.type !== 'message_update') return []
    const update = frame as unknown as OmpMessageUpdate
    const event = update.assistantMessageEvent
    if (event === undefined || this.settled) return []
    if (update.message !== undefined) this.message = update.message
    if (event.error !== undefined) {
      this.message = event.error
      this.failure = event.error
    }
    if (event.type === 'error') {
      this.closeOpen()
      return []
    }
    if (event.type === 'done') {
      this.closeOpen()
      return []
    }
    return this.stream(event)
  }

  /**
   * Close anything still open and settle the run exactly once.
   * Callers invoke this when the prompt's `prompt_result` arrives.
   * @param outcome - the prompt's terminal status, when the process reported one.
   * @returns the remaining chunks, ending in usage and finish.
   */
  finish(outcome?: OmpPromptOutcome): StreamChunk[] {
    if (this.settled) return []
    const chunks = this.settle()
    const finish = chunks.at(-1)
    if (finish?.type === 'finish' && outcome !== undefined) {
      finish.reason = outcome.status === 'aborted'
        ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'the OMP run was aborted' } }
        : outcome.status === 'error'
          ? { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: outcome.message ?? this.failure?.errorMessage ?? UNKNOWN_FAILURE } }
          : finish.reason
    }
    return chunks
  }

  private closeOpen(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    for (const [contentIndex, open] of [...this.open]) {
      chunks.push({
        type: 'block-end',
        index: this.indexes.get(contentIndex) ?? 0,
        block: open.kind === 'text'
          ? { type: 'text', text: this.blockText(contentIndex, 'text') }
          : { type: 'reasoning', text: this.blockText(contentIndex, 'reasoning') },
      })
    }
    this.open.clear()
    this.indexes.clear()
    return chunks
  }

  private stream(event: OmpAssistantMessageEvent): StreamChunk[] {
    if (event.contentIndex === undefined) return []
    if (event.type === 'text_start' || event.type === 'thinking_start') {
      const existing = this.open.get(event.contentIndex)
      if (existing !== undefined) return []
      const kind = event.type === 'text_start' ? 'text' : 'reasoning'
      const index = this.nextIndex
      this.nextIndex += 1
      this.open.set(event.contentIndex, { kind })
      this.indexes.set(event.contentIndex, index)
      return [{ type: 'block-start', index, blockType: kind }]
    }
    const open = this.open.get(event.contentIndex)
    if (open === undefined) return []
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const kind = event.type === 'text_delta' ? 'text' : 'reasoning'
      if (kind !== open.kind) return []
      const text = event.delta ?? ''
      if (text.length === 0) return []
      const block = this.indexes.get(event.contentIndex) ?? 0
      return [event.type === 'text_delta'
        ? { type: 'text-delta', index: block, text }
        : { type: 'reasoning-delta', index: block, text }]
    }
    if (event.type === 'text_end' || event.type === 'thinking_end') {
      const kind = event.type === 'text_end' ? 'text' : 'reasoning'
      if (kind !== open.kind) return []
      const index = this.indexes.get(event.contentIndex) ?? 0
      this.open.delete(event.contentIndex)
      this.indexes.delete(event.contentIndex)
      const text = event.content ?? this.blockText(event.contentIndex, kind)
      return [{ type: 'block-end', index, block: kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text } }]
    }
    return []
  }

  private settle(): StreamChunk[] {
    this.settled = true
    const chunks = this.closeOpen()
    const usage = usageOf(this.message?.usage)
    if (usage !== undefined) chunks.push({ type: 'usage', usage })
    chunks.push({ type: 'finish', reason: finishOf(this.message?.stopReason, this.failure ?? this.message) })
    return chunks
  }

  private blockText(contentIndex: number, kind: 'text' | 'reasoning'): string {
    const content = this.message?.content?.[contentIndex]
    if (content === undefined) return ''
    return (kind === 'text' ? content.text : content.thinking) ?? ''
  }
}

function usageOf(usage: OmpUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    ...usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead },
    ...usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite },
    ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
  }
}

function finishOf(reason: string | undefined, message: OmpAssistantMessage | undefined): FinishReason {
  if (reason === 'aborted') return { kind: 'aborted', failure: { code: 'ABORTED', message: 'the OMP run was aborted' } }
  if (reason === 'error') return { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: message?.errorMessage ?? UNKNOWN_FAILURE } }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function toolContentOf(value: unknown): OmpToolContentBlock[] {
  const result = objectOf(value)
  const rows = result?.content
  if (!Array.isArray(rows)) return []
  const content: OmpToolContentBlock[] = []
  for (const row of rows) {
    const block = objectOf(row)
    if (block === undefined) continue
    content.push({
      ...typeof block.type === 'string' ? { type: block.type } : {},
      ...typeof block.text === 'string' ? { text: block.text } : {},
      ...typeof block.data === 'string' ? { data: block.data } : {},
      ...typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {},
    })
  }
  return content
}

/**
 * Render the request messages a fresh OMP session has not seen yet.
 * @param messages - the assembled request history, in conversation order.
 * @param from - first index to render; earlier messages are already in the session.
 * @returns text to send as one prompt, empty when nothing new is present.
 */
export function renderMessages(messages: readonly RequestMessage[], from: number): string {
  const parts: string[] = []
  for (const message of messages.slice(from)) {
    const rendered = renderMessage(message)
    if (rendered.length > 0) parts.push(rendered)
  }
  return parts.join('\n\n')
}

function renderMessage(message: RequestMessage): string {
  if (message.role === 'system') return `<system>\n${textOf(message.content)}\n</system>`
  if (message.role === 'user') return textOf(message.content)
  if (message.role === 'assistant') return `<assistant>\n${textOf(message.content)}\n</assistant>`
  return ''
}

function textOf(content: RequestMessage['content']): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(`[tool call ${block.name} ${block.arguments}]`)
  }
  return parts.join('\n')
}

/**
 * Drive one harness agent step from a long-lived OMP RPC session.
 *
 * The first step sends the assembled history as one transcript prompt. Later
 * steps send only the messages OMP has not seen, so its own session keeps the
 * conversation. A shorter history than the delivered prefix (compaction, a
 * cleared session) restarts the process session and replays the transcript.
 * Tool-call content is deliberately not forwarded: OMP executes bridged host
 * tools inside its own run, and the harness must not execute them again.
 */
export interface OmpAgentDriverOptions {
  /**
   * How the first prompt introduces the conversation. `replay` starts a fresh
   * OMP session and sends the assembled history, which is what a fork does.
   * `latest` trusts the attached session's existing history and sends only the
   * newest user message.
   */
  readonly transcript?: 'replay' | 'latest'
  /** Observe tools OMP executes so the harness trajectory can project them. */
  readonly onTool?: (event: OmpToolEvent) => void
}

export class OmpAgentDriver {
  private delivered: number | undefined
  private readonly transcript: 'replay' | 'latest'
  private readonly onTool: ((event: OmpToolEvent) => void) | undefined

  constructor(private readonly client: OmpDriverClient, options: OmpAgentDriverOptions = {}) {
    this.transcript = options.transcript ?? 'replay'
    this.onTool = options.onTool
  }

  /**
   * Stream one step from the attached OMP session.
   * @param request - the assembled request.
   * @param signal - the step's abort signal.
   * @returns the assistant chunk stream.
   */
  async *stream(request: GenerateOptions, signal: AbortSignal): AsyncIterable<StreamChunk> {
    signal.throwIfAborted()
    if ((this.delivered === undefined && this.transcript === 'replay')
      || (this.delivered !== undefined && request.messages.length < this.delivered)) await this.restart()
    const from = this.startIndex(request.messages)
    const message = renderMessages(request.messages, from)
    const translator = new OmpEventTranslator()
    const channel = new FrameChannel()
    const promptId = randomUUID()
    let outcome: OmpPromptOutcome | undefined
    let failure: unknown
    const detach = this.client.onFrame((frame) => {
      if (frame.type === 'prompt_result') {
        const result = frame as OmpPromptResultFrame
        if (result.id !== promptId) return
        outcome = { status: result.status, ...result.error?.message === undefined ? {} : { message: result.error.message } }
        channel.close()
        return
      }
      this.projectTool(frame)
      channel.push(frame as OmpAgentEvent)
    })
    const accepted = this.client.request({ type: 'prompt', id: promptId, message: message.length > 0 ? message : '[continue]' })
      .then((data: unknown) => {
        if (objectOf(data)?.agentInvoked === false) channel.close()
      })
      .catch((error: unknown) => {
        failure = error
        channel.close()
      })
    const abort = (): void => {
      void this.client.request({ type: 'abort' }).catch(() => {})
      channel.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const frame of channel) {
        for (const chunk of translator.push(frame)) {
          signal.throwIfAborted()
          yield chunk
        }
      }
      signal.throwIfAborted()
      let finished: FinishReason | undefined
      for (const chunk of translator.finish(outcome)) {
        if (chunk.type === 'finish') finished = chunk.reason
        yield chunk
      }
      await accepted
      if (failure !== undefined) throw failure instanceof Error ? failure : new Error('OMP stream failed', { cause: failure })
      // The loop appends the assistant message this stream produced right
      // after the step, so the next request begins one entry later.
      if (finished?.kind !== 'error' && finished?.kind !== 'aborted') this.delivered = request.messages.length + 1
    } finally {
      signal.removeEventListener('abort', abort)
      detach()
    }
  }

  private projectTool(frame: OmpRpcFrame): void {
    if (this.onTool === undefined) return
    if (frame.type === 'tool_execution_start') {
      const toolCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : ''
      const toolName = typeof frame.toolName === 'string' ? frame.toolName : ''
      if (toolCallId.length === 0 || toolName.length === 0) return
      this.onTool({
        kind: 'start',
        toolCallId,
        toolName,
        arguments: objectOf(frame.args) ?? {},
      })
      return
    }
    if (frame.type !== 'tool_execution_end') return
    const toolCallId = typeof frame.toolCallId === 'string' ? frame.toolCallId : ''
    const toolName = typeof frame.toolName === 'string' ? frame.toolName : ''
    if (toolCallId.length === 0 || toolName.length === 0) return
    this.onTool({
      kind: 'end',
      toolCallId,
      toolName,
      content: toolContentOf(frame.result),
      isError: frame.isError === true,
    })
  }

  private startIndex(messages: readonly RequestMessage[]): number {
    if (this.delivered !== undefined) return this.delivered
    if (this.transcript === 'latest') {
      const lastUser = messages.findLastIndex(message => message.role === 'user')
      return lastUser === -1 ? messages.length : lastUser
    }
    return 0
  }

  private async restart(): Promise<void> {
    await this.client.request({ type: 'new_session' })
    this.delivered = 0
  }
}

/** Ordered, closeable frame feed shared between the client listener and the generator. */
class FrameChannel {
  private readonly buffered: OmpAgentEvent[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(frame: OmpAgentEvent): void {
    if (this.closed) return
    this.buffered.push(frame)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<OmpAgentEvent> {
    while (true) {
      if (this.buffered.length > 0) {
        yield this.buffered.shift() as OmpAgentEvent
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }
}
