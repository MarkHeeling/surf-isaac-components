// Pure helpers for the SURF Research Cloud workspace API: URLs, parsing and
// the transition rules. No `$` here, so the tests can call them directly.
//
// API: https://servicedesk.surf.nl/wiki/spaces/WIKI/pages/174981256 (first
// steps) and the Swagger page at https://gw.live.surfresearchcloud.nl/v1/workspace/swagger/docs/.
// Auth is the bare token in an `authorization` header. Start/stop in the
// portal are the `resume`/`pause` actions. Field names below were checked
// against the live API on 2026-10-07.

import type { GpuFlavour, Workspace } from '../types'

export const WORKSPACE_API = 'https://gw.live.surfresearchcloud.nl/v1/workspace'

/** Statuses during which the workspace is on its way somewhere: poll fast. */
const TRANSITIONING = new Set(['creating', 'resuming', 'pausing', 'updating', 'rebooting', 'deleting'])

const STATUS_TEXT: Record<string, string> = {
  running: 'draait',
  paused: 'gestopt',
  resuming: 'start op',
  pausing: 'stopt',
}

export const FAST_POLL_MS = 10_000

export function listUrl(): string {
  // Without these filters the list holds every workspace of the CO, deleted ones included.
  return `${WORKSPACE_API}/workspaces/?application_type=Compute&deleted=false&by_owner=true&limit=100`
}

export function actionUrl(id: string, action: 'pause' | 'resume'): string {
  return `${WORKSPACE_API}/workspaces/${encodeURIComponent(id)}/actions/${action}/`
}

export function headers(token: string): Record<string, string> {
  return { accept: 'application/json', authorization: token.trim(), 'content-type': 'application/json' }
}

export function isTransitioning(status: string): boolean {
  return TRANSITIONING.has(status)
}

export function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status
}

type Raw = Record<string, unknown>

const asObject = (value: unknown): Raw | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

function sizeFlavour(raw: Raw): string | undefined {
  const flavours = asObject(raw.meta)?.flavours
  if (!Array.isArray(flavours)) return undefined
  const size = flavours.map(asObject).find(f => f?.category === 'size')
  return asString(size?.name)
}

/**
 * SURF's error text when the newest action failed. The history is in
 * `workspace_actions` (`actions` is only the list of allowed action names);
 * the text is in `result.error`, while `reason` says who started it ("API").
 */
function lastFailure(raw: Raw): string | undefined {
  const actions = raw.workspace_actions
  if (!Array.isArray(actions)) return undefined
  const last = actions
    .map(asObject)
    .filter((a): a is Raw => a !== undefined)
    .sort((a, b) => String(a.time_created ?? '').localeCompare(String(b.time_created ?? '')))
    .at(-1)
  if (asString(last?.status)?.toLowerCase() !== 'failed') return undefined
  const result = asObject(last?.result)
  return asString(result?.error) ?? asString(result?.message) ?? 'onbekende fout'
}

/** The portal name is long; the host name ("markisaacsim") is what people call it. */
function names(raw: Raw): string[] {
  return [asString(asObject(raw.meta)?.host_name), asString(raw.name)].filter((n): n is string => n !== undefined)
}

export function parseWorkspace(value: unknown): Workspace | undefined {
  const raw = asObject(value)
  const id = asString(raw?.id)
  if (!raw || !id) return undefined
  return {
    id,
    name: names(raw)[0] ?? id,
    status: (asString(raw.status) ?? (raw.active === true ? 'running' : 'unknown')).toLowerCase(),
    flavour: sizeFlavour(raw),
    failure: lastFailure(raw),
  }
}

