// Pure helpers for the SURF Research Cloud workspace API: URLs, parsing and
// the transition rules. No `$` here, so the tests can call them directly.
//
// API: https://servicedesk.surf.nl/wiki/spaces/WIKI/pages/174981256 (first
// steps) and the Swagger page at https://gw.live.surfresearchcloud.nl/v1/workspace/swagger/docs/.
// Auth is the bare token in an `authorization` header. Start/stop in the
// portal are the `resume`/`pause` actions.

import type { GpuFlavour, Workspace } from '../types'

export const WORKSPACE_API = 'https://gw.live.surfresearchcloud.nl/v1/workspace'
export const PORTAL = 'https://portal.live.surfresearchcloud.nl/'

/** Statuses during which the workspace is on its way somewhere: poll fast. */
const TRANSITIONING = new Set(['creating', 'resuming', 'pausing', 'updating', 'rebooting', 'deleting'])
/** Statuses a resume can fall back to when it did not get its hardware. */
const RESUME_FAILED = new Set(['paused', 'failed', 'unhealthy', 'unknown'])

export const FAST_POLL_MS = 10_000

export function listUrl(): string {
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

type Raw = Record<string, unknown>

const asObject = (value: unknown): Raw | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/**
 * The first error-like text on an object: the API's exact field names for a
 * failed action are not documented, so look for the usual suspects.
 */
export function findMessage(value: unknown): string | undefined {
  const obj = asObject(value)
  if (!obj) return undefined
  for (const key of ['error', 'error_message', 'message', 'status_message', 'reason', 'detail']) {
    const text = asString(obj[key])
    if (text) return text
    const nested = findMessage(obj[key])
    if (nested) return nested
  }
  return undefined
}

function sizeFlavour(raw: Raw): string | undefined {
  const flavours = asObject(raw.meta)?.flavours
  if (!Array.isArray(flavours)) return undefined
  const size = flavours.map(asObject).find(f => f?.category === 'size')
  return asString(size?.name)
}

function lastAction(raw: Raw): Workspace['lastAction'] {
  const actions = raw.actions
  if (!Array.isArray(actions) || actions.length === 0) return undefined
  const sorted = actions
    .map(asObject)
    .filter((a): a is Raw => a !== undefined)
    .sort((a, b) => String(a.time_created ?? '').localeCompare(String(b.time_created ?? '')))
  const last = sorted[sorted.length - 1]
  if (!last) return undefined
  return {
    type: asString(last.type) ?? asString(last.action) ?? asString(last.name),
    status: asString(last.status)?.toLowerCase(),
    message: findMessage(last),
  }
}

export function parseWorkspace(value: unknown): Workspace | undefined {
  const raw = asObject(value)
  const id = asString(raw?.id)
  if (!raw || !id) return undefined
  return {
    id,
    name: asString(raw.name) ?? id,
    status: (asString(raw.status) ?? (raw.active === true ? 'running' : 'unknown')).toLowerCase(),
    ip: asString(asObject(raw.resource_meta)?.ip),
    flavour: sizeFlavour(raw),
    message: findMessage(raw),
    lastAction: lastAction(raw),
  }
}

/** Parses a (paginated) list answer and keeps the names matching `filter`. */
export function parseList(text: string, filter: string): Workspace[] {
  const body: unknown = JSON.parse(text)
  const results = Array.isArray(body) ? body : asObject(body)?.results
  if (!Array.isArray(results)) throw new Error('unexpected answer: no results list')
  const needle = filter.trim().toLowerCase()
  return results
    .map(parseWorkspace)
    .filter((w): w is Workspace => w !== undefined)
    .filter(w => needle === '' || w.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export type Change = {
  /** Text for a toast (and a macOS notification), when something worth saying happened. */
  say?: string
  /** True when a resume ended without the workspace running. */
  isResumeFailed?: boolean
}

/** What a status change from `before` to `after` means for the person. */
export function describeChange(before: Workspace | undefined, after: Workspace): Change {
  if (!before || before.status === after.status) return {}
  const name = after.name
  if (before.status === 'resuming' && after.status === 'running') {
    return { say: `${name} draait weer.` }
  }
  if (before.status === 'resuming' && RESUME_FAILED.has(after.status)) {
    const why = after.lastAction?.message ?? after.message
    return {
      say: `${name}: starten mislukt (${after.status})${why ? `: ${why}` : ''}. Waarschijnlijk geen GPU's vrij.`,
      isResumeFailed: true,
    }
  }
  if (before.status === 'pausing' && after.status === 'paused') {
    return { say: `${name} is gepauzeerd.` }
  }
  if (after.status === 'failed' || after.status === 'unhealthy') {
    return { say: `${name} staat op ${after.status}.` }
  }
  return {}
}

/** True once a resume has run longer than `warnMinutes`. */
export function isSlowResume(resumingSince: number | undefined, now: number, warnMinutes: number): boolean {
  return resumingSince !== undefined && warnMinutes > 0 && now - resumingSince >= warnMinutes * 60_000
}

/** The one-line status under the prompt. */
export function statusLine(
  workspaces: readonly Workspace[],
  error: string | null,
  flavours: readonly GpuFlavour[] = [],
): string {
  if (error) return `SURF: ${error}`
  const parts = workspaces.map(w => `${w.name} ${w.status}`)
  if (parts.length === 0) parts.push('geen workspace gevonden')
  for (const f of relevantFlavours(flavours, workspaces)) parts.push(`${f.name} ${availabilityText(f)}`)
  return 'SURF: ' + parts.join(' · ')
}

export function minutesSince(since: number, now: number): number {
  return Math.floor((now - since) / 60_000)
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

/** The flavours that matter: the ones the workspaces use, else all of them. */
export function relevantFlavours(flavours: readonly GpuFlavour[], workspaces: readonly Workspace[]): GpuFlavour[] {
  const used = new Set(workspaces.map(w => w.flavour).filter(Boolean))
  const mine = flavours.filter(f => used.has(f.name))
  return mine.length > 0 ? mine : [...flavours]
}

export function availabilityText(flavour: GpuFlavour): string {
  return flavour.available === true ? 'vrij' : flavour.available === false ? 'bezet' : 'onbekend'
}

/** Toasts for flavours that came free or ran out since the last check. */
export function describeAvailabilityChange(before: readonly GpuFlavour[], after: readonly GpuFlavour[]): string[] {
  const old = new Map(before.map(f => [f.name, f.available]))
  const said: string[] = []
  for (const f of after) {
    const was = old.get(f.name)
    if (was === false && f.available === true) said.push(`${f.name} is weer beschikbaar.`)
    if (was === true && f.available === false) said.push(`${f.name} is niet meer beschikbaar.`)
  }
  return said
}
