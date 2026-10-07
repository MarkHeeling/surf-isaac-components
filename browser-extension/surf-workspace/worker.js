// The extension's logic: fetch, compare with the last state, notify, and run
// start/stop. Everything browser-specific comes in through `io`, so the tests
// can drive it with fakes; background.js wires it to `chrome.*`.

import {
  DEFAULT_SETTINGS,
  actionUrl,
  badge,
  describeAvailabilityChange,
  describeChange,
  headers,
  isAvailable,
  isSlowResume,
  isTransitioning,
  listUrl,
  minutesSince,
  offeringsUrl,
  parseAvailability,
  parseList,
  summary,
} from './surf.js'

export const EMPTY_STATE = {
  workspaces: [],
  flavours: [],
  error: null,
  updatedAt: null,
  /** Epoch ms per workspace id since it was first seen resuming. */
  resumingSince: {},
  /** Workspace ids that already got the slow-start notification. */
  warned: [],
  /** Workspace ids with "Melding als vrij" on: one notification when their GPUs are free. */
  watch: [],
  /** Workspace id with an action in flight. */
  busy: null,
  /** Per workspace id the transition just asked for, until SURF shows it: {status, at}. */
  pending: {},
  /** Epoch ms of the last check that reached SURF (success or not). */
  lastCheckAt: null,
  /** Failed checks in a row, for the back-off. */
  failures: 0,
  /** No check before this epoch ms (back-off, Retry-After, refused token). */
  retryAt: null,
  /** Where the offerings answer: 'v1' or 'root' (without /v1), once known. */
  offeringsPath: null,
}

/** How long SURF may still report the old status after a start/stop request. */
const PENDING_MS = 60_000

// Load on SURF: one check is the workspace list plus, while a workspace is
// not running, the offerings. There is no check in the background unless it
// is needed: opening the popup (or Vernieuwen) checks once, a start or stop
// is followed every 30 s until it is done, and "Melding als vrij" checks every
// minute until the GPUs are free (see pollMinutes). Never more than one check
// per MIN_GAP_MS; failures back off exponentially.
export const MIN_GAP_MS = 20_000
export const FAST_MINUTES = 0.5
export const WATCH_MINUTES = 1
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 15 * 60_000
/** A refused token is not retried on its own; a new token in the settings retries at once. */
const REFUSED_TOKEN_MS = 60 * 60_000

export function backoffMs(failures) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS)
}

