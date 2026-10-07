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
  /** Workspace id with an action in flight. */
  busy: null,
  /** Per workspace id the transition just asked for, until SURF shows it: {status, at}. */
  pending: {},
}

/** How long SURF may still report the old status after a start/stop request. */
const PENDING_MS = 60_000

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

  async function show(state) {
    const b = badge(state.workspaces, state.flavours, state.error)
    await io.setBadge({ ...b, title: summary(state.workspaces, state.flavours, state.error) })
  }

  async function fail(state, why) {
    const next = { ...state, error: why }
    await io.save(next)
    await show(next)
    return next
  }

  /**
   * Reads the catalog item's offerings, where the portal's create dialog gets
   * its GPU availability; nothing is created. Empty when the check fails, so
   * nothing is shown rather than a stale answer.
   */
  async function fetchAvailability(settings) {
    if (!settings.catalogItem || !settings.co) return []
    const products = settings.products.split(',').map(p => p.trim()).filter(Boolean)
    const url = offeringsUrl(settings.catalogItem, settings.co, products)
    try {
      let response = await io.fetch(url, { headers: headers(settings.token) })
      if (response.status === 404) {
        // The portal itself calls the gateway without the /v1 prefix.
        response = await io.fetch(url.replace('/v1/', '/'), { headers: headers(settings.token) })
      }
      return response.ok ? parseAvailability(await response.text()) : []
    } catch {
      return []
    }
  }

  async function doRefresh() {
    const { settings, state } = await load()
    if (!settings.token) return fail(state, 'geen API-token (zie Instellingen)')
    try {
      const response = await io.fetch(listUrl(), { headers: headers(settings.token) })
      if (!response.ok) {
        return fail(state, response.status === 401 || response.status === 403 ? 'token geweigerd' : `HTTP ${response.status}`)
      }
      const now = io.now()
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
            say.push(`${ws.name} is na ${minutesSince(start, now)} min nog aan het starten; mogelijk geen GPU's vrij.`)
          }
        } else {
          delete since[ws.id]
          warned.delete(ws.id)
        }
      }

      const flavours = await fetchAvailability(settings)
      say.push(...describeAvailabilityChange(state.flavours, flavours, fresh))

      const next = {
        ...state,
        workspaces: fresh,
        flavours,
        error: null,
        updatedAt: now,
        resumingSince: since,
        warned: [...warned],
        pending,
      }
      await io.save(next)
      await show(next)
      if (settings.notify) for (const text of say) await io.notify(text)
      return next
    } catch (err) {
      return fail(state, err instanceof Error ? err.message : String(err))
    }
  }

  /** One refresh at a time; a second caller waits for the running one. */
  function refresh() {
    inFlight ??= doRefresh().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** Start (`resume`) or stop (`pause`) one workspace. Returns a message when it was refused. */
  async function act(id, action) {
    const { settings, state } = await load()
    const ws = state.workspaces.find(w => w.id === id)
    if (!ws) return 'workspace niet gevonden'
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
    const after = await refresh()
    await io.save({ ...after, busy: null })
    return refused
  }

  async function isMoving() {
    const { state } = await load()
    return state.workspaces.some(w => isTransitioning(w.status))
  }

  return { refresh, act, isMoving }
}
