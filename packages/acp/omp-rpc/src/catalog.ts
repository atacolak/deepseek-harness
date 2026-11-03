import type { OmpRpcClient } from './client.ts'

/** One model the attached OMP process says its gateway serves. */
export interface OmpCatalogModel {
  readonly id: string
  readonly name?: string
  /** Provider route OMP resolves the model through, when it discloses one. */
  readonly provider?: string
}

/** The harness-side route and model an attachment should serve. */
export interface OmpModelSelection {
  readonly provider: string
  readonly model: string
}

/** What one catalog synchronization pass did. */
export type CatalogSyncOutcome =
  | { readonly status: 'applied'; readonly model: OmpCatalogModel; readonly models: readonly OmpCatalogModel[] }
  | { readonly status: 'not-offered'; readonly models: readonly OmpCatalogModel[] }
  | { readonly status: 'no-selection'; readonly models: readonly OmpCatalogModel[] }

/** The client surface catalog sync needs. */
export type OmpCatalogClient = Pick<OmpRpcClient, 'request'>

/**
 * Choose the advertised model that serves one harness selection.
 *
 * Exact ids match first. A gateway that prefixes its ids with the route
 * (`go/glm-5`, `cpa/claude-opus`) is matched on the last path segment, which is
 * the id the harness selects by.
 * @param models - the catalog the process advertised, in its own order.
 * @param selection - the harness route and model.
 * @returns the matching entry, or undefined when the gateway does not serve it.
 */
export function matchCatalogModel(
  models: readonly OmpCatalogModel[],
  selection: OmpModelSelection,
): OmpCatalogModel | undefined {
  return models.find(model => model.id === selection.model)
    ?? models.find(model => model.id.endsWith(`/${selection.model}`))
}

function readCatalog(data: unknown): OmpCatalogModel[] {
  const rows = (data as { models?: unknown } | null)?.models
  if (!Array.isArray(rows)) return []
  const models: OmpCatalogModel[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as { id?: unknown; name?: unknown; provider?: unknown }
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    models.push({
      id: entry.id,
      ...typeof entry.name === 'string' ? { name: entry.name } : {},
      ...typeof entry.provider === 'string' ? { provider: entry.provider } : {},
    })
  }
  return models
}

/**
 * Point an attached OMP process at the model the harness selected, using the
 * catalog the process itself reports — the Meridian or CPA gateway catalog it
 * was launched against.
 *
 * The catalog is read first and the selection applied only when it appears
 * there: asking OMP to serve a model its gateway does not list would fail at
 * request time with a far less actionable error. A harness selection with no
 * model (an attachment driven entirely by OMP's own model choice) is left
 * untouched.
 */
export class OmpModelCatalogSync {
  constructor(
    private readonly client: OmpCatalogClient,
    private readonly selection: OmpModelSelection | undefined,
  ) {}

  /**
   * Run one pass.
   * @returns the outcome and the catalog the process reported.
   */
  async sync(): Promise<CatalogSyncOutcome> {
    const models = readCatalog(await this.client.request({ type: 'get_available_models' }))
    if (this.selection === undefined) return { status: 'no-selection', models }
    const model = matchCatalogModel(models, this.selection)
    if (model === undefined) return { status: 'not-offered', models }
    await this.client.request({
      type: 'set_model',
      provider: model.provider ?? this.selection.provider,
      modelId: model.id,
    })
    return { status: 'applied', model, models }
  }
}