/** Seconds from a Retry-After header (seconds or an HTTP date), in ms; undefined if absent. */
function retryAfterMs(response, now) {
  const value = response.headers?.get?.('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/**
 * @param io {{
 *   fetch: typeof fetch,
 *   load: () => Promise<{settings: object, state: object}>,
 *   save: (state: object) => Promise<void>,
 *   notify: (text: string) => Promise<void>,
 *   setBadge: (badge: {text: string, color: string, title: string}) => Promise<void>,
 *   now: () => number,
 * }}
 */
export function createWorker(io) {
  let inFlight = null

  async function load() {
    const { settings, state } = await io.load()
    return { settings: { ...DEFAULT_SETTINGS, ...settings }, state: { ...EMPTY_STATE, ...state } }
  }

  async function show(state, settings) {
    const b = badge(state.workspaces, state.flavours, state.error, settings.main)
    await io.setBadge({ ...b, title: summary(state.workspaces, state.flavours, state.error) })
  }

  /** Records a failed check and when the next one may run. */
  async function fail(state, settings, why, { now = io.now(), wait } = {}) {
    const failures = state.failures + 1
    const retryAt = now + Math.max(wait ?? 0, backoffMs(failures))
    const next = { ...state, error: why, failures, retryAt, lastCheckAt: now }
    await io.save(next)
    await show(next, settings)
    return next
  }

  /**
   * Reads the catalog item's offerings, where the portal's create dialog gets
   * its GPU availability; nothing is created. Returns the flavours (empty when
   * the check fails, so nothing stale is shown) and the path that answered.
   */
  async function fetchAvailability(settings, path) {
    if (!settings.catalogItem || !settings.co) return { flavours: [], path }
    const products = settings.products.split(',').map(p => p.trim()).filter(Boolean)
    const v1 = offeringsUrl(settings.catalogItem, settings.co, products)
    const root = v1.replace('/v1/', '/')
    try {
      let response = await io.fetch(path === 'root' ? root : v1, { headers: headers(settings.token) })
      if (response.status === 404 && path !== 'root') {
        // The portal itself calls the gateway without the /v1 prefix; remember which one works.
        response = await io.fetch(root, { headers: headers(settings.token) })
        path = 'root'
      } else if (response.ok) {
        path ??= 'v1'
      }
      return { flavours: response.ok ? parseAvailability(await response.text()) : [], path }
    } catch {
      return { flavours: [], path }
    }
  }

  async function doRefresh({ force = false, reset = false } = {}) {
    const loaded = await load()
    const { settings } = loaded
    const state = reset ? { ...loaded.state, failures: 0, retryAt: null, offeringsPath: null } : loaded.state
    const now = io.now()
    if (!settings.token) {
      const next = { ...state, error: 'geen API-token (zie Instellingen)' }
      await io.save(next)
      await show(next, settings)
      return next
    }
    if (!force && state.retryAt !== null && now < state.retryAt) return state
    if (!force && state.lastCheckAt !== null && now - state.lastCheckAt < MIN_GAP_MS) return state
    try {
      const response = await io.fetch(listUrl(), { headers: headers(settings.token) })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return fail(state, settings, 'token geweigerd', { now, wait: REFUSED_TOKEN_MS })
        const wait = retryAfterMs(response, now)
        return fail(state, settings, response.status === 429 ? 'te veel verzoeken, even wachten' : `HTTP ${response.status}`, { now, wait })
      }
      const pending = { ...state.pending }
      const fresh = parseList(await response.text(), settings.filter).map(ws => {
        const asked = pending[ws.id]
        if (!asked) return ws
        // Right after a start/stop SURF can still report the old status; keep
        // showing the transition for a short while instead of calling it failed.
        if (now - asked.at < PENDING_MS && !isTransitioning(ws.status) && ws.status === asked.from) {
          return { ...ws, status: asked.status }
        }
        delete pending[ws.id]
        return ws
      })
      const before = new Map(state.workspaces.map(w => [w.id, w]))
      const since = { ...state.resumingSince }
      const warned = new Set(state.warned)
      const say = []

      for (const ws of fresh) {
        const change = describeChange(before.get(ws.id), ws)
        if (change) say.push(change)
        if (ws.status === 'resuming') {
          const start = (since[ws.id] ??= now)
          if (!warned.has(ws.id) && isSlowResume(start, now, Number(settings.warnMinutes))) {
            warned.add(ws.id)
            say.push(`${ws.name} start na ${minutesSince(start, now)} min nog steeds op. Mogelijk geen GPU's vrij.`)
          }
        } else {
          delete since[ws.id]
          warned.delete(ws.id)
        }
      }

      // Availability only matters for a workspace that is not running.
      const needsGpus = fresh.some(w => w.status !== 'running')
      const { flavours, path } = needsGpus
        ? await fetchAvailability(settings, state.offeringsPath)
        : { flavours: state.flavours, path: state.offeringsPath }
      // "Melding als vrij": one notification, then it switches itself off; it also
      // ends when the workspace is no longer stopped (started from the portal) or gone.
      const free = needsGpus ? describeAvailabilityChange(flavours, fresh, state.watch) : []
      say.push(...free)
      const watch = state.watch.filter(id => {
        const ws = fresh.find(w => w.id === id)
        return ws?.status === 'paused' && isAvailable(ws, flavours) !== true
      })

      const next = {
        ...state,
        workspaces: fresh,
        flavours,
        error: null,
        updatedAt: now,
        resumingSince: since,
        warned: [...warned],
        watch,
        pending,
        lastCheckAt: now,
        failures: 0,
        retryAt: null,
        offeringsPath: path,
      }
      await io.save(next)
      await show(next, settings)
      if (settings.notify) for (const text of say) await io.notify(text)
      return next
    } catch (err) {
      return fail(state, settings, err instanceof Error ? err.message : String(err), { now })
    }
  }

  /**
   * One refresh at a time; a second caller waits for the running one. Without
   * `force` it does nothing within MIN_GAP_MS of the last check or during a
   * back-off; `reset` (new settings) also clears the back-off.
   */
  function refresh(options) {
    inFlight ??= doRefresh(options).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** Start (`resume`) or stop (`pause`) one workspace. Returns a message when it was refused. */
  async function act(id, action) {
    const { settings, state } = await load()
    const ws = state.workspaces.find(w => w.id === id)
    if (!ws) return 'workspace niet gevonden'
    if (state.busy) return 'er loopt al een actie'
    if (action === 'resume' && isAvailable(ws, state.flavours) === false) {
      // Starting without free GPUs only ends in the portal's timeout: wait for the notification instead.
      return `${ws.name} niet gestart: GPU's niet beschikbaar.`
    }
    await io.save({ ...state, busy: id })
    let refused
    try {
      const response = await io.fetch(actionUrl(id, action), { method: 'POST', headers: headers(settings.token), body: '{}' })
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200)
        refused = `${action === 'resume' ? 'starten' : 'stoppen'} geweigerd: HTTP ${response.status} ${text}`.trim()
      } else {
        // Show the transition at once so polling switches to the fast interval.
        const status = action === 'resume' ? 'resuming' : 'pausing'
        const workspaces = state.workspaces.map(w => (w.id === id ? { ...w, status } : w))
        const pending = { ...state.pending, [id]: { status, from: ws.status, at: io.now() } }
        await io.save({ ...state, workspaces, pending, busy: id })
      }
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err)
    }
    // One check right after the request; no force, so a double click cannot pile up checks.
    const after = await refresh({ force: !refused })
    await io.save({ ...after, busy: null })
    return refused
  }

  /** Turns "Melding als vrij" on or off for one workspace. */
  async function watch(id, on) {
    const { state } = await load()
    const rest = state.watch.filter(w => w !== id)
    await io.save({ ...state, watch: on ? [...rest, id] : rest })
  }

  /**
   * How often the background should check, in minutes, or null for not at
   * all: fast while a workspace starts or stops, slower while a workspace
   * waits for free GPUs, otherwise only when the popup is opened.
   */
  async function pollMinutes() {
    const { state } = await load()
    if (state.workspaces.some(w => isTransitioning(w.status))) return FAST_MINUTES
    if (state.watch.length > 0) return WATCH_MINUTES
    return null
  }

  return { refresh, act, watch, pollMinutes }
}
