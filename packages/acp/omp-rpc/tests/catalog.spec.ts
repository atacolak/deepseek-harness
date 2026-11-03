import { describe, expect, it } from 'vitest'
import { matchCatalogModel, OmpModelCatalogSync } from '../src/catalog.ts'
import type { OmpRpcCommand } from '../src/types.ts'

class FakeClient {
  readonly commands: OmpRpcCommand[] = []
  readonly catalog: unknown

  constructor(catalog: unknown) {
    this.catalog = catalog
  }

  request(command: OmpRpcCommand): Promise<unknown> {
    this.commands.push(command)
    return Promise.resolve(this.catalog)
  }
}

describe('matchCatalogModel', () => {
  it('prefers an exact id and falls back to a route-prefixed id', () => {
    const models = [
      { id: 'cpa/claude-opus-4-6', provider: 'cpa' },
      { id: 'glm-5', provider: 'opencode-go' },
    ]
    expect(matchCatalogModel(models, { provider: 'llm-pi-ai', model: 'glm-5' })).toEqual({ id: 'glm-5', provider: 'opencode-go' })
    expect(matchCatalogModel(models, { provider: 'llm-pi-ai', model: 'claude-opus-4-6' }))
      .toEqual({ id: 'cpa/claude-opus-4-6', provider: 'cpa' })
    expect(matchCatalogModel(models, { provider: 'llm-pi-ai', model: 'absent' })).toBeUndefined()
  })
})

describe('OmpModelCatalogSync', () => {
  const catalog = {
    models: [
      { id: 'go/glm-5', name: 'GLM 5', provider: 'opencode-go' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ],
  }

  it('applies the matching model through its advertised route', async () => {
    const client = new FakeClient(catalog)
    const sync = new OmpModelCatalogSync(client, { provider: 'llm-pi-ai', model: 'glm-5' })
    const outcome = await sync.sync()
    expect(outcome.status).toBe('applied')
    expect(outcome.models.map(model => model.id)).toEqual(['go/glm-5', 'gpt-5.5'])
    expect(client.commands).toEqual([
      { type: 'get_available_models' },
      { type: 'set_model', provider: 'opencode-go', modelId: 'go/glm-5' },
    ])
  })

  it('reports a selection the gateway does not offer and applies nothing', async () => {
    const client = new FakeClient(catalog)
    const sync = new OmpModelCatalogSync(client, { provider: 'llm-pi-ai', model: 'meridian-only' })
    await expect(sync.sync()).resolves.toEqual({
      status: 'not-offered',
      models: [
        { id: 'go/glm-5', name: 'GLM 5', provider: 'opencode-go' },
        { id: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    })
    expect(client.commands.map(command => command.type)).toEqual(['get_available_models'])
  })

  it('leaves the process model alone when the harness has no selection', async () => {
    const client = new FakeClient(catalog)
    const sync = new OmpModelCatalogSync(client, undefined)
    await expect(sync.sync()).resolves.toMatchObject({ status: 'no-selection' })
    expect(client.commands.map(command => command.type)).toEqual(['get_available_models'])
  })

  it('reads an absent or malformed catalog as empty rather than throwing', async () => {
    const client = new FakeClient({ models: 'nonsense' })
    const sync = new OmpModelCatalogSync(client, { provider: 'llm-pi-ai', model: 'glm-5' })
    await expect(sync.sync()).resolves.toEqual({ status: 'not-offered', models: [] })
  })
})
