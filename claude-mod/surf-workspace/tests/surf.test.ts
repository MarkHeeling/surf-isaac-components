import { describe, expect, mock, test } from 'claude-code/testing'

import { describeAvailabilityChange, describeChange, parseAvailability, parseList, statusLine } from '../hooks/surf'

// Shaped like the live answer (2026-10-07): the portal name is long, the host
// name sits in meta; `actions` only lists allowed action names, the history is
// in `workspace_actions` with the error text in `result.error`.
const workspace = (status: string, actions: unknown[] = []) => ({
  id: 'ws-1',
  name: 'Mark - Isaac Sim - Training planner',
  status,
  active: status === 'running',
  actions: ['resume', 'update_nsgs', 'update_storages'],
  workspace_actions: actions,
  resource_meta: { ip: '145.38.0.1' },
  meta: {
    host_name: 'markisaacsim',
    flavours: [{ name: 'Ubuntu 22.04', category: 'os' }, { name: 'A10 - 2 GPU', category: 'size' }],
  },
})

const FAILED_RESUME = {
  type: 'resume',
  status: 'failed',
  reason: 'API',
  result: { error: 'Timeout waiting for VM to resume.' },
  time_created: '2026-10-07T13:03:00Z',
}

const LIST = JSON.stringify({
  count: 2,
  results: [workspace('paused'), { id: 'ws-2', name: 'other-box', status: 'running', active: true, resource_meta: {} }],
})

// Trimmed from a real offerings answer (2026-10-07): one `available` flag per flavour.
const offerings = (one: boolean, two: boolean) =>
  JSON.stringify({
    count: 1,
    results: [
      {
        id: 'offering-1',
        subscription: { name: 'SURF HPC Cloud', cloud_status: 'up' },
        flavours: [
          { name: 'A10 - 1 GPU', category: 'size', status: 'active', available: one, tags: [{ key: 'GPU', value: '1' }] },
          { name: 'A10 - 2 GPU', category: 'size', status: 'active', available: two, tags: [{ key: 'GPU', value: '2' }] },
          { name: 'Ubuntu 22.04', category: 'os', status: 'active', available: null },
        ],
      },
    ],
  })

