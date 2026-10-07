import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GpuFlavour, Workspace } from '../types'
import {
  FAST_POLL_MS,
  PORTAL,
  actionUrl,
  availabilityText,
  describeAvailabilityChange,
  describeChange,
  headers,
  isSlowResume,
  isTransitioning,
  listUrl,
  minutesSince,
  offeringsUrl,
  parseAvailability,
  parseList,
  relevantFlavours,
  statusLine,
} from './surf'

const PANE = 'surf-workspace'

const workspaces = atom({ plugin: 'surf-workspace', key: 'workspaces' } as const, [])
const error = atom({ plugin: 'surf-workspace', key: 'error' } as const, null)
const updatedAt = atom({ plugin: 'surf-workspace', key: 'updatedAt' } as const, null)
const busy = atom({ plugin: 'surf-workspace', key: 'busy' } as const, null)
const confirm = atom({ plugin: 'surf-workspace', key: 'confirm' } as const, null)
const resumingSince = atom({ plugin: 'surf-workspace', key: 'resumingSince' } as const, {})
const flavours = atom({ plugin: 'surf-workspace', key: 'flavours' } as const, [])
const flavoursError = atom({ plugin: 'surf-workspace', key: 'flavoursError' } as const, null)

const STATUS_COLOR: Record<string, string> = {
  running: 'success',
  paused: 'inactive',
  resuming: 'warning',
  pausing: 'warning',
  failed: 'error',
  unhealthy: 'error',
}

type Config = {
  token: string
  filter: string
  idleMs: number
  warnMinutes: number
  notifyMacos: boolean
  catalogItem: string
  co: string
  products: string[]
}

// Module-level bookkeeping; a reload starts it over, which only costs one early fetch.
let cfg: Config = {
  token: '',
  filter: '',
  idleMs: 60_000,
  warnMinutes: 4,
  notifyMacos: true,
  catalogItem: '',
  co: '',
  products: [],
}
let lastFetch = 0
let inFlight = false
const warned = new Set<string>()

/**
 * The token from, in order: the plugin's own setting (secure storage when the
 * plugin is installed), the SURF_RC_TOKEN environment variable, or the macOS
 * keychain item `surf-research-cloud` (`security add-generic-password`).
 */
async function resolveToken($: EngineInterface): Promise<void> {
  if (cfg.token) return
  cfg.token = ((await $.env.get('SURF_RC_TOKEN')) ?? '').trim()
  if (cfg.token) return
  try {
    const found = await $.process.run(['security', 'find-generic-password', '-s', 'surf-research-cloud', '-w'])
    if (found.exitCode === 0) cfg.token = found.stdout.trim()
  } catch {
    // No macOS keychain here.
  }
}

async function tell($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text, { timeoutMs: 10_000 })
  if (!cfg.notifyMacos) return
  const quoted = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  try {
    await $.process.run(['osascript', '-e', `display notification "${quoted}" with title "SURF Research Cloud"`])
  } catch {
    // Not on macOS, or osascript refused: the toast is enough.
  }
}

/**
 * Reads the catalog item's offerings, where the portal's create dialog gets
 * its GPU availability; nothing is created. Toasts when a flavour comes free.
 */
async function refreshAvailability($: EngineInterface): Promise<GpuFlavour[]> {
  const known = await read($, flavours)
  if (!cfg.catalogItem || !cfg.co) return known
  try {
    const url = offeringsUrl(cfg.catalogItem, cfg.co, cfg.products)
    let response = await $.http.fetch(url, { headers: headers(cfg.token) })
    if (response.status === 404) {
      // The portal itself calls the gateway without the /v1 prefix.
      response = await $.http.fetch(url.replace('/v1/', '/'), { headers: headers(cfg.token) })
    }
    if (!response.ok) {
      await update($, flavoursError, () => `beschikbaarheid: HTTP ${response.status}`)
      return known
    }
    const fresh = parseAvailability(response.text)
    for (const text of describeAvailabilityChange(known, fresh)) await tell($, text)
    await update($, flavours, () => fresh)
    await update($, flavoursError, () => null)
    return fresh
  } catch (err) {
    await update($, flavoursError, () => `beschikbaarheid: ${err instanceof Error ? err.message : String(err)}`)
    return known
  }
}

