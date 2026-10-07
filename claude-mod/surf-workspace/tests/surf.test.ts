import { describe, expect, mock, test } from 'claude-code/testing'

import { describeAvailabilityChange, describeChange, isSlowResume, parseAvailability, parseList, statusLine } from '../hooks/surf'

const LIST = JSON.stringify({
  count: 2,
  results: [
    {
      id: 'ws-1',
      name: 'markisaacsim',
      status: 'paused',
      active: false,
      resource_meta: { ip: '145.38.0.1' },
      meta: { flavours: [{ name: 'Ubuntu 22.04', category: 'os' }, { name: 'A10 - 2 GPU', category: 'size' }] },
    },
    { id: 'ws-2', name: 'other-box', status: 'running', active: true, resource_meta: {} },
  ],
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
  test('keeps the filtered workspaces with status, ip and size flavour', () => {
    const list = parseList(LIST, 'isaac')
    expect(list).toEqual([
      {
        id: 'ws-1',
        name: 'markisaacsim',
        status: 'paused',
        ip: '145.38.0.1',
        flavour: 'A10 - 2 GPU',
        message: undefined,
        lastAction: undefined,
      },
    ])
    expect(parseList(LIST, '').length).toBe(2)
  })

  test('picks the newest action and its error text', () => {
    const list = parseList(
      JSON.stringify({
        results: [
          {
            id: 'ws-1',
            name: 'markisaacsim',
            status: 'paused',
            actions: [
              { type: 'pause', status: 'done', time_created: '2026-10-06T10:00:00Z' },
              { type: 'resume', status: 'failed', time_created: '2026-10-07T10:00:00Z', error: { message: 'No valid host was found' } },
            ],
          },
        ],
      }),
      '',
    )
    expect(list[0]?.lastAction).toEqual({ type: 'resume', status: 'failed', message: 'No valid host was found' })
  })
})

describe('availability', () => {
  test('reads the size flavours and their available flag', () => {
    expect(parseAvailability(offerings(false, true))).toEqual([
      { name: 'A10 - 1 GPU', available: false },
      { name: 'A10 - 2 GPU', available: true },
    ])
  })

  test('says when a flavour comes free or runs out', () => {
    const before = parseAvailability(offerings(false, false))
    expect(describeAvailabilityChange(before, parseAvailability(offerings(false, true)))).toEqual(['A10 - 2 GPU is weer beschikbaar.'])
    expect(describeAvailabilityChange(parseAvailability(offerings(true, true)), before)).toHaveLength(2)
    expect(describeAvailabilityChange([], before)).toEqual([])
  })

  test('the status line shows the flavour the workspace uses', () => {
    const ws = [{ id: 'ws-1', name: 'markisaacsim', status: 'paused', flavour: 'A10 - 2 GPU' }]
    expect(statusLine(ws, null, parseAvailability(offerings(true, false)))).toBe('SURF: markisaacsim paused · A10 - 2 GPU bezet')
  })
})

describe('transitions', () => {
  const ws = { id: 'ws-1', name: 'markisaacsim' }

  test('a resume that falls back to paused is a failed resume', () => {
    const change = describeChange({ ...ws, status: 'resuming' }, { ...ws, status: 'paused' })
    expect(change.isResumeFailed).toBe(true)
    expect(change.say).toContain('GPU')
  })

  test('a resume that reaches running says so', () => {
    expect(describeChange({ ...ws, status: 'resuming' }, { ...ws, status: 'running' }).say).toBe('markisaacsim draait weer.')
  })

  test('no change, nothing to say', () => {
    expect(describeChange({ ...ws, status: 'running' }, { ...ws, status: 'running' })).toEqual({})
    expect(describeChange(undefined, { ...ws, status: 'running' })).toEqual({})
  })

  test('slow resume after the threshold', () => {
    expect(isSlowResume(0, 3 * 60_000, 4)).toBe(false)
    expect(isSlowResume(0, 4 * 60_000, 4)).toBe(true)
    expect(isSlowResume(undefined, 10 * 60_000, 4)).toBe(false)
  })

  test('status line', () => {
    expect(statusLine([{ ...ws, status: 'paused' }], null)).toBe('SURF: markisaacsim paused')
    expect(statusLine([], 'token geweigerd')).toBe('SURF: token geweigerd')
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
  expect(statuses).toContain('SURF: markisaacsim paused · other-box running')
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
    const body = { results: [{ id: 'ws-1', name: 'markisaacsim', status, actions: status === 'paused' && posts.length ? [{ type: 'resume', status: 'failed', error: 'No valid host was found' }] : [] }] }
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
  expect(toasts.some(t => t.includes("geen GPU's vrij") && t.includes('No valid host was found'))).toBe(true)
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
  expect(statuses).toContain('SURF: markisaacsim paused · other-box running · A10 - 2 GPU bezet')

  free = true
  await clock.advance(60_000)
  expect(toasts).toContain('A10 - 2 GPU is weer beschikbaar.')
  expect(statuses).toContain('SURF: markisaacsim paused · other-box running · A10 - 2 GPU vrij')
})

test('while the flavour is taken there is no Starten button, only the wait note', { options: { api_token: 'secret-token', notify_macos: false } }, async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: /Geen A10 - 2 GPU vrij/ })).toBeDefined()
    await ui.unmount()
  }
  expect(posts).toEqual([])
})