/** Parses a (paginated) list answer and keeps those whose host or portal name contains `filter`. */
export function parseList(text: string, filter: string): Workspace[] {
  const body: unknown = JSON.parse(text)
  const results = Array.isArray(body) ? body : asObject(body)?.results
  if (!Array.isArray(results)) throw new Error('unexpected answer: no results list')
  const needle = filter.trim().toLowerCase()
  return results
    .map(asObject)
    .filter((raw): raw is Raw => raw !== undefined)
    .filter(raw => needle === '' || names(raw).some(n => n.toLowerCase().includes(needle)))
    .map(parseWorkspace)
    .filter((w): w is Workspace => w !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Toast text for a status change from `before` to `after`, if it is worth one. */
export function describeChange(before: Workspace | undefined, after: Workspace): string | undefined {
  if (!before || before.status === after.status) return undefined
  if (before.status === 'resuming' && after.status === 'running') return `${after.name} draait weer.`
  if (before.status === 'resuming') {
    return `${after.name}: starten mislukt${after.failure ? ` (${after.failure})` : ''}. Waarschijnlijk geen GPU's vrij.`
  }
  if (before.status === 'pausing' && after.status === 'paused') return `${after.name} is gestopt.`
  return undefined
}

/** Whether the GPUs this workspace needs are free: true, false, or undefined when unknown. */
export function isAvailable(ws: Workspace, flavours: readonly GpuFlavour[]): boolean | undefined {
  const available = flavours.find(f => f.name === ws.flavour)?.available
  return typeof available === 'boolean' ? available : undefined
}

/** "GPU's beschikbaar" / "GPU's niet beschikbaar"; nothing while it runs or when unknown. */
export function availabilityText(ws: Workspace, flavours: readonly GpuFlavour[]): string | undefined {
  if (ws.status === 'running') return undefined
  const available = isAvailable(ws, flavours)
  return available === undefined ? undefined : available ? "GPU's beschikbaar" : "GPU's niet beschikbaar"
}

/** The one-line status under the prompt. */
export function statusLine(
  workspaces: readonly Workspace[],
  error: string | null,
  flavours: readonly GpuFlavour[] = [],
): string {
  if (error) return `SURF: ${error}`
  if (workspaces.length === 0) return 'SURF: geen workspace gevonden'
  const parts = workspaces.map(w => [`${w.name} ${statusText(w.status)}`, availabilityText(w, flavours)].filter(Boolean).join(' · '))
  return 'SURF: ' + parts.join(' | ')
}

// GPU availability: the portal's create dialog reads it from the catalog
// item's offerings, one `available` flag per flavour (true, false, or null
// for flavours without a capacity check, like the OS image).

export const CATALOG_API = 'https://gw.live.surfresearchcloud.nl/v1/application-market'

export function offeringsUrl(catalogItem: string, co: string, products: readonly string[]): string {
  const query = [`co=${encodeURIComponent(co)}`, ...products.map(p => `product=${encodeURIComponent(p)}`)].join('&')
  return `${CATALOG_API}/catalog_items/${encodeURIComponent(catalogItem)}/offerings/?${query}`
}

/** The size flavours of every offering with their `available` flag, by name. */
export function parseAvailability(text: string): GpuFlavour[] {
  const body: unknown = JSON.parse(text)
  const offerings = Array.isArray(body) ? body : asObject(body)?.results
  if (!Array.isArray(offerings)) throw new Error('unexpected offerings answer: no results list')
  const byName = new Map<string, GpuFlavour>()
  for (const offering of offerings) {
    const flavours = asObject(offering)?.flavours
    if (!Array.isArray(flavours)) continue
    for (const raw of flavours.map(asObject)) {
      const name = asString(raw?.name)
      if (!raw || !name || raw.category !== 'size') continue
      const available = typeof raw.available === 'boolean' ? raw.available : null
      byName.set(name, { name, available })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Toasts for the workspaces whose GPUs came free since the last check. */
export function describeAvailabilityChange(
  before: readonly GpuFlavour[],
  after: readonly GpuFlavour[],
  workspaces: readonly Workspace[],
): string[] {
  return workspaces
    .filter(w => w.status !== 'running' && isAvailable(w, before) === false && isAvailable(w, after) === true)
    .map(w => `${w.name}: GPU's weer beschikbaar, je kunt starten.`)
}