async function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return
  if (!cfg.token) {
    $.ui.status('SURF: geen API-token (zie README: SURF_RC_TOKEN of keychain)')
    return
  }
  inFlight = true
  try {
    const response = await $.http.fetch(listUrl(), { headers: headers(cfg.token) })
    const now = await $.clock.now()
    if (!response.ok) {
      const why = response.status === 401 || response.status === 403 ? 'token geweigerd' : `HTTP ${response.status}`
      await update($, error, () => why)
      $.ui.status(statusLine([], why))
      return
    }
    const fresh = parseList(response.text, cfg.filter)
    const before = new Map((await read($, workspaces)).map(w => [w.id, w]))
    const since = { ...(await read($, resumingSince)) }

    for (const ws of fresh) {
      const change = describeChange(before.get(ws.id), ws)
      if (change.say) await tell($, change.say)

      if (ws.status === 'resuming') {
        const start = (since[ws.id] ??= now)
        if (!warned.has(ws.id) && isSlowResume(start, now, cfg.warnMinutes)) {
          warned.add(ws.id)
          await tell($, `${ws.name} is na ${minutesSince(start, now)} min nog aan het starten; mogelijk geen GPU's vrij.`)
        }
      } else {
        delete since[ws.id]
        warned.delete(ws.id)
      }
    }

    const gpus = await refreshAvailability($)
    lastFetch = now
    await update($, workspaces, () => fresh)
    await update($, resumingSince, () => since)
    await update($, updatedAt, () => now)
    await update($, error, () => null)
    $.ui.status(statusLine(fresh, null, gpus))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, error, () => why)
    $.ui.status(statusLine([], why))
  } finally {
    inFlight = false
  }
}

async function act($: EngineInterface, ws: Workspace, action: 'pause' | 'resume'): Promise<void> {
  await update($, confirm, () => null)
  const gpu = (await read($, flavours)).find(f => f.name === ws.flavour)
  if (action === 'resume' && gpu?.available === false) {
    // Starting without free GPUs only ends in the portal's timeout: wait for the toast instead.
    $.ui.toast(`${ws.name} niet gestart: geen ${gpu.name} vrij.`, { timeoutMs: 10_000 })
    return
  }
  await update($, busy, () => ws.id)
  try {
    const response = await $.http.fetch(actionUrl(ws.id, action), {
      method: 'POST',
      headers: headers(cfg.token),
      body: '{}',
    })
    if (!response.ok) {
      const why = `${action === 'resume' ? 'starten' : 'pauzeren'} geweigerd: HTTP ${response.status} ${response.text.slice(0, 200)}`
      await update($, error, () => why)
      $.ui.toast(`${ws.name}: ${why}`, { timeoutMs: 10_000 })
      return
    }
    // Show the transition at once so polling switches to the fast interval.
    const status = action === 'resume' ? 'resuming' : 'pausing'
    await update($, workspaces, list => list.map(w => (w.id === ws.id ? { ...w, status } : w)))
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, busy, () => null)
  }
  await refresh($)
}

