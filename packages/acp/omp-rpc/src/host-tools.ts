import type { OmpRpcClient } from './client.ts'
import type {
  OmpHostToolCallFrame,
  OmpHostToolCancelFrame,
  OmpHostToolDefinition,
  OmpHostToolResultBody,
  OmpRpcFrame,
} from './types.ts'

/** One harness tool published to OMP plus the executor behind it. */
export interface OmpHostToolHandler {
  readonly definition: OmpHostToolDefinition
  readonly execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<OmpHostToolResultBody>
}

/** Collaborators of one host tool bridge. */
export interface OmpHostToolBridgeOptions {
  readonly client: Pick<OmpRpcClient, 'request' | 'send' | 'onFrame'>
  readonly tools: () => readonly OmpHostToolHandler[]
}

/** Serve OMP's host tool protocol from harness-owned tools: publish their
 * definitions, execute each inbound call, and answer with its content.
 */
export class OmpHostToolBridge {
  private readonly client: OmpHostToolBridgeOptions['client']
  private readonly tools: OmpHostToolBridgeOptions['tools']
  private readonly running = new Map<string, AbortController>()
  private readonly detach: () => void

  constructor(options: OmpHostToolBridgeOptions) {
    this.client = options.client
    this.tools = options.tools
    this.detach = options.client.onFrame((frame) => { this.handle(frame) })
  }

  /**
   * Publish the tools this bridge currently serves.
   * @returns fulfillment after OMP acknowledges the definitions.
   */
  async sync(): Promise<void> {
    await this.client.request({
      type: 'set_host_tools',
      tools: this.tools().map(handler => handler.definition),
    })
  }

  /**
   * Stop serving: abort in-flight calls and detach from the client.
   * @param reason - failure text carried by the abort signals.
   */
  close(reason = 'OMP RPC bridge closed'): void {
    this.detach()
    for (const controller of this.running.values()) controller.abort(new Error(reason))
    this.running.clear()
  }

  private handle(frame: OmpRpcFrame): void {
    if (frame.type === 'host_tool_call') {
      void this.execute(frame as unknown as OmpHostToolCallFrame)
      return
    }
    if (frame.type === 'host_tool_cancel') this.cancel(frame as unknown as OmpHostToolCancelFrame)
  }

  private cancel(frame: OmpHostToolCancelFrame): void {
    this.running.get(frame.targetId)?.abort(new Error(`host tool call "${frame.targetId}" cancelled by OMP`))
  }

  private async execute(call: OmpHostToolCallFrame): Promise<void> {
    const handler = this.tools().find(candidate => candidate.definition.name === call.toolName)
    if (handler === undefined) {
      this.client.send({
        type: 'host_tool_result',
        id: call.id,
        isError: true,
        result: { content: [{ type: 'text', text: `unknown host tool "${call.toolName}"` }] },
      })
      return
    }
    const controller = new AbortController()
    this.running.set(call.id, controller)
    try {
      const result = await handler.execute(call.arguments, controller.signal)
      if (controller.signal.aborted) return
      this.client.send({ type: 'host_tool_result', id: call.id, result })
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      const text = error instanceof Error ? error.message : String(error)
      this.client.send({ type: 'host_tool_result', id: call.id, isError: true, result: { content: [{ type: 'text', text }] } })
    } finally {
      this.running.delete(call.id)
    }
  }
}
