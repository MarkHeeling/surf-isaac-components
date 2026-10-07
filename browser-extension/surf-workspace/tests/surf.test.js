import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { badge, describeAvailabilityChange, describeChange, isSlowResume, parseAvailability, parseList, summary } from '../surf.js'
import { FAILED_RESUME, list, offerings, workspace } from './fixtures.js'

const OTHER = { id: 'ws-2', name: 'other-box', status: 'running', active: true, resource_meta: {} }

describe('parsing', () => {
  test('keeps the filtered workspaces with status, ip and size flavour', () => {
    assert.deepEqual(parseList(list(workspace('paused'), OTHER), 'isaac'), [
      { id: 'ws-1', name: 'markisaacsim', status: 'paused', ip: '145.38.0.1', flavour: 'A10 - 2 GPU', lastAction: undefined },
    ])
    assert.equal(parseList(list(workspace('paused'), OTHER), '').length, 2)
  })

  test("a failed newest action gives SURF's error text, not the reason field", () => {
    const done = { type: 'pause', status: 'done', reason: 'API', result: {}, time_created: '2026-10-01T10:00:00Z' }
    assert.deepEqual(parseList(list(workspace('paused', [FAILED_RESUME, done])), '')[0].lastAction, {
      type: 'resume',
      status: 'failed',
      message: 'Timeout waiting for VM to resume.',
    })
    const old = { ...FAILED_RESUME, time_created: '2026-10-01T00:00:00Z' }
    assert.deepEqual(parseList(list(workspace('paused', [old, done])), '')[0].lastAction, { type: 'pause', status: 'done', message: undefined })
  })

  test('reads the size flavours and their available flag', () => {
    assert.deepEqual(parseAvailability(offerings(false, true)), [
      { name: 'A10 - 1 GPU', available: false },
      { name: 'A10 - 2 GPU', available: true },
    ])
  })
})

describe('status', () => {
  const ws = [{ id: 'ws-1', name: 'markisaacsim', status: 'paused', flavour: 'A10 - 2 GPU' }]

  test('the summary says whether the GPUs are available', () => {
    assert.equal(summary(ws, parseAvailability(offerings(true, false)), null), "SURF: markisaacsim gestopt · GPU's niet beschikbaar")
    assert.equal(summary(ws, parseAvailability(offerings(false, true)), null), "SURF: markisaacsim gestopt · GPU's beschikbaar")
    assert.equal(summary([{ ...ws[0], status: 'running' }], parseAvailability(offerings(false, false)), null), 'SURF: markisaacsim draait')
    assert.equal(summary([], [], 'token geweigerd'), 'SURF: token geweigerd')
  })

  test('the badge shows on, starting, free or full', () => {
    assert.equal(badge([{ ...ws[0], status: 'running' }], [], null).text, 'aan')
    assert.equal(badge([{ ...ws[0], status: 'resuming' }], [], null).text, '…')
    assert.equal(badge(ws, parseAvailability(offerings(false, true)), null).text, 'vrij')
    assert.equal(badge(ws, parseAvailability(offerings(true, false)), null).text, 'vol')
    assert.equal(badge(ws, [], 'HTTP 500').text, '!')
  })
})

describe('transitions', () => {
  const ws = { id: 'ws-1', name: 'markisaacsim', flavour: 'A10 - 2 GPU' }

  test("a resume that falls back to paused is a failed start, with SURF's reason", () => {
    const after = { ...ws, status: 'paused', lastAction: { type: 'resume', status: 'failed', message: 'Timeout waiting for VM to resume.' } }
    assert.equal(
      describeChange({ ...ws, status: 'resuming' }, after),
      "markisaacsim: starten mislukt (Timeout waiting for VM to resume.). Waarschijnlijk geen GPU's vrij.",
    )
  })

  test('start and stop that work say so; no change says nothing', () => {
    assert.equal(describeChange({ ...ws, status: 'resuming' }, { ...ws, status: 'running' }), 'markisaacsim draait weer.')
    assert.equal(describeChange({ ...ws, status: 'pausing' }, { ...ws, status: 'paused' }), 'markisaacsim is gestopt.')
    assert.equal(describeChange({ ...ws, status: 'running' }, { ...ws, status: 'running' }), undefined)
    assert.equal(describeChange(undefined, { ...ws, status: 'running' }), undefined)
  })

  test("a notification only when the workspace's own GPUs come free", () => {
    const paused = [{ ...ws, status: 'paused' }]
    const taken = parseAvailability(offerings(false, false))
    assert.deepEqual(describeAvailabilityChange(taken, parseAvailability(offerings(false, true)), paused), [
      "markisaacsim: GPU's weer beschikbaar, je kunt starten.",
    ])
    assert.deepEqual(describeAvailabilityChange(taken, parseAvailability(offerings(true, false)), paused), [])
    assert.deepEqual(describeAvailabilityChange([], parseAvailability(offerings(true, true)), paused), [])
  })

  test('slow resume after the threshold', () => {
    assert.equal(isSlowResume(0, 3 * 60_000, 4), false)
    assert.equal(isSlowResume(0, 4 * 60_000, 4), true)
    assert.equal(isSlowResume(undefined, 10 * 60_000, 4), false)
    assert.equal(isSlowResume(0, 10 * 60_000, 0), false)
  })
})
