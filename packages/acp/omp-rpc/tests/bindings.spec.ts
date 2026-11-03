import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defaultOmpBindingsFile, OmpBindings, OmpBindingsError } from '../src/bindings.ts'

const roots: string[] = []

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-bindings-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('defaultOmpBindingsFile', () => {
  it('places bindings under the resolved harness home', () => {
    expect(defaultOmpBindingsFile('/tmp/dsh-home')).toBe('/tmp/dsh-home/omp/bindings.json')
    vi.stubEnv('DSH_HOME', '/tmp/env-home')
    expect(defaultOmpBindingsFile()).toBe('/tmp/env-home/omp/bindings.json')
  })
})

describe('OmpBindings', () => {
  it('persists a binding across store instances', async () => {
    const file = join(await sandbox(), 'omp', 'bindings.json')
    const binding = {
      ompSessionId: '01a1722b-3e29-7000-b9d5-b05807bbe4b8',
      path: '/home/sf/.omp/agent/sessions/-workspace/01a1722b.jsonl',
      cwd: '/home/sf/workspace',
      profile: 'argon',
      updatedAt: '2026-11-03T09:09:55.942Z',
    }

    await new OmpBindings(file).set(SessionId('session-1'), binding)

    expect(await new OmpBindings(file).get(SessionId('session-1'))).toEqual(binding)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sessions: { 'session-1': binding },
    })
  })

  it('serializes concurrent writes without losing an entry', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)

    await Promise.all([
      store.set(SessionId('a'), {
        ompSessionId: 'omp-a', path: '/a.jsonl', cwd: '/a', updatedAt: '2026-11-03T00:00:00.000Z',
      }),
      store.set(SessionId('b'), {
        ompSessionId: 'omp-b', path: '/b.jsonl', cwd: '/b', updatedAt: '2026-11-03T00:00:01.000Z',
      }),
    ])

    expect(await store.get(SessionId('a'))).toMatchObject({ ompSessionId: 'omp-a' })
    expect(await store.get(SessionId('b'))).toMatchObject({ ompSessionId: 'omp-b' })
  })

  it('deletes one binding and keeps the rest', async () => {
    const file = join(await sandbox(), 'bindings.json')
    const store = new OmpBindings(file)
    await store.set(SessionId('a'), {
      ompSessionId: 'omp-a', path: '/a.jsonl', cwd: '/a', updatedAt: '2026-11-03T00:00:00.000Z',
    })
    await store.set(SessionId('b'), {
      ompSessionId: 'omp-b', path: '/b.jsonl', cwd: '/b', updatedAt: '2026-11-03T00:00:01.000Z',
    })

    await store.delete(SessionId('a'))

    expect(await store.get(SessionId('a'))).toBeUndefined()
    expect(await store.get(SessionId('b'))).toMatchObject({ ompSessionId: 'omp-b' })
  })

  it('reports a corrupt bindings file instead of silently forgetting it', async () => {
    const file = join(await sandbox(), 'bindings.json')
    await writeFile(file, '{not json')

    await expect(new OmpBindings(file).get(SessionId('a'))).rejects.toBeInstanceOf(OmpBindingsError)
  })
})
