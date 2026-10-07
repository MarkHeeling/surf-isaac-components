// Service worker: wires the worker to chrome.* and keeps the 'poll' alarm
// only while a check in the background is needed (a start or stop running,
// or "Melding als vrij" on). Otherwise SURF is only asked when the side panel
// is opened or shown again.

import { createWorker } from './worker.js'

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
  const periodInMinutes = await worker.pollMinutes()
  const current = await chrome.alarms.get('poll')
  if (periodInMinutes === null) {
    if (current) await chrome.alarms.clear('poll')
  } else if (current?.periodInMinutes !== periodInMinutes) {
    await chrome.alarms.create('poll', { periodInMinutes })
  }
}

async function refreshAndSchedule(options) {
  await worker.refresh(options)
  await schedule()
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage()
  schedule()
})
chrome.runtime.onStartup.addListener(() => schedule())
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'poll') refreshAndSchedule()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshAndSchedule({ force: true, reset: true })
})
// The toolbar icon opens the side panel (panel.html) instead of a popup.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
chrome.notifications.onClicked.addListener(async () => {
  const win = await chrome.windows.getLastFocused().catch(() => undefined)
  if (win?.id !== undefined) chrome.sidePanel.open({ windowId: win.id }).catch(() => {})
})

// Messages from the side panel: {type: 'refresh'}, {type: 'act', id, action} or {type: 'watch', id, on}.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  let run
  if (message?.type === 'act') {
    run = worker.act(message.id, message.action).then(async refused => {
      await schedule()
      return { refused }
    })
  } else if (message?.type === 'watch') {
    run = worker.watch(message.id, message.on).then(async () => {
      await schedule()
      return {}
    })
  } else {
    run = refreshAndSchedule().then(() => ({}))
  }
  run.then(reply, err => reply({ refused: err instanceof Error ? err.message : String(err) }))
  return true
})
