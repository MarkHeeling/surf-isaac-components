// Pure helpers for the SURF Research Cloud API: URLs, parsing and the
// transition rules. No `chrome.*` here, so the tests can run them in Node.
//
// API: https://servicedesk.surf.nl/wiki/spaces/WIKI/pages/174981256 (first
// steps) and the Swagger page at https://gw.live.surfresearchcloud.nl/v1/workspace/swagger/docs/.
// Auth is the bare token in an `authorization` header. Start/stop in the
// portal are the `resume`/`pause` actions. Field names below were checked
// against the live API on 2026-10-07.

export const WORKSPACE_API = 'https://gw.live.surfresearchcloud.nl/v1/workspace'
export const CATALOG_API = 'https://gw.live.surfresearchcloud.nl/v1/application-market'
export const PORTAL = 'https://portal.live.surfresearchcloud.nl/'

export const DEFAULT_SETTINGS = {
  token: '',
  /** Only show workspaces whose name contains this text; empty shows all. */
  filter: '',
  /** Catalog item whose offerings carry the GPU availability; empty turns the check off. */
  catalogItem: 'ca0f2d7e-9bcb-4e8c-b902-e4b656dc180e',
  co: '9e2da160-b184-4c14-8157-2256df95f9ef',
  products: 'daphne-compute,hpcc-hdd,hpcc-ssd,daphne-gpu',
  /** Notification when a start is still running after this many minutes; 0 turns it off. */
  warnMinutes: 4,
  notify: true,
}

/** Statuses during which the workspace is on its way somewhere: poll fast. */
const TRANSITIONING = new Set(['creating', 'resuming', 'pausing', 'updating', 'rebooting', 'deleting'])

const STATUS_TEXT = {
  running: 'draait',
  paused: 'gestopt',
  resuming: 'start op',
  pausing: 'stopt',
}

export function listUrl() {
  // Without these filters the list holds every workspace of the CO, deleted ones included.
  return `${WORKSPACE_API}/workspaces/?application_type=Compute&deleted=false&by_owner=true&limit=100`
}

export function actionUrl(id, action) {
  return `${WORKSPACE_API}/workspaces/${encodeURIComponent(id)}/actions/${action}/`
}

export function offeringsUrl(catalogItem, co, products) {
  const query = [`co=${encodeURIComponent(co)}`, ...products.map(p => `product=${encodeURIComponent(p)}`)].join('&')
  return `${CATALOG_API}/catalog_items/${encodeURIComponent(catalogItem)}/offerings/?${query}`
}

export function headers(token) {
  return { accept: 'application/json', authorization: token.trim(), 'content-type': 'application/json' }
}

export function isTransitioning(status) {
  return TRANSITIONING.has(status)
}

export function statusText(status) {
  return STATUS_TEXT[status] ?? status
}

const asObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined)

const asString = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

function sizeFlavour(raw) {
  const flavours = asObject(raw.meta)?.flavours
  if (!Array.isArray(flavours)) return undefined
  return asString(flavours.map(asObject).find(f => f?.category === 'size')?.name)
}

/**
 * The newest action with SURF's error text when it failed. The history is in
 * `workspace_actions` (`actions` is only the list of allowed action names);
 * the text is in `result.error`, while `reason` says who started it ("API").
 */
function lastAction(raw) {
  const actions = raw.workspace_actions
  if (!Array.isArray(actions)) return undefined
  const last = actions
    .map(asObject)
    .filter(Boolean)
    .sort((a, b) => String(a.time_created ?? '').localeCompare(String(b.time_created ?? '')))
    .at(-1)
  if (!last) return undefined
  const status = asString(last.status)?.toLowerCase()
  const result = asObject(last.result)
  const error = asString(result?.error) ?? asString(result?.message)
  return {
    type: asString(last.type),
    status,
    message: error ?? (status === 'failed' ? 'onbekende fout' : undefined),
  }
}

export function parseWorkspace(value) {
  const raw = asObject(value)
  const id = asString(raw?.id)
  if (!raw || !id) return undefined
  return {
    id,
    name: asString(raw.name) ?? id,
    status: (asString(raw.status) ?? (raw.active === true ? 'running' : 'unknown')).toLowerCase(),
    ip: asString(asObject(raw.resource_meta)?.ip),
    flavour: sizeFlavour(raw),
    lastAction: lastAction(raw),
  }
}

