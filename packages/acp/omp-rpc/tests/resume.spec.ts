import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ompHydrationEvents, parseOmpResumeInput } from '../src/resume.ts'

const roots: string[] = []

async function transcript(lines: readonly unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-hydrate-'))
  roots.push(root)
  const path = join(root, '2026-11-03T00-00-00-000Z_01a0c88e-7521-7000-bb6a-67527d2b6806.jsonl')
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('parseOmpResumeInput', () => {
  it('parses a prefix with an optional profile', () => {
    expect(parseOmpResumeInput(' 01a0c88e lead ')).toEqual({ prefix: '01a0c88e', profile: 'lead' })
  })

  it('rejects a third argument', () => {
    expect(() => parseOmpResumeInput('01a0c88e lead extra')).toThrow('at most two arguments')
  })
})

describe('ompHydrationEvents', () => {
  it('rebuilds user, assistant, and tool bubbles from a real transcript', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Original' },
      { type: 'session', version: 3, id: '01a0c88e-7521-7000-bb6a-67527d2b6806', cwd: '/home' },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'inspect the runtime' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'cpa',
          model: 'grok-4.7',
          content: [
            { type: 'thinking', thinking: 'read first' },
            { type: 'text', text: 'reading now' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'file body' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])

    const events = await ompHydrationEvents(path)

    expect(events.map(event => event.type)).toEqual([
      'user/message',
      'assistant/message',
      'tool/result',
      'assistant/message',
    ])
    expect(events[0]?.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'inspect the runtime' }],
    })
    expect(events[1]?.data).toMatchObject({
      turn: 1,
      step: 1,
      stream: [],
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: 'cpa', model: 'grok-4.7' },
        content: [
          { type: 'reasoning', text: 'read first' },
          { type: 'text', text: 'reading now' },
          { type: 'tool-call', name: 'read', arguments: '{"path":"/tmp/a"}' },
        ],
      },
    })
    expect(events[2]?.data).toMatchObject({
      turn: 1,
      step: 2,
      message: {
        role: 'tool',
        source: { kind: 'tool' },
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      },
    })
    expect(events[3]?.data).toMatchObject({ turn: 1, step: 3 })
  })

  it('starts a new turn at each user message and drops empty messages', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
    ])

    const events = await ompHydrationEvents(path)

    expect(events.map(event => event.type)).toEqual(['user/message', 'user/message', 'assistant/message'])
    expect(events[1]?.data).toMatchObject({ content: [{ type: 'text', text: '[image]' }] })
    expect(events[2]?.data).toMatchObject({ turn: 2, step: 1 })
  })

  it('keeps only the newest requested events', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'third' }] } },
    ])

    const events = await ompHydrationEvents(path, 2)

    expect(events.map(event => event.data)).toHaveLength(2)
    expect(events[0]?.type).toBe('assistant/message')
    expect(events[1]?.type).toBe('user/message')
  })
})
