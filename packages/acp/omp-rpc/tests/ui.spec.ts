import { describe, expect, it } from 'vitest'
import { OmpUiBridge } from '../src/ui.ts'
import { frameAt, rpcHarness, tick } from './harness.ts'

type Asker = ConstructorParameters<typeof OmpUiBridge>[0]['asker']

function bridge(asker: Asker) {
  const io = rpcHarness()
  const surfaces: string[] = []
  const ui = new OmpUiBridge({
    client: io.client,
    asker,
    onSurface: (request) => { surfaces.push(request.method) },
  })
  return { io, ui, surfaces }
}

describe('OmpUiBridge interactive requests', () => {
  it('answers a select question with the chosen value', async () => {
    const { io } = bridge(async () => ({ type: 'extension_ui_response', id: 'ignored', value: 'Allow' }))
    io.receive({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Approve?', options: ['Allow', 'Deny'] })
    await tick()
    expect(frameAt(io.written, 0)).toEqual({ type: 'extension_ui_response', id: 'ui-1', value: 'Allow' })
  })

  it('answers a confirm question with the confirmed flag', async () => {
    const { io } = bridge(async () => ({ type: 'extension_ui_response', id: 'ignored', confirmed: true }))
    io.receive({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: 'Run?', message: 'rm -rf build' })
    await tick()
    expect(frameAt(io.written, 0)).toEqual({ type: 'extension_ui_response', id: 'ui-2', confirmed: true })
  })

  it('answers cancelled when the asking surface fails', async () => {
    const { io } = bridge(async () => { throw new Error('surface closed') })
    io.receive({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Name?' })
    await tick()
    expect(frameAt(io.written, 0)).toEqual({ type: 'extension_ui_response', id: 'ui-3', cancelled: true })
  })
})

describe('OmpUiBridge fire-and-forget requests', () => {
  it('forwards a notification to the surface without answering it', async () => {
    const { io, surfaces } = bridge(async () => ({ type: 'extension_ui_response', id: 'unused', confirmed: true }))
    io.receive({ type: 'extension_ui_request', id: 'ui-4', method: 'notify', message: 'done', notifyType: 'info' })
    await tick()
    expect(surfaces).toEqual(['notify'])
    expect(io.written).toEqual([])
  })

  it('aborts an outstanding question when the process cancels it', async () => {
    const aborted: boolean[] = []
    const { io } = bridge(async (_request, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { aborted.push(true); resolve() }, { once: true })
      })
      return { type: 'extension_ui_response', id: 'unused', cancelled: true }
    })
    io.receive({ type: 'extension_ui_request', id: 'ui-5', method: 'editor', title: 'Compose' })
    await tick()
    io.receive({ type: 'extension_ui_request', id: 'ui-cancel', method: 'cancel', targetId: 'ui-5' })
    await tick()
    expect(aborted).toEqual([true])
    expect(io.written).toEqual([])
  })
})
