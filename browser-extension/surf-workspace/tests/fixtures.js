// Shaped like the live answers (2026-10-07): `actions` only lists allowed
// action names, the history is in `workspace_actions` with the error text in
// `result.error`; offerings carry one `available` flag per flavour.

export const workspace = (status, actions = []) => ({
  id: 'ws-1',
  name: 'markisaacsim',
  status,
  active: status === 'running',
  actions: ['resume', 'update_nsgs', 'update_storages'],
  workspace_actions: actions,
  resource_meta: { ip: '145.38.0.1' },
  meta: { flavours: [{ name: 'Ubuntu 22.04', category: 'os' }, { name: 'A10 - 2 GPU', category: 'size' }] },
})

export const FAILED_RESUME = {
  type: 'resume',
  status: 'failed',
  reason: 'API',
  result: { error: 'Timeout waiting for VM to resume.' },
  time_created: '2026-10-07T13:03:00Z',
}

export const list = (...results) => JSON.stringify({ count: results.length, results })

export const offerings = (one, two) =>
  JSON.stringify({
    count: 1,
    results: [
      {
        id: 'offering-1',
        subscription: { name: 'SURF HPC Cloud', cloud_status: 'up' },
        flavours: [
          { name: 'A10 - 1 GPU', category: 'size', status: 'active', available: one },
          { name: 'A10 - 2 GPU', category: 'size', status: 'active', available: two },
          { name: 'Ubuntu 22.04', category: 'os', status: 'active', available: null },
        ],
      },
    ],
  })
