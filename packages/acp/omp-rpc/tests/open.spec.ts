import { describe, expect, it } from 'vitest'
import { OMP_OPEN_PATH, parseOmpOpenInput, serveOmpOpen, type OmpOpenDeps } from '../src/open.ts'
import { OmpResumeError, type OmpTranscriptMatch } from '../src/resume.ts'

const match: OmpTranscriptMatch = {
  id: '01a0c88e-7521-7000-bb6a-67527d2b6806',
  path: '/home/sf/.omp/agent/sessions/--home--/2026-11-03T00-00-00-000Z_01a0c88e-7521-7000-bb6a-67527d2b6806.jsonl',
  file: '2026-11-03T00-00-00-000Z_01a0c88e-7521-7000-bb6a-67527d2b6806.jsonl',
  cwd: '/home/sf/workspace',
  profile: 'argon',
}

function request(body: unknown): Request {
  return new Request(`http://localhost${OMP_OPEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deps(overrides: Partial<OmpOpenDeps> = {}): OmpOpenDeps {
  return {
    resolveTranscript: async () => match,
    openAgent: async () => ({ agent: {} as never }),
    openTranscript: async () => ({ summary: 'resumed', hydrated: 7 }),
    ...overrides,
  }
}

describe('parseOmpOpenInput', () => {
  it('trims the transcript and optional fields', () => {
    expect(parseOmpOpenInput({ ompSession: ' 01a0c88e ', profile: ' lead ', sessionId: ' session-1 ' })).toEqual({
      ompSession: '01a0c88e',
      profile: 'lead',
      sessionId: 'session-1',
    })
  })

  it('requires a transcript and a JSON object', () => {
    expect(() => parseOmpOpenInput(null)).toThrow('A JSON object body is required.')
    expect(() => parseOmpOpenInput({})).toThrow('"ompSession" is required.')
    expect(() => parseOmpOpenInput({ ompSession: 'x', profile: 3 })).toThrow('"profile" must be a non-empty string')
  })
})

describe('serveOmpOpen', () => {
  it('opens a transcript in the transcript working directory and returns its identity', async () => {
    const seen: unknown[] = []
    const response = await serveOmpOpen(request({ ompSession: '01a0c88e' }), deps({
      async openAgent(input) {
        seen.push(input)
        return { agent: { id: 'session-1' } as never, agentPreset: 'omp:argon' }
      },
      async openTranscript(input) {
        seen.push(input.transcript.id)
        return { summary: 'resumed as argon', hydrated: 12 }
      },
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      sessionId: 'session-1',
      agentPreset: 'omp:argon',
      ompSession: {
        id: match.id,
        path: match.path,
        cwd: match.cwd,
        profile: match.profile,
      },
      hydrated: 12,
      summary: 'resumed as argon',
    })
    expect(seen).toEqual([
      { cwd: '/home/sf/workspace', profile: 'argon' },
      match.id,
    ])
  })

  it('reports an unknown transcript as 404', async () => {
    const response = await serveOmpOpen(request({ ompSession: 'missing' }), deps({
      resolveTranscript: async () => { throw new Error('no OMP transcript matches "missing"') },
    }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'omp/transcript-not-found', message: 'no OMP transcript matches "missing"' },
    })
  })

  it('passes a stable session failure through with its status', async () => {
    const response = await serveOmpOpen(request({ ompSession: match.id, sessionId: 'session-9' }), deps({
      openAgent: async () => { throw new OmpResumeError('session/not-found', 'no such session', 404) },
    }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'session/not-found', message: 'no such session' },
    })
  })

  it('hides an unexpected failure behind the generic error and reports it', async () => {
    const errors: unknown[] = []
    const response = await serveOmpOpen(request({ ompSession: match.id }), deps({
      openTranscript: async () => { throw new Error('attach exploded') },
      logError: error => { errors.push(error) },
    }))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'gateway/internal', message: 'Internal error.' },
    })
    expect(errors).toHaveLength(1)
  })

  it('requires a body', async () => {
    const response = await serveOmpOpen(new Request(`http://localhost${OMP_OPEN_PATH}`, { method: 'POST' }), deps())
    expect(response.status).toBe(400)
  })
})
