import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** One `<agent>.md` profile OMP can mount with `--agent <name>`. */
export interface OmpAgentPreset {
  /** Profile name OMP resolves from the file's frontmatter or filename. */
  readonly name: string
  readonly description?: string
  readonly model?: string
  readonly tools?: readonly string[]
  /** Absolute path of the discovered markdown file. */
  readonly path: string
  readonly scope: 'project' | 'user'
}

/** Inputs that anchor profile discovery; no ambient defaults are applied. */
export interface OmpPresetDiscoveryOptions {
  readonly cwd: string
  /** User home owning `~/.omp/agent/agents`; pass explicitly outside a process. */
  readonly home?: string
}

interface Frontmatter {
  readonly fields: ReadonlyMap<string, string>
  readonly body: string
}

function frontmatterOf(text: string): Frontmatter {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return { fields: new Map(), body: normalized }
  const close = normalized.indexOf('\n---', 4)
  if (close === -1) return { fields: new Map(), body: normalized }
  const fields = new Map<string, string>()
  for (const line of normalized.slice(4, close).split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    if (key.length === 0 || raw.length === 0) continue
    fields.set(key, raw.replace(/^(['"])(.*)\1$/, '$2'))
  }
  return { fields, body: normalized.slice(close + 4) }
}

function presetOf(path: string, text: string, scope: OmpAgentPreset['scope']): OmpAgentPreset {
  const { fields } = frontmatterOf(text)
  const name = fields.get('name') ?? basename(path, '.md')
  const description = fields.get('description')
  const model = fields.get('model')
  const tools = fields.get('tools')
  return {
    name,
    ...description === undefined ? {} : { description },
    ...model === undefined ? {} : { model },
    ...tools === undefined
      ? {}
      : { tools: tools.split(',').map(item => item.trim()).filter(item => item.length > 0) },
    path: resolve(path),
    scope,
  }
}

async function readPresets(dir: string, scope: OmpAgentPreset['scope']): Promise<OmpAgentPreset[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
  const presets: OmpAgentPreset[] = []
  for (const file of files) {
    const path = join(dir, file)
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    presets.push(presetOf(path, text, scope))
  }
  return presets
}

function projectAgentDirs(cwd: string): string[] {
  const dirs: string[] = []
  let current = resolve(cwd)
  while (true) {
    dirs.push(join(current, '.omp', 'agents'))
    const parent = dirname(current)
    if (parent === current) return dirs
    current = parent
  }
}

/**
 * Discover OMP profile markdown the same way `omp --agent` does: project
 * `.omp/agents` directories from the working directory upward take precedence
 * over the user's `~/.omp/agent/agents`, and the first definition of a name
 * wins.
 * @param options - working directory and the user home to search.
 * @returns profiles in discovery order, project before user.
 */
export async function discoverOmpPresets(options: OmpPresetDiscoveryOptions): Promise<OmpAgentPreset[]> {
  const home = options.home ?? homedir()
  const seen = new Set<string>()
  const presets: OmpAgentPreset[] = []
  const candidates: Array<{ dir: string; scope: OmpAgentPreset['scope'] }> = [
    ...projectAgentDirs(options.cwd).map(dir => ({ dir, scope: 'project' as const })),
    { dir: join(home, '.omp', 'agent', 'agents'), scope: 'user' },
  ]
  for (const { dir, scope } of candidates) {
    for (const preset of await readPresets(dir, scope)) {
      if (seen.has(preset.name)) continue
      seen.add(preset.name)
      presets.push(preset)
    }
  }
  return presets
}
