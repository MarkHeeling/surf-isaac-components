# surf-workspace: SURF Research Cloud status in Claude Code

A Claude Code mod (a plugin of function hooks) that shows your SURF Research Cloud
workspaces inside Claude Code and lets you start/stop them, so a resume that cannot get
its GPUs shows up quickly instead of after the portal's ~10-minute timeout.

- **Status line** under the prompt: `SURF: markisaacsim paused`.
- **`/surf`** opens a pane per workspace: status, size flavour (e.g. `A10 - 2 GPU`), IP,
  the last action's error text, and **Starten** (resume) / **Stoppen** (pause, with a
  confirm step). `r` refreshes.
- **Polling:** every `poll_seconds` (60 s) while idle, every 10 s while a workspace is
  `resuming`/`pausing`/….
- **GPU availability** per flavour (`A10 - 2 GPU vrij/bezet`) in the status line and pane, read
  the way the portal's create dialog does: nothing is created. A toast when a flavour comes
  free again, and a warning next to **Starten** while yours is taken.
- **Toasts** (and a macOS notification) when a resume reaches `running`, when it falls back
  to `paused`/`failed` (with SURF's error text if the API gives one), and when it is still
  `resuming` after `resume_warn_minutes` (4 min): the usual sign that no GPUs are free.

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

The error fields of a failed action are not documented either; the mod looks for
`error`/`message`/`reason`/`detail` on the workspace and its newest action. To see the raw
answer once:

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
| `workspace` | `""` | only show workspaces whose name contains this text |
| `poll_seconds` | `60` | poll interval while nothing is changing (min 15) |
| `resume_warn_minutes` | `4` | toast when still `resuming` after this long; `0` turns it off |
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
transitions, the token lookup, the resume → paused toast and the availability check
(fixture trimmed from a real offerings answer).
