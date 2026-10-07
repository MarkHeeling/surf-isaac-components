# surf-workspace: SURF Research Cloud status in Claude Code

A Claude Code mod (a plugin of function hooks) that answers one question, whether your SURF
Research Cloud workspace can start right now, and lets you start and stop it.

- **Status line** under the prompt: `SURF: markisaacsim gestopt · GPU's niet beschikbaar`
  (or `GPU's beschikbaar`, or `markisaacsim draait`).
- **`/surf status`** prints that line once, without opening the pane or touching the workspace.
- **`/surf`** opens a pane with the same status and **Starten** / **Stoppen** (stop asks once
  more). While the GPUs are taken there is no Starten button: a start would only end in the
  portal's ~10-minute timeout. `r` refreshes.
- **Toasts** (and a macOS notification) when your GPUs come free again, when a start or stop
  has worked, and when a start fails (with SURF's error text, e.g. `Timeout waiting for VM to
  resume.`).
- Checks every `poll_seconds` (60 s), every 10 s while the workspace is starting or stopping.

## Where the availability comes from

The SURF Research Cloud API ([first steps](https://servicedesk.surf.nl/wiki/spaces/WIKI/pages/174981256/Research+Cloud+API+-+First+Steps),
[Swagger](https://gw.live.surfresearchcloud.nl/v1/workspace/swagger/docs/)) gives workspace
status and the `pause`/`resume` actions. GPU availability is not documented, but the portal's
create dialog reads it from the catalog item's offerings:

```
GET https://gw.live.surfresearchcloud.nl/v1/application-market/catalog_items/<catalog_item>/offerings/?co=<co_id>&product=daphne-compute&product=hpcc-hdd&product=hpcc-ssd&product=daphne-gpu
```

Each size flavour there carries `"available": true | false` (`null` for the OS image). The mod
reads that (retrying without `/v1` if the gateway answers 404) on every poll. It is the
create dialog's check; that a resume of a paused workspace needs the same free capacity is an
assumption, so the failed-resume toast stays as a backstop.

A failed start shows up in the workspace's `workspace_actions` (the newest one has
`status: "failed"`) with SURF's text in `result.error`; the workspace itself falls back to
`paused`. To see the raw answer once:

```bash
curl -s 'https://gw.live.surfresearchcloud.nl/v1/workspace/workspaces/?application_type=Compute&deleted=false&by_owner=true' \
  -H 'accept: application/json' -H "authorization: $SURF_RC_TOKEN" | python3 -m json.tool
```

## API token

Create it in the portal: <https://portal.live.surfresearchcloud.nl/profile> → **API tokens**
→ *Add API token* (it is shown once). The mod reads it from, in order:

1. the plugin's `api_token` setting (asked when you install the plugin; kept in secure storage),
2. the environment variable `SURF_RC_TOKEN`,
3. the macOS keychain item `surf-research-cloud`:
   ```bash
   security add-generic-password -a "$USER" -s surf-research-cloud -w   # prompts for the token
   ```

Never commit the token.

## Install / run

From a local clone (development, reloads on save):

```bash
claude --plugin-dir ~/path/to/surf-isaac-components/claude-mod/surf-workspace
```

Or install it from this repository (the repo root holds `.claude-plugin/marketplace.json`),
at the prompt of a terminal session:

```
/plugin install surf-workspace --marketplace MarkHeeling/surf-isaac-components
```

Answer `y` to add the marketplace and pick the user scope; it then loads in every session,
including the desktop app's Code tab.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `api_token` | – | see above |
| `workspace` | `""` | only show workspaces whose host name (`markisaacsim`) or portal name contains this text |
| `poll_seconds` | `60` | poll interval while nothing is changing (min 15) |
| `notify_macos` | `true` | also raise a macOS notification |
| `catalog_item` | Isaac catalog item | catalog item whose offerings carry the availability; empty turns the check off |
| `co_id` | Mark's collaboration | the `co=` value of the offerings request |
| `products` | `daphne-compute,hpcc-hdd,hpcc-ssd,daphne-gpu` | the `product=` values of the offerings request |

## Develop

```bash
claude plugin validate claude-mod/surf-workspace
claude plugin test claude-mod/surf-workspace
```

`hooks/surf.ts` holds the API URLs, parsing and transition rules; `hooks/register.tsx` the
hooks (session start, `/surf`, the pane); `tests/surf.test.ts` covers parsing, the
transitions, the token lookup, the failed-start toast and the availability check
(fixtures shaped like the live answers of 2026-10-07).
