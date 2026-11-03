import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentStepStream } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('agent/step-stream seam', () => {
  it('serves the step from the supplied stream and never reaches the adapter', async () => {
    const adapter = new MockAdapter([textResponse('from adapter')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('seam-driver'), { provider: 'mock', model: 'mock' })
    const requests: GenerateOptions[] = []
    let selection: unknown
    ctx.on('agent/step-stream', async (payload, _next) => {
      selection = payload.selection
      const driver: AgentStepStream = request => (async function* () {
        requests.push(request)
        yield* textResponse('from driver')
      })()
      return driver
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'hello driver')
    await idle

    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'from driver' }])
    expect(adapter.requests).toHaveLength(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(selection).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('falls back to the adapter when the listener delegates', async () => {
    const adapter = new MockAdapter([textResponse('from adapter')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('seam-fallback'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/step-stream', async (_payload, next) => await next())

    const idle = waitForIdle(ctx, agent)
    send(agent, 'hello adapter')
    await idle

    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'from adapter' }])
    expect(adapter.requests).toHaveLength(1)
  })

  it('advances past transcript turns appended after the loop was created', async () => {
    const adapter = new MockAdapter([textResponse('after hydration')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('hydrated-turns'), { provider: 'mock', model: 'mock' })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'continue')
    await idle

    const events = agent.session.snapshotEvents()
    const starts = events.filter(event => event.type === 'turn/start')
    const message = events.find(event => event.type === 'assistant/message')
    expect(starts.map(event => event.data.turn)).toEqual([1, 2])
    expect(message?.type === 'assistant/message' ? message.data.turn : undefined).toBe(2)
  })
})
