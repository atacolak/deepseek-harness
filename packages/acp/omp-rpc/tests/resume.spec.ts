import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  hydrateOmpSession,
  ompHydrationEvents,
  parseOmpResumeInput,
  readOmpTranscriptTitle,
} from '../src/resume.ts'

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

describe('readOmpTranscriptTitle', () => {
  it('reads the newest title across title and title_change records', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Newest  title', updatedAt: '2026-11-03T09:09:55.942Z' },
      { type: 'session', version: 3, id: '01a0c88e-7521-7000-bb6a-67527d2b6806', title: 'Header title' },
      { type: 'title_change', title: 'Older title', timestamp: '2026-11-02T08:33:11.974Z' },
    ])
    expect(await readOmpTranscriptTitle(path)).toBe('Newest title')
  })

  it('ignores an empty title record', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: '', updatedAt: '2026-11-03T09:09:55.942Z' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    ])
    expect(await readOmpTranscriptTitle(path)).toBeUndefined()
  })
})

describe('ompHydrationEvents', () => {
  it('rebuilds visible turn, step, user, assistant, and tool events from a real transcript', async () => {
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
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[0]?.data).toEqual({ turn: 1 })
    expect(events[1]?.data).toEqual({ turn: 1, step: 1 })
    expect(events[2]?.data).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'inspect the runtime' }],
    })
    expect(events[3]?.data).toMatchObject({
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
    expect(events[4]?.data).toMatchObject({
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool' },
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
      },
    })
    expect(events[7]?.data).toMatchObject({ turn: 1, step: 2 })
    expect(events[9]?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('starts a new turn at each user message and drops empty messages', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'one' }] } },
      { type: 'message', message: { role: 'assistant', content: [] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
    ])

    const events = await ompHydrationEvents(path)

    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(events[7]?.data).toMatchObject({ content: [{ type: 'text', text: '[image]' }] })
    expect(events[8]?.data).toMatchObject({ turn: 2, step: 1 })
    expect(events[4]?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    expect(events[10]?.data).toEqual({ turn: 2, reason: { kind: 'completed' } })
  })

  it('always keeps the newest turn intact when the limit is small', async () => {
    const path = await transcript([
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'third' }] } },
    ])

    const events = await ompHydrationEvents(path, 2)

    expect(events.map(event => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'step/end',
      'turn/end',
    ])
    expect(events[0]?.data).toEqual({ turn: 3 })
    expect(events[2]?.data).toMatchObject({ content: [{ type: 'text', text: 'third' }] })
  })
})

describe('hydrateOmpSession', () => {
  it('appends the recorded title before structural events', async () => {
    const path = await transcript([
      { type: 'title', v: 1, title: 'Resume and search OMP history', updatedAt: '2026-11-03T09:09:55.942Z' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ])
    const session = Session.create(SessionId('hydrated-title'))

    const appended = await hydrateOmpSession(session, path)
    const events = session.snapshotEvents()

    expect(appended).toBe(events.length)
    expect(events[0]).toMatchObject({
      type: 'session/title',
      data: { title: 'Resume and search OMP history', messageSeqs: [], source: { kind: 'user' } },
    })
    expect(events.map(event => event.type)).toEqual([
      'session/title',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
  })
})