export const register: Register = (on, options) => {
  cfg = {
    token: String(options.api_token ?? ''),
    filter: String(options.workspace ?? ''),
    idleMs: Math.max(15, Number(options.poll_seconds ?? 60)) * 1000,
    warnMinutes: Number(options.resume_warn_minutes ?? 4),
    notifyMacos: options.notify_macos !== false,
    catalogItem: String(options.catalog_item ?? '').trim(),
    co: String(options.co_id ?? '').trim(),
    products: String(options.products ?? '')
      .split(',')
      .map(p => p.trim())
      .filter(Boolean),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'surf',
      description: 'SURF Research Cloud: paneel met status, GPU-beschikbaarheid, starten en stoppen; "/surf status" geeft alleen de status',
      argumentHint: '[status]',
    })
    void resolveToken($).then(() => refresh($))
    $.clock.every(FAST_POLL_MS, async () => {
      const now = await $.clock.now()
      const list = await read($, workspaces)
      const isMoving = list.some(w => isTransitioning(w.status))
      if (isMoving || now - lastFetch >= cfg.idleMs) await refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'surf' }, async ($, e) => {
    // "/surf status" only reads; plain "/surf" opens the pane with the buttons.
    if (e.args.trim() !== 'status') await $.ui.open({ id: PANE, title: 'SURF Research Cloud' })
    await refresh($)
    const err = await read($, error)

    return { text: statusLine(await read($, workspaces), err, await read($, flavours)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, workspaces)
    const err = await read($, error)
    const at = await read($, updatedAt)
    const pending = await read($, busy)
    const asking = await read($, confirm)
    const since = await read($, resumingSince)
    const gpus = await read($, flavours)
    const gpuErr = await read($, flavoursError)
    const now = await $.clock.now()
    const isFree = (ws: Workspace) => gpus.find(f => f.name === ws.flavour)?.available

    return (
      <Box flexDirection="column">
        {!cfg.token && <Text color="warning">Geen API-token gevonden: zet SURF_RC_TOKEN of het keychain-item surf-research-cloud (zie README).</Text>}
        {err && <Text color="error">Fout: {err}</Text>}
        {cfg.token && list.length === 0 && !err && <Text dimColor>Geen workspaces gevonden{cfg.filter ? ` met "${cfg.filter}" in de naam` : ''}.</Text>}
        {gpus.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>GPU-beschikbaarheid</Text>
            {relevantFlavours(gpus, list).map(f => (
              <Text key={`gpu-${f.name}`}>
                {f.name}{'  '}
                <Text color={f.available === true ? 'success' : f.available === false ? 'error' : 'inactive'}>{availabilityText(f)}</Text>
              </Text>
            ))}
          </Box>
        )}
        {gpuErr && <Text dimColor>{gpuErr}</Text>}
        {list.map(ws => (
          <Box flexDirection="column" marginBottom={1} key={ws.id}>
            <Text>
              <Text bold>{ws.name}</Text>{'  '}
              <Text color={STATUS_COLOR[ws.status] ?? 'text'}>{ws.status}</Text>
              {ws.status === 'resuming' && since[ws.id] !== undefined && (
                <Text dimColor> ({minutesSince(since[ws.id] ?? now, now)} min)</Text>
              )}
            </Text>
            {(ws.flavour || ws.ip) && <Text dimColor>{[ws.flavour, ws.ip].filter(Boolean).join(' · ')}</Text>}
            {ws.lastAction?.message && (
              <Text dimColor wrap="wrap">
                Laatste actie {ws.lastAction.type ?? ''} {ws.lastAction.status ?? ''}: {ws.lastAction.message}
              </Text>
            )}
            <Box>
              {pending === ws.id && <Text dimColor>bezig…</Text>}
              {pending !== ws.id && ws.status === 'paused' && isFree(ws) === false && (
                <Text color="warning">Geen {ws.flavour} vrij. Je krijgt een melding zodra hij vrijkomt.</Text>
              )}
              {pending !== ws.id && ws.status === 'paused' && isFree(ws) !== false && (
                <Button key={`resume-${ws.id}`} variant="primary" label="Starten" onPress={() => act($, ws, 'resume')} />
              )}
              {pending !== ws.id && ws.status === 'running' && asking !== ws.id && (
                <Button key={`ask-${ws.id}`} label="Stoppen" onPress={() => update($, confirm, () => ws.id)} />
              )}
              {pending !== ws.id && ws.status === 'running' && asking === ws.id && (
                <Box>
                  <Text color="warning">Pauzeren? </Text>
                  <Button key={`pause-${ws.id}`} label="Ja, pauzeer" onPress={() => act($, ws, 'pause')} />
                  <Button key={`cancel-${ws.id}`} label="Nee" onPress={() => update($, confirm, () => null)} />
                </Box>
              )}
            </Box>
          </Box>
        ))}
        <Box>
          <Button key="refresh" label="Vernieuwen" hotkey="r" onPress={() => refresh($)} />
          <Text dimColor>
            {' '}
            {at ? `bijgewerkt ${Math.max(0, Math.round((now - at) / 1000))} s geleden` : 'nog niet opgehaald'} · {PORTAL}
          </Text>
        </Box>
      </Box>
    )
  })
}
