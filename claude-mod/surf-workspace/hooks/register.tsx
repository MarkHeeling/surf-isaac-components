import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GpuFlavour, Workspace } from '../types'
import {
  FAST_POLL_MS,
  actionUrl,
  availabilityText,
  describeAvailabilityChange,
  describeChange,
  headers,
  isAvailable,
  isTransitioning,
  listUrl,
  offeringsUrl,
  parseAvailability,
  parseList,
  statusLine,
  statusText,
} from './surf'

const PANE = 'surf-workspace'

const workspaces = atom({ plugin: 'surf-workspace', key: 'workspaces' } as const, [])
const error = atom({ plugin: 'surf-workspace', key: 'error' } as const, null)
const busy = atom({ plugin: 'surf-workspace', key: 'busy' } as const, null)
const confirm = atom({ plugin: 'surf-workspace', key: 'confirm' } as const, null)
const flavours = atom({ plugin: 'surf-workspace', key: 'flavours' } as const, [])

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
  notifyMacos: boolean
  catalogItem: string
  co: string
  products: string[]
}

// Module-level bookkeeping; a reload starts it over, which only costs one early fetch.
let cfg: Config = { token: '', filter: '', idleMs: 60_000, notifyMacos: true, catalogItem: '', co: '', products: [] }
let lastFetch = 0
let inFlight = false

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
 * its GPU availability; nothing is created. Empty when the check fails, so
 * the status shows nothing rather than a stale answer.
 */
async function fetchAvailability($: EngineInterface): Promise<GpuFlavour[]> {
  if (!cfg.catalogItem || !cfg.co) return []
  try {
    const url = offeringsUrl(cfg.catalogItem, cfg.co, cfg.products)
    let response = await $.http.fetch(url, { headers: headers(cfg.token) })
    if (response.status === 404) {
      // The portal itself calls the gateway without the /v1 prefix.
      response = await $.http.fetch(url.replace('/v1/', '/'), { headers: headers(cfg.token) })
    }
    return response.ok ? parseAvailability(response.text) : []
  } catch {
    return []
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
    if (!response.ok) {
      const why = response.status === 401 || response.status === 403 ? 'token geweigerd' : `HTTP ${response.status}`
      await update($, error, () => why)
      $.ui.status(statusLine([], why))
      return
    }
    const fresh = parseList(response.text, cfg.filter)
    const before = new Map((await read($, workspaces)).map(w => [w.id, w]))
    for (const ws of fresh) {
      const say = describeChange(before.get(ws.id), ws)
      if (say) await tell($, say)
    }

    const gpus = await fetchAvailability($)
    for (const say of describeAvailabilityChange(await read($, flavours), gpus, fresh)) await tell($, say)

    lastFetch = await $.clock.now()
    await update($, workspaces, () => fresh)
    await update($, flavours, () => gpus)
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
  if (action === 'resume' && isAvailable(ws, await read($, flavours)) === false) {
    // Starting without free GPUs only ends in the portal's timeout: wait for the toast instead.
    $.ui.toast(`${ws.name} niet gestart: GPU's niet beschikbaar.`, { timeoutMs: 10_000 })
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
      const why = `${action === 'resume' ? 'starten' : 'stoppen'} geweigerd: HTTP ${response.status} ${response.text.slice(0, 200)}`
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
      description: 'SURF Research Cloud: of je server beschikbaar is, starten en stoppen; "/surf status" geeft alleen de status',
      argumentHint: '[status]',
    })
    void resolveToken($).then(() => refresh($))
    $.clock.every(FAST_POLL_MS, async () => {
      const now = await $.clock.now()
      const isMoving = (await read($, workspaces)).some(w => isTransitioning(w.status))
      if (isMoving || now - lastFetch >= cfg.idleMs) await refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'surf' }, async ($, e) => {
    // "/surf status" only reads; plain "/surf" opens the pane with the buttons.
    if (e.args.trim() !== 'status') await $.ui.open({ id: PANE, title: 'SURF Research Cloud' })
    await refresh($)

    return { text: statusLine(await read($, workspaces), await read($, error), await read($, flavours)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, workspaces)
    const err = await read($, error)
    const pending = await read($, busy)
    const asking = await read($, confirm)
    const gpus = await read($, flavours)

    return (
      <Box flexDirection="column">
        {!cfg.token && <Text color="warning">Geen API-token gevonden: zet SURF_RC_TOKEN of het keychain-item surf-research-cloud (zie README).</Text>}
        {err && <Text color="error">Fout: {err}</Text>}
        {cfg.token && list.length === 0 && !err && <Text dimColor>Geen workspace gevonden{cfg.filter ? ` met "${cfg.filter}" in de naam` : ''}.</Text>}
        {list.map(ws => {
          const available = isAvailable(ws, gpus)
          const gpuText = availabilityText(ws, gpus)
          return (
            <Box flexDirection="column" marginBottom={1} key={ws.id}>
              <Text>
                <Text bold>{ws.name}</Text>{'  '}
                <Text color={STATUS_COLOR[ws.status] ?? 'text'}>{statusText(ws.status)}</Text>
                {gpuText && (
                  <Text>
                    {'  ·  '}
                    <Text color={available ? 'success' : 'error'}>{gpuText}</Text>
                  </Text>
                )}
              </Text>
              <Box>
                {pending === ws.id && <Text dimColor>bezig…</Text>}
                {pending !== ws.id && ws.status === 'paused' && available === false && (
                  <Text dimColor>Je krijgt een melding zodra ze vrijkomen.</Text>
                )}
                {pending !== ws.id && ws.status === 'paused' && available !== false && (
                  <Button key={`resume-${ws.id}`} variant="primary" label="Starten" onPress={() => act($, ws, 'resume')} />
                )}
                {pending !== ws.id && ws.status === 'running' && asking !== ws.id && (
                  <Button key={`ask-${ws.id}`} label="Stoppen" onPress={() => update($, confirm, () => ws.id)} />
                )}
                {pending !== ws.id && ws.status === 'running' && asking === ws.id && (
                  <Box>
                    <Text color="warning">Stoppen? </Text>
                    <Button key={`pause-${ws.id}`} label="Ja, stop" onPress={() => act($, ws, 'pause')} />
                    <Button key={`cancel-${ws.id}`} label="Nee" onPress={() => update($, confirm, () => null)} />
                  </Box>
                )}
              </Box>
            </Box>
          )
        })}
        <Button key="refresh" label="Vernieuwen" hotkey="r" onPress={() => refresh($)} />
      </Box>
    )
  })
}
