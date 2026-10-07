import { availabilityText, isAvailable, isTransitioning, minutesSince, statusText } from './surf.js'

const content = document.getElementById('content')
const updated = document.getElementById('updated')
let confirming = null
let notice = null
let last = null

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'onclick') node.addEventListener('click', value)
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value)
  }
  node.append(...children.filter(c => c !== undefined && c !== null && c !== false))
  return node
}

function statusClass(status) {
  if (status === 'running') return 'running'
  if (status === 'paused') return 'paused'
  if (isTransitioning(status)) return 'moving'
  return 'failed'
}

async function act(id, action) {
  confirming = null
  notice = null
  const answer = await chrome.runtime.sendMessage({ type: 'act', id, action })
  notice = answer?.refused ?? null
  render(last)
}

function workspaceView(ws, state, now) {
  const available = isAvailable(ws, state.flavours)
  const gpu = availabilityText(ws, state.flavours)
  const busy = state.busy === ws.id
  const since = state.resumingSince?.[ws.id]
  const buttons = []
  if (busy) buttons.push(el('span', { class: 'detail' }, 'bezig…'))
  else if (ws.status === 'paused' && available === false) {
    buttons.push(el('span', { class: 'detail' }, 'Je krijgt een melding zodra ze vrijkomen.'))
  } else if (ws.status === 'paused') {
    buttons.push(el('button', { class: 'primary', onclick: () => act(ws.id, 'resume') }, 'Starten'))
  } else if (ws.status === 'running' && confirming !== ws.id) {
    buttons.push(el('button', { onclick: () => ((confirming = ws.id), render(last)) }, 'Stoppen'))
  } else if (ws.status === 'running') {
    buttons.push(
      el('span', {}, 'Stoppen?'),
      el('button', { class: 'danger', onclick: () => act(ws.id, 'pause') }, 'Ja, stop'),
      el('button', { onclick: () => ((confirming = null), render(last)) }, 'Nee'),
    )
  }
  return el(
    'section',
    { class: 'ws' },
    el(
      'div',
      { class: 'row' },
      el('span', { class: 'name' }, ws.name),
      el('span', { class: `status ${statusClass(ws.status)}` }, statusText(ws.status)),
      ws.status === 'resuming' && since !== undefined && el('span', { class: 'detail' }, `(${minutesSince(since, now)} min)`),
    ),
    gpu && el('div', { class: `gpu ${available ? 'yes' : 'no'}` }, gpu),
    (ws.flavour || ws.ip) && el('div', { class: 'detail' }, [ws.flavour, ws.ip].filter(Boolean).join(' · ')),
    ws.lastAction?.message &&
      el('div', { class: 'detail' }, `Laatste actie ${ws.lastAction.type ?? ''} ${ws.lastAction.status ?? ''}: ${ws.lastAction.message}`),
    buttons.length > 0 && el('div', { class: 'actions' }, ...buttons),
  )
}

function render(state) {
  last = state
  const now = Date.now()
  content.replaceChildren()
  if (!state) {
    content.append(el('p', { class: 'detail' }, 'Ophalen…'))
    return
  }
  if (notice) content.append(el('p', { class: 'error' }, notice))
  if (state.error) content.append(el('p', { class: 'error' }, `Fout: ${state.error}`))
  if (!state.error && state.workspaces.length === 0) content.append(el('p', { class: 'detail' }, 'Geen workspace gevonden.'))
  for (const ws of state.workspaces) content.append(workspaceView(ws, state, now))
  updated.textContent = state.updatedAt ? `bijgewerkt ${Math.max(0, Math.round((now - state.updatedAt) / 1000))} s geleden` : 'nog niet opgehaald'
}

document.getElementById('refresh').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'refresh' }))
document.getElementById('settings').addEventListener('click', e => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) render(changes.state.newValue)
})

const { state } = await chrome.storage.local.get('state')
render(state ?? null)
chrome.runtime.sendMessage({ type: 'refresh' })