/** Parses a (paginated) list answer and keeps the names matching `filter`. */
export function parseList(text, filter) {
  const body = JSON.parse(text)
  const results = Array.isArray(body) ? body : asObject(body)?.results
  if (!Array.isArray(results)) throw new Error('onverwacht antwoord: geen results-lijst')
  const needle = filter.trim().toLowerCase()
  return results
    .map(parseWorkspace)
    .filter(Boolean)
    .filter(w => needle === '' || w.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// GPU availability: the portal's create dialog reads it from the catalog
// item's offerings, one `available` flag per flavour (true, false, or null
// for flavours without a capacity check, like the OS image).

/** The size flavours of every offering with their `available` flag, by name. */
export function parseAvailability(text) {
  const body = JSON.parse(text)
  const offerings = Array.isArray(body) ? body : asObject(body)?.results
  if (!Array.isArray(offerings)) throw new Error('onverwacht antwoord: geen offerings-lijst')
  const byName = new Map()
  for (const offering of offerings) {
    const flavours = asObject(offering)?.flavours
    if (!Array.isArray(flavours)) continue
    for (const raw of flavours.map(asObject)) {
      const name = asString(raw?.name)
      if (!raw || !name || raw.category !== 'size') continue
      byName.set(name, { name, available: typeof raw.available === 'boolean' ? raw.available : null })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether the GPUs this workspace needs are free: true, false, or undefined when unknown. */
export function isAvailable(ws, flavours) {
  const available = flavours.find(f => f.name === ws.flavour)?.available
  return typeof available === 'boolean' ? available : undefined
}

/** "GPU's beschikbaar" / "GPU's niet beschikbaar"; nothing while it runs or when unknown. */
export function availabilityText(ws, flavours) {
  if (ws.status === 'running') return undefined
  const available = isAvailable(ws, flavours)
  return available === undefined ? undefined : available ? "GPU's beschikbaar" : "GPU's niet beschikbaar"
}

/** Notification text for a status change from `before` to `after`, if it is worth one. */
export function describeChange(before, after) {
  if (!before || before.status === after.status) return undefined
  if (before.status === 'resuming' && after.status === 'running') return `${after.name} draait weer.`
  if (before.status === 'resuming') {
    const why = after.lastAction?.status === 'failed' ? after.lastAction.message : undefined
    return `${after.name}: starten mislukt${why ? ` (${why})` : ''}. Waarschijnlijk geen GPU's vrij.`
  }
  if (before.status === 'pausing' && after.status === 'paused') return `${after.name} is gestopt.`
  return undefined
}

/** Notifications for the workspaces whose GPUs came free since the last check. */
export function describeAvailabilityChange(before, after, workspaces) {
  return workspaces
    .filter(w => w.status !== 'running' && isAvailable(w, before) === false && isAvailable(w, after) === true)
    .map(w => `${w.name}: GPU's weer beschikbaar, je kunt starten.`)
}

/** True once a resume has run longer than `warnMinutes`. */
export function isSlowResume(resumingSince, now, warnMinutes) {
  return resumingSince !== undefined && warnMinutes > 0 && now - resumingSince >= warnMinutes * 60_000
}

export function minutesSince(since, now) {
  return Math.floor((now - since) / 60_000)
}

/** The toolbar badge: short text and colour for the first workspace. */
export function badge(workspaces, flavours, error) {
  if (error) return { text: '!', color: '#c62828' }
  const ws = workspaces[0]
  if (!ws) return { text: '', color: '#757575' }
  if (ws.status === 'running') return { text: 'aan', color: '#2e7d32' }
  if (isTransitioning(ws.status)) return { text: '…', color: '#ef6c00' }
  if (ws.status === 'paused') {
    const available = isAvailable(ws, flavours)
    if (available === false) return { text: 'vol', color: '#c62828' }
    if (available === true) return { text: 'vrij', color: '#1565c0' }
    return { text: 'uit', color: '#757575' }
  }
  return { text: '!', color: '#c62828' }
}

/** The one-line summary, used as the toolbar tooltip. */
export function summary(workspaces, flavours, error) {
  if (error) return `SURF: ${error}`
  if (workspaces.length === 0) return 'SURF: geen workspace gevonden'
  const parts = workspaces.map(w => [`${w.name} ${statusText(w.status)}`, availabilityText(w, flavours)].filter(Boolean).join(' · '))
  return 'SURF: ' + parts.join(' | ')
}
