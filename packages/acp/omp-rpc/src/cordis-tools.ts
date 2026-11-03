import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { OmpHostToolHandler } from './host-tools.ts'
import type { OmpHostToolContent } from './types.ts'

/** Harness tools the bridge publishes by default: discovery plus profile management. */
export const DEFAULT_OMP_HOST_TOOLS: readonly string[] = [
  'cordis_inspect_list',
  'cordis_inspect_query',
  'plugin_manager',
]

/** Inputs for projecting harness tools onto OMP's host-tool protocol. */
export interface OmpCordisToolOptions {
  readonly ctx: Context
  readonly agent: Agent
  /** Exact registered tool names to publish; unknown names are skipped. */
  readonly names: readonly string[]
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function projectContent(content: readonly ContentBlock[]): OmpHostToolContent[] {
  const projected: OmpHostToolContent[] = []
  for (const block of content) {
    if (block.type === 'text') {
      projected.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const { name, mediaType, bytes } = block.attachment
      projected.push({ type: 'text', text: `[image${name === undefined ? '' : ` ${name}`}: ${mediaType}, ${String(bytes)} bytes]` })
      continue
    }
    projected.push({ type: 'text', text: JSON.stringify(block) })
  }
  return projected
}

function resultOf(results: readonly { callId: string; result: ToolExecutionResult }[], callId: string): ToolExecutionResult {
  const result = results.find(candidate => candidate.callId === callId)?.result
  if (result === undefined) throw new Error(`tool "${callId}" produced no execution result`)
  return result
}

/**
 * Build OMP host-tool handlers backed by the calling harness Agent's tools.
 *
 * The model-facing definitions come from the same registry the harness would
 * send for this agent, so OMP sees exactly the schemas the harness advertises.
 * Execution goes through the harness's tool pipeline, preserving guards,
 * approvals, logging, and cancellation.
 * @param options - Cordis context, the owning Agent, and the names to publish.
 * @returns handlers for every requested name the agent can currently resolve.
 */
export function ompCordisHostTools(options: OmpCordisToolOptions): OmpHostToolHandler[] {
  const definitions = new Map<string, ToolDefinition>()
  for (const definition of options.ctx.tools.definitions(options.agent)) {
    definitions.set(definition.name, definition)
  }
  const handlers: OmpHostToolHandler[] = []
  for (const name of options.names) {
    const definition = definitions.get(name)
    if (definition === undefined) continue
    handlers.push({
      definition: {
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      },
      async execute(args, signal) {
        const callId = ToolCallId(`omp-host-${randomUUID()}`)
        const batch = await options.ctx.tools.execute({
          calls: [{ type: 'tool-call', id: callId, name: definition.name, arguments: JSON.stringify(args) }],
          signal,
          agent: options.agent,
        })
        const result = resultOf(batch.results, callId)
        if (result.isError) throw new Error(textOf(result.content) || `host tool "${definition.name}" failed`)
        return { content: projectContent(result.content) }
      },
    })
  }
  return handlers
}