const PANE_PROPS = {
  title: 'SURF Research Cloud',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

describe('parsing', () => {
  test('finds the workspace by its host name and shows that name', () => {
    expect(parseList(LIST, 'markisaacsim')).toEqual([
      { id: 'ws-1', name: 'markisaacsim', status: 'paused', flavour: 'A10 - 2 GPU', failure: undefined },
    ])
    expect(parseList(LIST, 'training planner').map(w => w.id)).toEqual(['ws-1'])
    expect(parseList(LIST, '').length).toBe(2)
  })

  test('a failed newest action gives SURF\'s error text, not the reason field', () => {
    const done = { type: 'pause', status: 'done', reason: 'API', result: {}, time_created: '2026-10-01T10:00:00Z' }
    const list = parseList(JSON.stringify({ results: [workspace('paused', [FAILED_RESUME, done])] }), '')
    expect(list[0]?.failure).toBe('Timeout waiting for VM to resume.')
    const ok = parseList(JSON.stringify({ results: [workspace('paused', [{ ...FAILED_RESUME, time_created: '2026-10-01T00:00:00Z' }, done])] }), '')
    expect(ok[0]?.failure).toBeUndefined()
  })
})

describe('availability', () => {
  const ws = [{ id: 'ws-1', name: 'markisaacsim', status: 'paused', flavour: 'A10 - 2 GPU' }]

  test('reads the size flavours and their available flag', () => {
    expect(parseAvailability(offerings(false, true))).toEqual([
      { name: 'A10 - 1 GPU', available: false },
      { name: 'A10 - 2 GPU', available: true },
    ])
  })

  test('the status line says whether the workspace\'s GPUs are available', () => {
    expect(statusLine(ws, null, parseAvailability(offerings(true, false)))).toBe("SURF: markisaacsim gestopt · GPU's niet beschikbaar")
    expect(statusLine(ws, null, parseAvailability(offerings(false, true)))).toBe("SURF: markisaacsim gestopt · GPU's beschikbaar")
    expect(statusLine([{ ...ws[0]!, status: 'running' }], null, parseAvailability(offerings(false, false)))).toBe('SURF: markisaacsim draait')
    expect(statusLine(ws, null, [])).toBe('SURF: markisaacsim gestopt')
    expect(statusLine([], 'token geweigerd')).toBe('SURF: token geweigerd')
  })

  test('a toast only when the workspace\'s own GPUs come free', () => {
    const taken = parseAvailability(offerings(false, false))
    expect(describeAvailabilityChange(taken, parseAvailability(offerings(false, true)), ws)).toEqual([
      "markisaacsim: GPU's weer beschikbaar, je kunt starten.",
    ])
    expect(describeAvailabilityChange(taken, parseAvailability(offerings(true, false)), ws)).toEqual([])
    expect(describeAvailabilityChange([], parseAvailability(offerings(true, true)), ws)).toEqual([])
  })
})

describe('transitions', () => {
  const ws = { id: 'ws-1', name: 'markisaacsim' }

  test('a resume that falls back to paused is a failed start, with SURF\'s reason', () => {
    const say = describeChange({ ...ws, status: 'resuming' }, { ...ws, status: 'paused', failure: 'Timeout waiting for VM to resume.' })
    expect(say).toBe("markisaacsim: starten mislukt (Timeout waiting for VM to resume.). Waarschijnlijk geen GPU's vrij.")
  })

  test('start and stop that work say so', () => {
    expect(describeChange({ ...ws, status: 'resuming' }, { ...ws, status: 'running' })).toBe('markisaacsim draait weer.')
    expect(describeChange({ ...ws, status: 'pausing' }, { ...ws, status: 'paused' })).toBe('markisaacsim is gestopt.')
  })

  test('no change, nothing to say', () => {
    expect(describeChange({ ...ws, status: 'running' }, { ...ws, status: 'running' })).toBeUndefined()
    expect(describeChange(undefined, { ...ws, status: 'running' })).toBeUndefined()
  })
})

test('session start fetches with the token and pins the status line', { options: { api_token: 'secret-token', notify_macos: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const seen: { url: string; auth?: string }[] = []
  const statuses: (string | undefined)[] = []
  on('http.fetch', ($, e) => {
    seen.push({ url: e.url, auth: e.init?.headers?.authorization })
    return { value: { status: 200, ok: true, headers: {}, text: LIST } }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(seen[0]?.url).toContain('/v1/workspace/workspaces/')
  expect(seen[0]?.auth).toBe('secret-token')
  expect(statuses).toContain('SURF: markisaacsim gestopt | other-box draait')
})

test('pressing Starten resumes, and a fall back to paused raises the GPU toast', { options: { api_token: 'secret-token', notify_macos: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const posts: string[] = []
  let status = 'paused'
  on('http.fetch', ($, e) => {
    if (e.init?.method === 'POST') {
      posts.push(e.url)
      status = 'resuming'
      return { value: { status: 202, ok: true, headers: {}, text: '{}' } }
    }
    const body = { results: [workspace(status, status === 'paused' && posts.length ? [FAILED_RESUME] : [])] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'surf-workspace',
      surface,
      component: 'Pane',
      requestId: 'surf-workspace',
      props: PANE_PROPS,
    })
    expect(await ui.find({ key: 'resume-ws-1' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'surf-workspace',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'surf-workspace',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'resume-ws-1' })
  expect(posts[0]).toContain('/workspaces/ws-1/actions/resume/')

  // SURF gives up: the next fast poll sees the workspace back on paused.
  status = 'paused'
  await clock.advance(10_000)
  expect(toasts.some(t => t.includes('starten mislukt') && t.includes('Timeout waiting for VM to resume.'))).toBe(true)
  await ui.unmount()
})

test('without a setting the token comes from SURF_RC_TOKEN', { options: { notify_macos: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { SURF_RC_TOKEN: 'env-token' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  const auth: (string | undefined)[] = []
  on('http.fetch', ($, e) => {
    auth.push(e.init?.headers?.authorization)
    return { value: { status: 200, ok: true, headers: {}, text: LIST } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(auth[0]).toBe('env-token')
})

test('availability is polled and a flavour coming free raises a toast', { options: { api_token: 'secret-token', notify_macos: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  let free = false
  const urls: string[] = []
  on('http.fetch', ($, e) => {
    urls.push(e.url)
    if (e.url.includes('/offerings/')) {
      // The first try with /v1 is missing on this gateway: the mod retries without.
      if (e.url.includes('/v1/')) return { value: { status: 404, ok: false, headers: {}, text: '' } }
      return { value: { status: 200, ok: true, headers: {}, text: offerings(false, free) } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: LIST } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const offeringsUrl = urls.find(u => u.includes('/offerings/') && !u.includes('/v1/'))
  expect(offeringsUrl).toContain('/application-market/catalog_items/ca0f2d7e-9bcb-4e8c-b902-e4b656dc180e/offerings/?co=9e2da160-b184-4c14-8157-2256df95f9ef&product=daphne-compute')
  expect(statuses).toContain("SURF: markisaacsim gestopt · GPU's niet beschikbaar | other-box draait")

  free = true
  await clock.advance(60_000)
  expect(toasts).toContain("markisaacsim: GPU's weer beschikbaar, je kunt starten.")
  expect(statuses).toContain("SURF: markisaacsim gestopt · GPU's beschikbaar | other-box draait")
})

test('while the GPUs are taken there is no Starten button, only the wait note', { options: { api_token: 'secret-token', notify_macos: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const posts: string[] = []
  on('http.fetch', ($, e) => {
    if (e.init?.method === 'POST') posts.push(e.url)
    if (e.url.includes('/offerings/')) return { value: { status: 200, ok: true, headers: {}, text: offerings(false, false) } }
    return { value: { status: 200, ok: true, headers: {}, text: LIST } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'surf-workspace', surface, component: 'Pane', requestId: 'surf-workspace', props: PANE_PROPS })
    expect(await ui.find({ key: 'resume-ws-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /melding zodra ze vrijkomen/ })).toBeDefined()
    await ui.unmount()
  }
  expect(posts).toEqual([])
})
