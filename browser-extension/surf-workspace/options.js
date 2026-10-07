import { DEFAULT_SETTINGS } from './surf.js'

const form = document.getElementById('form')
const saved = document.getElementById('saved')
const { settings = {} } = await chrome.storage.local.get('settings')
const current = { ...DEFAULT_SETTINGS, ...settings }

for (const [key, value] of Object.entries(current)) {
  const input = form.elements.namedItem(key)
  if (!input) continue
  if (input.type === 'checkbox') input.checked = Boolean(value)
  else input.value = String(value)
}

form.addEventListener('submit', async e => {
  e.preventDefault()
  const next = {}
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const input = form.elements.namedItem(key)
    if (input.type === 'checkbox') next[key] = input.checked
    else if (input.type === 'number') next[key] = Number(input.value || 0)
    else next[key] = input.value.trim()
  }
  await chrome.storage.local.set({ settings: next })
  saved.hidden = false
  setTimeout(() => (saved.hidden = true), 2000)
})
