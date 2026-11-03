import { describe, expect, it } from 'vitest'
import { ompLaunchArgv, ompSessionDir, parseOmpCommandInput } from '../src/bridge.ts'

describe('omp commands', () => {
  it('parses a preset and a transcript identity', () => {
    expect(parseOmpCommandInput('builder abc123')).toEqual({
      preset: 'builder',
      sessionId: 'abc123',
    })
  })

  it('parses a lone preset', () => {
    expect(parseOmpCommandInput('builder')).toEqual({ preset: 'builder' })
  })

  it('parses an empty input', () => {
    expect(parseOmpCommandInput('  ')).toEqual({})
  })

  it('continues the latest transcript for attach', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'attach', sessionDir: '/tmp/omp' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp', '--continue',
    ])
  })

  it('resumes an explicit transcript for attach', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'attach', sessionDir: '/tmp/omp', sessionId: 's1', preset: 'builder' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp', '--agent', 'builder', '--resume', 's1',
    ])
  })

  it('never passes a resume flag when forking', () => {
    expect(ompLaunchArgv({ executable: 'omp', mode: 'fork', sessionDir: '/tmp/omp', sessionId: 's1' })).toEqual([
      'omp', '--mode', 'rpc', '--session-dir', '/tmp/omp',
    ])
  })

  it('scopes transcript directories per agent', () => {
    expect(ompSessionDir('/sessions', 'agent_one' as never)).toBe('/sessions/agent_one')
  })
})
