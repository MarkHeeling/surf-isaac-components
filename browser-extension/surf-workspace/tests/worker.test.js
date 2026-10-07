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
  assert.deepEqual(world.badge, { text: 'vol', color: '#c62828', title: "SURF: markisaacsim gestopt · GPU's niet beschikbaar" })
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
  assert.ok(world.notes.some(n => n.includes('nog aan het starten')))

  world.status = 'paused'
  world.actions = [FAILED_RESUME]
  world.clock += 5 * 60_000
  await worker.refresh()
  assert.ok(world.notes.some(n => n.includes('starten mislukt') && n.includes('Timeout waiting for VM to resume.')))
})

test('a notification when the GPUs come free', async () => {
  const { world, worker } = setup()
  await worker.refresh()
  world.free = true
  await worker.refresh()
  assert.deepEqual(world.notes, ["markisaacsim: GPU's weer beschikbaar, je kunt starten."])
  assert.equal(world.badge.text, 'vrij')
})

test('stopping a running workspace posts pause and says when it is stopped', async () => {
  const { world, worker } = setup({ status: 'running' })
  await worker.refresh()
  await worker.act('ws-1', 'pause')
  assert.match(world.posts[0], /\/actions\/pause\/$/)
  world.status = 'paused'
  world.clock += 90_000
  await worker.refresh()
  assert.deepEqual(world.notes, ['markisaacsim is gestopt.'])
})
