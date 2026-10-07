// Service worker: wires the worker to chrome.* and polls with an alarm,
// every minute while idle and every 30 s (the shortest alarm) while the
// workspace is starting or stopping.

import { createWorker } from './worker.js'

const IDLE_MINUTES = 1
const FAST_MINUTES = 0.5

const worker = createWorker({
  fetch: (url, init) => fetch(url, init),
  load: async () => {
    const { settings = {}, state = {} } = await chrome.storage.local.get(['settings', 'state'])
    return { settings, state }
  },
  save: state => chrome.storage.local.set({ state }),
  notify: text =>
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'SURF Research Cloud', message: text }),
  setBadge: async ({ text, color, title }) => {
    await chrome.action.setBadgeText({ text })
    await chrome.action.setBadgeBackgroundColor({ color })
    await chrome.action.setTitle({ title })
  },
  now: () => Date.now(),
})

async function schedule() {
  const periodInMinutes = (await worker.isMoving()) ? FAST_MINUTES : IDLE_MINUTES
  const current = await chrome.alarms.get('poll')
  if (current?.periodInMinutes !== periodInMinutes) await chrome.alarms.create('poll', { periodInMinutes })
}

async function refreshAndSchedule() {
  await worker.refresh()
  await schedule()
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage()
  refreshAndSchedule()
})
chrome.runtime.onStartup.addListener(refreshAndSchedule)
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'poll') refreshAndSchedule()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshAndSchedule()
})
chrome.notifications.onClicked.addListener(() => chrome.action.openPopup?.().catch(() => {}))

// Messages from the popup: {type: 'refresh'} or {type: 'act', id, action}.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const run =
    message?.type === 'act'
      ? worker.act(message.id, message.action).then(async refused => {
          await schedule()
          return { refused }
        })
      : refreshAndSchedule().then(() => ({}))
  run.then(reply, err => reply({ refused: err instanceof Error ? err.message : String(err) }))
  return true
})
