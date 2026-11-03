import { describe, expect, it } from 'vitest'
import { ompHostToolDefinition } from '../src/cordis-tools.ts'

describe('ompHostToolDefinition', () => {
  it('publishes Cordis tools as discoverable host tools', () => {
    expect(ompHostToolDefinition({
      name: 'cordis_inspect_list',
      description: 'List runtime providers',
      parameters: { type: 'object', properties: {} },
    })).toEqual({
      name: 'cordis_inspect_list',
      label: 'cordis_inspect_list',
      description: 'List runtime providers',
      parameters: { type: 'object', properties: {} },
      loadMode: 'discoverable',
    })
  })
})
