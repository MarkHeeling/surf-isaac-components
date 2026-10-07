import { isAvailable, isTransitioning, statusText } from './surf.js'

const content = document.getElementById('content')
let confirming = null
/** Per workspace id the text of a refused start or stop. */
const notices = {}
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

const clock = ms => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
const clockOf = iso => (iso && Number.isFinite(Date.parse(iso)) ? clock(Date.parse(iso)) : undefined)
const capital = text => text.charAt(0).toUpperCase() + text.slice(1)
const line = (...parts) => parts.filter(Boolean).join(' - ')

/** Headline, the line under it and the colour of the bar beside it. */
function status(ws, state) {
  const updated = state.updatedAt ? `bijgewerkt ${clock(state.updatedAt)}` : undefined
  const asked = state.pending?.[ws.id]?.at
  if (ws.status === 'running') {
    const since = ws.lastAction?.type === 'resume' ? clockOf(ws.lastAction.at) : undefined
    return { kop: 'Draait', regel: line(since && `sinds ${since}`, updated), kleur: 'groen' }
  }
  if (ws.status === 'resuming') {
    const since = state.resumingSince?.[ws.id] ?? asked
    return { kop: 'Start op', regel: line(since && `sinds ${clock(since)}`, updated), kleur: 'oranje' }
  }
  if (ws.status === 'pausing') return { kop: 'Stopt', regel: line(asked && `sinds ${clock(asked)}`, updated), kleur: 'oranje' }
  if (isTransitioning(ws.status)) return { kop: capital(statusText(ws.status)), regel: updated, kleur: 'oranje' }
  if (ws.status === 'paused') {
    const available = isAvailable(ws, state.flavours)
    if (available === true) return { kop: 'Gestopt', regel: line("GPU's beschikbaar", updated), kleur: 'blauw' }
    if (available === false) return { kop: 'Gestopt', regel: line("GPU's niet beschikbaar", updated), kleur: 'rood' }
    return { kop: 'Gestopt', regel: updated, kleur: 'grijs' }
  }
  return { kop: capital(statusText(ws.status)), regel: updated, kleur: 'rood' }
}

const VERBS = { resume: ['gestart', 'starten'], pause: ['gestopt', 'stoppen'] }

function lastAction(ws) {
  const action = ws.lastAction
  if (!action) return '-'
  const [done, doing] = VERBS[action.type] ?? [action.type ?? 'actie', action.type ?? 'actie']
  const at = clockOf(action.at)
  if (action.status === 'failed') return [doing, 'mislukt', at].filter(Boolean).join(' ')
  if (isTransitioning(ws.status)) return [doing, at && `sinds ${at}`].filter(Boolean).join(' ')
  return [done, at].filter(Boolean).join(' ')
}

function send(message) {
  return chrome.runtime.sendMessage(message)
}

async function act(id, action) {
  confirming = null
  delete notices[id]
  const answer = await send({ type: 'act', id, action })
  if (answer?.refused) notices[id] = answer.refused
  render(last)
}

const button = (label, kind, onclick, extra = {}) => el('button', { type: 'button', class: kind, onclick, ...extra }, label)

function statusBlock({ kop, regel, kleur }, ...extra) {
  return el('div', { class: `status ${kleur}` }, el('strong', {}, kop), regel && el('span', {}, regel), ...extra)
}

function buttons(ws, state, waiting) {
  const row = []
  const watched = state.watch?.includes(ws.id)
  if (state.busy === ws.id) row.push(button('Bezig', 'secondary', undefined, { disabled: true }))
  else if (confirming === ws.id && ws.status === 'running') {
    row.push(
      button('Ja, stoppen', 'primary', () => act(ws.id, 'pause')),
      button('Annuleren', 'plain', () => ((confirming = null), render(last))),
    )
    return row
  } else if (ws.status === 'paused' && isAvailable(ws, state.flavours) === false) {
    row.push(
      watched
        ? button('Melding uitzetten', 'secondary', () => send({ type: 'watch', id: ws.id, on: false }))
        : button('Melding als vrij', 'primary', () => send({ type: 'watch', id: ws.id, on: true })),
    )
  } else if (ws.status === 'paused') row.push(button('Starten', 'primary', () => act(ws.id, 'resume')))
  else if (ws.status === 'running') row.push(button('Stoppen', 'secondary', () => ((confirming = ws.id), render(last))))
  if (!waiting) row.push(button('Vernieuwen', 'plain', () => send({ type: 'refresh' })))
  return row
}

function workspaceView(ws, state, waiting) {
  const failed = ws.lastAction?.status === 'failed' ? ws.lastAction.message : undefined
  const note = notices[ws.id]
  return el(
    'section',
    { class: 'ws' },
    el('h1', {}, ws.name),
    statusBlock(status(ws, state), state.watch?.includes(ws.id) && el('span', { class: 'watching' }, 'Melding staat aan.')),
    el(
      'dl',
      {},
      el('div', {}, el('dt', {}, 'GPU-type'), el('dd', {}, ws.flavour ?? '-')),
      el('div', {}, el('dt', {}, 'IP-adres'), el('dd', { class: 'mono' }, ws.ip ?? '-')),
      el('div', {}, el('dt', {}, 'Laatste actie'), el('dd', {}, lastAction(ws))),
    ),
    (note || failed) && el('pre', { class: 'error' }, note ?? failed),
    el('div', { class: 'actions' }, ...buttons(ws, state, waiting)),
  )
}

function render(state) {
  last = state
  content.replaceChildren()
  if (!state) {
    content.append(el('section', { class: 'ws' }, statusBlock({ kop: 'Ophalen', kleur: 'grijs' })))
    return
  }
  const now = Date.now()
  const waiting = state.retryAt !== null && state.retryAt !== undefined && now < state.retryAt
  if (state.error) {
    const kop = capital(state.error.replace(/, even wachten$/, '').replace(/ \(zie Instellingen\)$/, ''))
    const tokenProblem = /token/i.test(state.error)
    content.append(
      el(
        'section',
        { class: 'ws' },
        statusBlock({ kop, regel: waiting ? `volgende check ${clock(state.retryAt)}` : undefined, kleur: 'rood' }),
        tokenProblem && el('div', { class: 'actions' }, button('Instellingen', 'primary', () => chrome.runtime.openOptionsPage())),
      ),
    )
  }
  if (!state.error && state.workspaces.length === 0) {
    content.append(el('section', { class: 'ws' }, statusBlock({ kop: 'Geen workspace gevonden', regel: 'Controleer de naamfilter.', kleur: 'grijs' })))
  }
  for (const ws of state.workspaces) content.append(workspaceView(ws, state, waiting))
}

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage())
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) render(changes.state.newValue)
})

// Show the last known state at once, then ask SURF; again whenever the side
// panel is shown or its window gets focus (the worker allows one check per 20 s).
const { state } = await chrome.storage.local.get('state')
render(state ?? null)
send({ type: 'refresh' })
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && send({ type: 'refresh' }))
window.addEventListener('focus', () => send({ type: 'refresh' }))
