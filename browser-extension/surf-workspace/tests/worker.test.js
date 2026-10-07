import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWorker } from '../worker.js'
import { FAILED_RESUME, list, offerings, workspace } from './fixtures.js'

/** A fake SURF gateway plus the extension's storage, notifications and badge. */
function setup({ status = 'paused', free = false, token = 'secret-token' } = {}) {
  const world = { status, free, actions: [], posts: [], seen: [], notes: [], badge: null, clock: 1_000_000 }
  let stored = { settings: { token }, state: {} }
  const respond = (code, body) => ({ ok: code < 400, status: code, text: async () => body })
  const worker = createWorker({
    fetch: async (url, init = {}) => {
      world.seen.push({ url, auth: init.headers?.authorization, method: init.method ?? 'GET' })
      if (init.method === 'POST') {
        world.posts.push(url)
        return respond(202, '{}')
      }
      if (url.includes('/offerings/')) return respond(200, offerings(false, world.free))
      return respond(200, list(workspace(world.status, world.actions)))
    },
    load: async () => structuredClone(stored),
    save: async state => {
      stored = { ...stored, state: structuredClone(state) }
    },
    notify: async text => {
      world.notes.push(text)
    },
    setBadge: async b => {
      world.badge = b
    },
    now: () => world.clock,
  })
  return { world, worker, state: () => stored.state }
}

test('a refresh fetches with the token and sets the badge and tooltip', async () => {
  const { world, worker } = setup()
  await worker.refresh()
  assert.match(world.seen[0].url, /\/v1\/workspace\/workspaces\/\?application_type=Compute&deleted=false&by_owner=true/)
  assert.equal(world.seen[0].auth, 'secret-token')
  assert.ok(world.seen.some(s => s.url.includes('/catalog_items/ca0f2d7e-9bcb-4e8c-b902-e4b656dc180e/offerings/?co=9e2da160')))
  assert.deepEqual(world.badge, { text: 'vol', color: '#990f3d', title: "SURF: markisaacsim gestopt - GPU's niet beschikbaar" })
})

test('without a token it says so and fetches nothing', async () => {
  const { world, worker } = setup({ token: '' })
  const state = await worker.refresh()
  assert.equal(state.error, 'geen API-token (zie Instellingen)')
  assert.equal(world.seen.length, 0)
})

test('starting is refused while the GPUs are taken', async () => {
  const { world, worker } = setup()
  await worker.refresh()
  assert.equal(await worker.act('ws-1', 'resume'), "markisaacsim niet gestart: GPU's niet beschikbaar.")
  assert.deepEqual(world.posts, [])
})

test('a start that SURF gives up on raises the failed-start notification with its reason', async () => {
  const { world, worker, state } = setup({ free: true })
  await worker.refresh()
  assert.equal(world.badge.text, 'vrij')

  assert.equal(await worker.act('ws-1', 'resume'), undefined)
  assert.match(world.posts[0], /\/workspaces\/ws-1\/actions\/resume\/$/)
  // SURF has not picked it up yet: still paused right after the request, shown as starting.
  assert.equal(state().workspaces[0].status, 'resuming')
  assert.deepEqual(world.notes, [])

  world.status = 'resuming'
  world.clock += 30_000
  await worker.refresh()
  world.clock += 5 * 60_000
  await worker.refresh()
  assert.ok(world.notes.some(n => n.includes('nog steeds op')))

  world.status = 'paused'
  world.actions = [FAILED_RESUME]
  world.clock += 5 * 60_000
  await worker.refresh()
  assert.ok(world.notes.some(n => n.includes('starten mislukt') && n.includes('Timeout waiting for VM to resume.')))
})

test('GPUs coming free: no notification unless "Melding als vrij" is on, then one and it switches off', async () => {
  const { world, worker, state } = setup()
  await worker.refresh()
  world.free = true
  world.clock += 60_000
  await worker.refresh()
  assert.deepEqual(world.notes, [])
  assert.equal(world.badge.text, 'vrij')

  world.free = false
  world.clock += 60_000
  await worker.refresh()
  await worker.watch('ws-1', true)
  assert.equal(await worker.pollMinutes(), 1)
  world.clock += 60_000
  await worker.refresh()
  assert.deepEqual(world.notes, [])
  world.free = true
  world.clock += 60_000
  await worker.refresh()
  assert.deepEqual(world.notes, ["markisaacsim: GPU's beschikbaar, je kunt starten."])
  assert.deepEqual(state().watch, [])
  assert.equal(await worker.pollMinutes(), null)
})

test('stopping a running workspace posts pause and gives no notification when it is stopped', async () => {
  const { world, worker } = setup({ status: 'running' })
  await worker.refresh()
  await worker.act('ws-1', 'pause')
  assert.match(world.posts[0], /\/actions\/pause\/$/)
  world.status = 'paused'
  world.clock += 90_000
  await worker.refresh()
  assert.deepEqual(world.notes, [])
})

test('background checks only while starting or stopping, or while waiting for free GPUs', async () => {
  const { world, worker } = setup({ free: true })
  await worker.refresh()
  assert.equal(await worker.pollMinutes(), null)
  await worker.act('ws-1', 'resume')
  assert.equal(await worker.pollMinutes(), 0.5)
  world.status = 'running'
  world.clock += 90_000
  await worker.refresh()
  assert.equal(await worker.pollMinutes(), null)
})

test('checks are rate-limited: opening the popup and Vernieuwen within 20 s do not reach SURF', async () => {
  const { world, worker } = setup()
  await worker.refresh()
  const after = world.seen.length
  world.clock += 5_000
  await worker.refresh()
  world.clock += 5_000
  await worker.refresh()
  assert.equal(world.seen.length, after)
  world.clock += 15_000
  await worker.refresh()
  assert.ok(world.seen.length > after)
})

test('no availability check while the workspace runs', async () => {
  const { world, worker } = setup({ status: 'running' })
  await worker.refresh()
  assert.equal(world.seen.filter(s => s.url.includes('/offerings/')).length, 0)
})

test('errors back off, Retry-After is honoured, new settings retry at once', async () => {
  const calls = []
  let now = 0
  let reply = { ok: false, status: 500, headers: { get: () => null }, text: async () => '' }
  const stored = { settings: { token: 't' }, state: {} }
  const wk = createWorker({
    fetch: async url => (calls.push(url), reply),
    load: async () => structuredClone(stored),
    save: async s => {
      stored.state = structuredClone(s)
    },
    notify: async () => {},
    setBadge: async () => {},
    now: () => now,
  })
  await wk.refresh()
  assert.equal(calls.length, 1)
  now += 30_000
  await wk.refresh()
  assert.equal(calls.length, 1, 'within the first back-off (60 s)')
  now += 31_000
  await wk.refresh()
  assert.equal(calls.length, 2)
  now += 61_000
  await wk.refresh()
  assert.equal(calls.length, 2, 'second back-off is 120 s')

  reply = { ok: false, status: 429, headers: { get: k => (k === 'retry-after' ? '600' : null) }, text: async () => '' }
  now += 60_000
  await wk.refresh()
  assert.equal(calls.length, 3)
  now += 300_000
  await wk.refresh()
  assert.equal(calls.length, 3, 'Retry-After 600 s')

  reply = { ok: true, status: 200, headers: { get: () => null }, text: async () => list(workspace('running')) }
  await wk.refresh({ force: true, reset: true })
  assert.equal(calls.length, 4)
  assert.equal(stored.state.failures, 0)
})
