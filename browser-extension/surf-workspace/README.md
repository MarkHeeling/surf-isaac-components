# SURF Workspace: browser extension for Helium

An extension for [Helium](https://github.com/imputnet/helium) (it works in any Chromium browser) that shows
your SURF Research Cloud workspace and lets you start and stop it.

- **Toolbar badge:** `aan` (running), `…` (starting or stopping), `vrij` (stopped, GPUs
  available), `vol` (stopped, GPUs not available), `!` (error). Hover shows the one-line status,
  e.g. `SURF: markisaacsim gestopt · GPU's niet beschikbaar`.
- **Popup:** status, whether the GPUs are available, flavour (`A10 - 2 GPU`), IP, the last
  action with SURF's error text (e.g. `Timeout waiting for VM to resume.`), and **Starten** /
  **Stoppen** (stop asks once more). While the GPUs are taken there is no Starten button: a start
  would only end in the portal's ~10-minute timeout.
- **Notifications** when the GPUs come free, when a start or stop has worked, when a start fails
  (with SURF's reason), and when a start is still running after 4 minutes.
- Checks every minute, every 30 s while the workspace is starting or stopping (the shortest
  interval the browser allows). It keeps checking while the browser is open, also with the
  popup closed.

## Install in Helium

1. Download **[surf-workspace.zip](https://github.com/MarkHeeling/surf-isaac-components/releases/latest/download/surf-workspace.zip)**
   and unzip it (double-click in Finder); you get a folder `surf-workspace`. Put it somewhere it
   can stay, e.g. `~/Applications/surf-workspace`: Helium loads it from there.
2. Open the extensions page (menu → Extensions → Manage extensions), switch on
   **Developer mode**, click **Load unpacked** and pick that folder.
3. The settings page opens: paste your API token and click **Opslaan**. Pin the extension
   to the toolbar to see the badge.

Update: download the zip again, replace the folder's contents, and click the reload arrow on
the extension's card. Settings and token stay. The zip is built by
`.github/workflows/surf-workspace-extension.yml` on every change under
`browser-extension/surf-workspace/` on `main`; bump `version` in `manifest.json` for a new
release, otherwise the zip on the current release is replaced.

## API token

Create it in the portal: <https://portal.live.surfresearchcloud.nl/profile> → **API tokens**
→ *Add API token* (it is shown once). The extension keeps it in its own local storage
(`chrome.storage.local`), in this browser profile only; it never leaves the browser except
in the `authorization` header to `gw.live.surfresearchcloud.nl`, the only host the extension
may reach.

## Where the data comes from

The SURF Research Cloud API ([first steps](https://servicedesk.surf.nl/wiki/spaces/WIKI/pages/174981256/Research+Cloud+API+-+First+Steps),
[Swagger](https://gw.live.surfresearchcloud.nl/v1/workspace/swagger/docs/)):

- status: `GET /v1/workspace/workspaces/?application_type=Compute&deleted=false&by_owner=true`;
  the action history is in `workspace_actions[]`, a failed action's text in `result.error`;
- start/stop: `POST /v1/workspace/workspaces/<id>/actions/{resume,pause}/`;
- GPU availability: not documented, but the portal's create dialog reads it from the catalog
  item's offerings, one `available` flag per size flavour (nothing is created):
  `GET /v1/application-market/catalog_items/<catalog_item>/offerings/?co=<co>&product=…`.
  Catalog item, CO and products are under *GPU-beschikbaarheid (geavanceerd)* in the settings.

Field names were checked against the live API on 2026-10-07.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| API-token | – | see above |
| Naamfilter | empty | only show workspaces whose name contains this text |
| Melding als starten langer duurt dan (min) | `4` | `0` turns it off |
| Systeemmeldingen tonen | on | macOS notifications through the browser |
| Catalog item / CO / Producten | Mark's Isaac catalog item | where the availability is read |

## Develop

```bash
cd browser-extension/surf-workspace
npm test        # node --test, no dependencies
```

`surf.js` holds the API URLs, parsing and the rules (pure, tested); `worker.js` the
fetch/compare/notify/start/stop logic with the browser behind an `io` object (tested with a
fake gateway); `background.js` wires it to `chrome.*` and polls with an alarm; `popup.*` and
`options.*` are the two pages.
