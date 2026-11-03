import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverOmpPresets, ompPresetOrder } from '../src/presets.ts'

const roots: string[] = []

async function sandbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omp-presets-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('discoverOmpPresets', () => {
  it('prefers the nearest project definition over ancestor and user profiles', async () => {
    const root = await sandbox()
    const project = join(root, 'project')
    const nested = join(project, 'packages', 'feature')
    const user = join(root, 'home', '.omp', 'agent', 'agents')
    await mkdir(join(project, '.omp', 'agents'), { recursive: true })
    await mkdir(join(nested), { recursive: true })
    await mkdir(user, { recursive: true })
    await writeFile(join(project, '.omp', 'agents', 'scout.md'), '---\nname: scout\ndescription: project scout\nmodel: omp/fast\ntools: read, grep\n---\n\nProject instructions.\n')
    await writeFile(join(user, 'scout.md'), '---\ndescription: user scout\n---\n\nUser instructions.\n')
    await writeFile(join(user, 'reviewer.md'), '---\ndescription: user reviewer\n---\n\nReview carefully.\n')

    const presets = await discoverOmpPresets({ cwd: nested, home: join(root, 'home') })

    expect(presets.map(preset => preset.name)).toEqual(['scout', 'reviewer'])
    expect(presets[0]).toMatchObject({
      description: 'project scout',
      model: 'omp/fast',
      tools: ['read', 'grep'],
      scope: 'project',
    })
    expect(presets[0]?.path).toBe(join(project, '.omp', 'agents', 'scout.md'))
    expect(presets[1]).toMatchObject({ description: 'user reviewer', scope: 'user' })
  })

  it('falls back to the filename and tolerates a missing frontmatter block', async () => {
    const root = await sandbox()
    const dir = join(root, '.omp', 'agents')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'planner.md'), 'Plan the work.\n')
    await writeFile(join(dir, 'notes.txt'), 'ignored\n')

    const presets = await discoverOmpPresets({ cwd: root, home: join(root, 'home') })

    expect(presets.map(preset => preset.name)).toEqual(['planner'])
    expect(presets[0]?.description).toBeUndefined()
  })
})

describe('ompPresetOrder', () => {
  it('leads the roster with argon and orders every other profile together', () => {
    expect(ompPresetOrder('argon')).toBe(1)
    expect(ompPresetOrder('builder')).toBe(5)
    expect(ompPresetOrder('squad-actor')).toBe(5)
  })
})
