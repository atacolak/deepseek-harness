/**
 * Wire vocabulary for OMP's newline-delimited JSON RPC mode (`omp --mode rpc`).
 *
 * The bridge deliberately mirrors only the frames it serves: command
 * correlation, the ready handshake, lossless protocol-v2 chunks, host tool
 * requests, and extension UI requests. Session and agent events stay loosely
 * typed because OMP owns that vocabulary and the bridge forwards them.
 *
 * @module @deepseek-ai/dsh-omp-rpc/types
 */

/** One bidirectional byte path to an OMP RPC process. */
export interface OmpRpcIo {
  /** Frames arriving from OMP, one JSON object per line. */
  readonly input: NodeJS.ReadableStream
  /** Frames written to OMP, one JSON object per line. */
  readonly output: NodeJS.WritableStream
}

/** One command frame sent to OMP; `id` correlates the response. */
export interface OmpRpcCommand {
  readonly type: string
  /** Correlation id echoed by the matching response frame. */
  readonly id?: string
  readonly [key: string]: unknown
}

/** First frame of every RPC session. */
export interface OmpRpcReadyFrame {
  readonly type: 'ready'
  readonly protocolVersion: 1
  readonly supportedProtocolVersions: readonly number[]
  readonly maxFrameBytes: number
  readonly maxReassembledFrameBytes?: number
}

/** Lossless protocol-v2 fragment of one oversized outbound object. */
export interface OmpRpcChunkFrame {
  readonly type: 'rpc_chunk'
  readonly chunkId: string
  readonly index: number
  readonly count: number
  readonly byteLength: number
  readonly data: string
}

/** Reply to one command; `success: false` carries the failure text. */
export interface OmpRpcResponseFrame {
  readonly type: 'response'
  readonly id?: string
  readonly command: string
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
  readonly code?: string
}

/** Terminal outcome of one accepted prompt, correlated by its command id. */
export interface OmpPromptResultFrame {
  readonly type: 'prompt_result'
  readonly id?: string
  readonly agentInvoked: boolean
  readonly status: 'completed' | 'aborted' | 'error'
  readonly sessionSettled: boolean
  readonly error?: { readonly message: string; readonly retryable?: boolean }
}

/** One OMP session or agent event forwarded to bridge listeners. */
export interface OmpAgentEvent {
  readonly type: string
  readonly [key: string]: unknown
}

/** Any frame this bridge does not interpret itself. */
export type OmpRpcFrame =
  | OmpRpcReadyFrame
  | OmpRpcChunkFrame
  | OmpRpcResponseFrame
  | OmpPromptResultFrame
  | OmpAgentEvent

/** One tool OMP may call back into the harness. */
export interface OmpHostToolDefinition {
  readonly name: string
  readonly label?: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly hidden?: boolean
  readonly loadMode?: 'always' | 'discoverable' | 'manual'
}

/** OMP asking the harness to execute one host tool. */
export interface OmpHostToolCallFrame {
  readonly type: 'host_tool_call'
  readonly id: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: Record<string, unknown>
}

/** OMP cancelling a host tool call the harness still owes an answer to. */
export interface OmpHostToolCancelFrame {
  readonly type: 'host_tool_cancel'
  readonly id: string
  readonly targetId: string
}

/** One content block returned by a host tool. */
export type OmpHostToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/** Result body the harness returns for one host tool call. */
export interface OmpHostToolResultBody {
  readonly content: readonly OmpHostToolContent[]
  readonly details?: unknown
}

/** Harness completion of one host tool call. */
export interface OmpHostToolResultFrame {
  readonly type: 'host_tool_result'
  readonly id: string
  readonly result: OmpHostToolResultBody
  readonly isError?: boolean
}

/** Harness streaming one partial host tool result. */
export interface OmpHostToolUpdateFrame {
  readonly type: 'host_tool_update'
  readonly id: string
  readonly partialResult: OmpHostToolResultBody
}

/** Interactive question OMP asks its host to present. */
export type OmpExtensionUiRequest =
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'select'
    readonly title: string
    readonly options: readonly string[]
    readonly optionDetails?: readonly { readonly description?: string }[]
    readonly timeout?: number
  }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'confirm'
    readonly title: string
    readonly message: string
    readonly timeout?: number
  }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'input'
    readonly title: string
    readonly placeholder?: string
    readonly timeout?: number
  }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'editor'
    readonly title: string
    readonly prefill?: string
    readonly promptStyle?: boolean
  }
  | { readonly type: 'extension_ui_request'; readonly id: string; readonly method: 'cancel'; readonly targetId: string }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'notify'
    readonly message: string
    readonly notifyType?: 'info' | 'warning' | 'error'
  }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'setStatus'
    readonly statusKey: string
    readonly statusText: string | undefined
  }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'setWidget'
    readonly widgetKey: string
    readonly widgetLines: readonly string[] | undefined
    readonly widgetPlacement?: 'aboveEditor' | 'belowEditor'
  }
  | { readonly type: 'extension_ui_request'; readonly id: string; readonly method: 'setTitle'; readonly title: string }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'set_editor_text'
    readonly text: string
  }
  | {
    readonly type: 'extension_ui_request'
    readonly id: string
    readonly method: 'open_url'
    readonly url: string
    readonly launchUrl?: string
    readonly instructions?: string
  }

/** Harness answer to one extension UI request. */
export type OmpExtensionUiResponse =
  | { readonly type: 'extension_ui_response'; readonly id: string; readonly value: string }
  | { readonly type: 'extension_ui_response'; readonly id: string; readonly confirmed: boolean }
  | {
    readonly type: 'extension_ui_response'
    readonly id: string
    readonly cancelled: true
    readonly timedOut?: boolean
  }

/** Interactive requests a host may present; the rest are fire-and-forget surfaces. */
export type OmpInteractiveUiRequest = Extract<
  OmpExtensionUiRequest,
  { method: 'select' | 'confirm' | 'input' | 'editor' }
>
