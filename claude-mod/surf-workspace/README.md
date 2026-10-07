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
- **Toasts** (and a macOS notification) when a resume reaches `running`, when it falls back
  to `paused`/`failed` (with SURF's error text if the API gives one), and when it is still
  `resuming` after `resume_warn_minutes` (4 min): the usual sign that no GPUs are free.

## What SURF offers, and what it does not

The SURF Research Cloud API ([first steps](https://servicedesk.surf.nl/wiki/spaces/WIKI/pages/174981256/Research+Cloud+API+-+First+Steps),
[Swagger](https://gw.live.surfresearchcloud.nl/v1/workspace/swagger/docs/)) gives workspace
status and the `pause`/`resume` actions. It documents **no endpoint for free GPU capacity**:
the availability you see when creating a new workspace is not in the public docs. So this
mod cannot tell beforehand whether a resume will succeed; it tells you as soon as the
resume stalls or fails. If the portal's create page turns out to call an endpoint for
availability (browser DevTools → Network while choosing a GPU flavour), it can be added.

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

## Develop

```bash
claude plugin validate claude-mod/surf-workspace
claude plugin test claude-mod/surf-workspace
```

`hooks/surf.ts` holds the API URLs, parsing and transition rules; `hooks/register.tsx` the
hooks (session start, `/surf`, the pane); `tests/surf.test.ts` covers parsing, the
transitions, the token lookup and the resume → paused toast.
