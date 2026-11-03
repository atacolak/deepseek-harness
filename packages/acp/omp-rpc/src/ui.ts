import type { OmpRpcClient } from './client.ts'
import type {
  OmpExtensionUiRequest,
  OmpExtensionUiResponse,
  OmpInteractiveUiRequest,
  OmpRpcFrame,
} from './types.ts'

/** Presents one interactive request and resolves with its answer. */
export type OmpUiAsker = (request: OmpInteractiveUiRequest, signal: AbortSignal) => Promise<OmpExtensionUiResponse>

/** Collaborators of one extension UI bridge. */
export interface OmpUiBridgeOptions {
  readonly client: Pick<OmpRpcClient, 'send' | 'onFrame'>
  readonly asker: OmpUiAsker
  /** Receives surface-only requests (notifications, status, title, widgets). */
  readonly onSurface?: (request: OmpExtensionUiRequest) => void
}

const INTERACTIVE_METHODS: Readonly<Record<string, true>> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
}

/**
 * Answer OMP's extension UI protocol from the harness: interactive requests go
 * to the asking surface, and status-only requests go to the surface observer.
 */
export class OmpUiBridge {
  private readonly options: OmpUiBridgeOptions
  private readonly outstanding = new Map<string, AbortController>()
  private readonly detach: () => void

  constructor(options: OmpUiBridgeOptions) {
    this.options = options
    this.detach = options.client.onFrame((frame) => { this.handle(frame) })
  }

  /**
   * Abort outstanding questions and detach from the client.
   * @param reason - failure text carried by the aborted question signals.
   */
  close(reason = 'OMP RPC bridge closed'): void {
    this.detach()
    for (const controller of this.outstanding.values()) controller.abort(new Error(reason))
    this.outstanding.clear()
  }

  private handle(frame: OmpRpcFrame): void {
    if (frame.type !== 'extension_ui_request') return
    const request = frame as OmpExtensionUiRequest
    if (request.method === 'cancel') {
      this.outstanding.get(request.targetId)?.abort(new Error(`extension UI request "${request.targetId}" cancelled`))
      this.outstanding.delete(request.targetId)
      return
    }
    if (INTERACTIVE_METHODS[request.method] === true) {
      void this.ask(request as OmpInteractiveUiRequest)
      return
    }
    this.options.onSurface?.(request)
  }

  private async ask(request: OmpInteractiveUiRequest): Promise<void> {
    const controller = new AbortController()
    this.outstanding.set(request.id, controller)
    try {
      const answer = await this.options.asker(request, controller.signal)
      if (controller.signal.aborted) return
      this.options.client.send({ ...answer, id: request.id })
    } catch {
      if (controller.signal.aborted) return
      this.options.client.send({ type: 'extension_ui_response', id: request.id, cancelled: true })
    } finally {
      this.outstanding.delete(request.id)
    }
  }
}
