# surf-isaac-components

SURF Research Cloud **components** (Ansible playbooks) for Isaac Sim / Lab / Arena.

## Components

| Component | Path | Purpose |
|---|---|---|
| `nvidia-isaac-sim-lab-arena` | `nvidia-isaac-sim-lab-arena/install-isaac.yml` | Headless GPU workstation running Isaac Sim / Lab / Arena as a container, pinned by digest |
| `nvidia-omni-asset-cache` | `nvidia-omni-asset-cache/install-asset-cache.yml` | **Not built yet** local cache of the Omniverse/Isaac assets on persistent storage |

---

## NVIDIA Isaac Sim / Lab / Arena

### Options

| Option | Contains | Image | How |
|---|---|---|---|
| `full-isaac` | Full Isaac Sim editor + Lab + Arena | source build (Arena Dockerfile) | **built on the workstation at provisioning** (build-on-deploy, ~15 min); or set `image_full` to pull a pre-built image (see `image_full` / `arena_ref` under [Parameters](#parameters)) |
| `lab` | Isaac Sim (minimal) + Lab | `isaac-lab` (NGC) | pre-built → pull (digest-pinned); headless training + lean livestream, **no full editor** |
| `sim` | Full Isaac Sim editor | `isaac-sim` (NGC) | pre-built → pull (digest-pinned) |
| `arena` | — | — | deferred until NVIDIA ships a pre-built Arena image (Arena is already in `full-isaac`) |

**Which option?** `full-isaac` for interactive work — editor + training (+ Arena) on one workstation and one volume. `lab` for lightweight headless training jobs. `sim` for just the Isaac Sim editor. `arena` is a reserved placeholder.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `isaac_option` | `lab` | Which variant to deploy: `full-isaac` / `lab` / `sim` / `arena` |
| `image_sim` / `image_lab` | `isaac-sim:6.1.0` / `isaac-lab:3.0.0-rc1` | Pre-built NGC image per option (Isaac Sim 6.1.0 GA, Isaac Lab 3.0.0 RC1 on Sim 6.1). Set to `…@sha256:<digest>` to pin exactly; the digest actually pulled is printed by the playbook and stored in `/etc/isaac/image-digest` (see [Pinning images](#pinning-images)) |
| `image_full` | `""` | Empty (default) = build full-isaac from source at provisioning. Set to a registry digest to pull a pre-built image instead |
| `arena_ref` | `8737b4ce…` | full-isaac build-on-deploy: Arena git commit/tag/branch to build. Default = `release/0.3.0` tip (2026-09-15, Arena 0.3 Alpha, builds on `isaac-sim:6.0.1` + Isaac Lab 3.0); change to roll forward |
| `isaac_data_root` | `/data/isaac-data` | Mount point of the **persistent data volume** (survives a rebuild). Must match the volume's mount path — SURF mounts it at `/data/<volume-name>`, so name the volume `isaac-data` |
| `scratch_root` | `/mnt/scratch` | Mount point of the **ephemeral scratch disk** (fast local NVMe, auto-added on GPU flavours, **wiped on reboot**). Holds the regenerable Omniverse/Kit caches; the unit recreates the dirs at each start |
| `isaacsim_host` | `127.0.0.1` | Address the streaming client connects to. `127.0.0.1` only works locally — for remote streaming set it to a reachable address: easiest is SURF's **Resource** source type with value `workspace_fqdn` (auto-fills the workspace DNS name). With `wireguard_enabled` the playbook overrides it with the tunnel IP |
| `isaac_signal_port` | `49100` | WebRTC **signaling** (TCP) — establishes the connection between client and workstation |
| `isaac_stream_port` | `47998` | WebRTC **media** (UDP) — carries the video stream itself |
| `manage_nvidia_driver` | `true` | Installs and pins the NVIDIA driver to the version recommended by NVIDIA. `false` = leave the CUDA component's driver as-is |
| `nvidia_driver_branch` | `580` | Driver branch to install. **R580** is validated by NVIDIA for the A10 (Ampere) with Isaac Sim 6.0 |
| `nvidia_driver_pin_glob` | `580.*` | Keeps the driver on this branch (any 580.x) and blocks a jump to a newer branch (590+) |
| `nvidia_driver_apt_version` | `""` | Optionally pin an **exact** driver version (e.g. NVIDIA's tested `580.95.05`). Empty = latest 580.x |
| `wireguard_enabled` | `false` | Install a **WireGuard** server on the workstation so the WebRTC viewer is reached over the tunnel (no public WebRTC ports). See [Option B](#streaming-and-network-access) |
| `wireguard_port` | `51820` | WireGuard listen port (UDP). Open only this port in the catalog access rules |
| `wireguard_address` | `10.8.0.1/24` | Server tunnel IP + subnet. Clients get `.2`, `.3`, … in order of `wireguard_peers` |
| `wireguard_peers` | `""` | Client **public** keys, comma/space/newline separated. `PUBKEY` or `PUBKEY@10.8.0.7` (explicit tunnel IP). Empty = tunnel up without peers |
| `wireguard_endpoint` | `{{ ansible_fqdn }}` | Host:port the client connects to (written into the client example config). Set via the **Resource** source type `workspace_fqdn` |
| `wireguard_private_key` | `""` | Optional server private key as a **collaboration secret** so the server key survives a rebuild. Empty = generated on the workstation |

**Secret:** the NGC API key is provided as the var `ngc_api_key` from a **SURF collaboration secret (Vault)**. Optionally `wireguard_private_key` the same way.

**Versions (2026-09-22):** `sim` = Isaac Sim **6.1.0** GA (2026-09-10) · `lab` = Isaac Lab **3.0.0 RC1** (`v3.0.0-EA`, 2026-09-16, GA targeted end of October 2026) on Isaac Sim 6.1 · `full-isaac` = Arena **release/0.3.0** (0.3 Alpha, 2026-09-10) which still builds on `isaac-sim:6.0.1`. Isaac Lab 3.0 needs Python 3.12 and the pre-built image now runs its runtime as uid 1000 (`isaaclab`), which matches the `isaac_uid` this component already used.

### Pinning images
The defaults pull by **tag** (`:6.1.0`, `:3.0.0-rc1`). To freeze a deploy, take the digest the playbook reports (also in `/etc/isaac/image-digest` on the workstation) and set the parameter to `nvcr.io/nvidia/isaac-sim@sha256:<digest>`. To resolve a digest without a workstation, from any machine logged in to NGC:

```bash
docker buildx imagetools inspect nvcr.io/nvidia/isaac-sim:6.1.0 | grep Digest
docker buildx imagetools inspect nvcr.io/nvidia/isaac-lab:3.0.0-rc1 | grep Digest
```

### Multiple GPUs (e.g. 2× A10)
The unit starts the container with `--gpus all`, so every GPU on the flavour is visible inside it. Isaac Sim renders/streams on one GPU; Isaac Lab training picks its device per run, e.g. `./isaaclab.sh -p scripts/... --device cuda:1` to keep training off the GPU that drives the stream. Both A10s stay on the R580 driver branch.

**Catalog item order:** `… → CUDA component → this component`

> **First boot:** the CUDA component installs a newer driver, so this component downgrades it to R580. The new driver only loads after a reboot — SURF does not reboot automatically. After the first provisioning, `nvidia-smi` reports a "Driver/library version mismatch"; reboot the workspace once (`sudo systemctl reboot -i`) and `isaac.service` comes up on its own.

### Storage layout (lab)
Following the [Isaac Lab Docker volumes](https://isaac-sim.github.io/IsaacLab/main/source/deployment/docker.html#understanding-the-mounted-volumes), storage is split by what is worth keeping. The container runs as a non-root uid (`isaac_uid`) that owns these dirs, because the image runs as root but SURF's external volume squashes root.

| Where | Container path | Why |
|---|---|---|
| `isaac_data_root` — **persistent** | `/workspace/isaaclab/logs` | training output / checkpoints |
| `isaac_data_root` — **persistent** | `/workspace/isaaclab/data_storage` | user data to preserve between runs |
| `scratch_root` — ephemeral | `/isaac-sim/kit/cache` | Kit shader/extension cache |
| `scratch_root` — ephemeral | `/root/.cache` | OV + pip + GLCache |
| `scratch_root` — ephemeral | `/root/.nv` | CUDA ComputeCache |
| `scratch_root` — ephemeral | `/root/.local/share/ov` | Omniverse asset/Nucleus cache (until the asset-cache component lands) |
| `scratch_root` — ephemeral | `/root/.nvidia-omniverse` | Omniverse logs + config |

Caches on scratch cost only a slower first run after a reboot, not data loss (SURF: caches → scratch, persistent data → external volume).

### Known headless warnings (cosmetic)
The headless container logs a few harmless errors. Training (e.g. `Isaac-Cartpole-v0`) completes normally despite them:

- **`OmniHub: Hub failed to launch …`** — seen with the 3.0.0-beta images (the container forbade OmniHub from starting); the 3.0.0-rc1 image lets OmniHub start with its cache in `/var/cache/hub` (inside the container, lost on restart). Assets are still fetched from the cloud until the asset-cache component lands.
- **`FileNotFoundError … pip_prebundle/packaging/__init__.py`** → `isaacsim.core.experimental.objects` / `isaacsim.asset.importer.heightmap` fail to load. A beta-image defect ([IsaacLab #5351](https://github.com/isaac-sim/IsaacLab/issues/5351)); these extensions are not used by the RL tasks.
- **`(unhealthy)` in `docker ps`** — the image HEALTHCHECK probes a running Isaac app; in idle/headless (`sleep infinity`) it reports unhealthy while `docker exec` training works fine.

### Streaming and network access
For viewing the Isaac Sim / Lab / Arena GUI, the container runs a **WebRTC** stream. The client connects to the workstation's public IP and receives the video stream.

The client can be downloaded from NVIDIA's site: [Isaac Sim WebRTC Streaming Client](https://docs.isaacsim.omniverse.nvidia.com/latest/installation/download.html#isaac-sim-latest-release).

Isaac streaming needs two ports reachable from your client:

- `49100/TCP` — signaling (`isaac_signal_port`)
- `47998/UDP` — media / video (`isaac_stream_port`)

There are **two alternative ways** to make the workstation reachable. Pick one — they set `isaacsim_host` to different values and are not combined:

**Option A — public ports (simplest, for testing).** Open `49100/TCP` and `47998/UDP` to your client IP (`/32`) in the catalog item's access rules. Set `isaacsim_host` via the **Resource** source type with value `workspace_fqdn`, so the stream advertises the workspace's public DNS name.

**Option B — WireGuard (no public WebRTC ports).** Set `wireguard_enabled=true` and open only the WireGuard port (`51820/UDP`, `wireguard_port`) in the access rules. The component installs WireGuard, creates the server key (or uses the `wireguard_private_key` secret), writes `/etc/wireguard/wg0.conf` with one `[Peer]` per key in `wireguard_peers`, starts `wg-quick@wg0`, and advertises the tunnel IP (`wireguard_address`, default `10.8.0.1`) as `isaacsim_host` — leave `isaacsim_host` at its default. The playbook output and the SSH login banner show the **server public key**; a ready-to-fill client config is in `/etc/isaac/wireguard-client-example.conf`.

On your client:

```bash
wg genkey | tee client.key | wg pubkey      # put the public key in wireguard_peers
```

```ini
# /etc/wireguard/wg0.conf on the client (first key in wireguard_peers -> 10.8.0.2)
[Interface]
PrivateKey = <contents of client.key>
Address = 10.8.0.2/32

[Peer]
PublicKey = <server public key from the login banner>
Endpoint = <workspace FQDN>:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

Then `wg-quick up wg0` and point the Isaac Sim WebRTC client at `10.8.0.1`. To add a peer later, add its key to `wireguard_peers` and rerun the component, or ad hoc on the workstation: `sudo wg set wg0 peer <PUBKEY> allowed-ips 10.8.0.9/32` (not persisted). Without the `wireguard_private_key` secret a rebuild generates a new server key, so update `[Peer] PublicKey` on the clients afterwards.

> The value applied to `isaacsim_host` comes from the catalog item and is (re)applied on create/rebuild — a normal reboot keeps any manual change, a rebuild resets it to the catalog value.

For more information, see [Livestream Clients](https://docs.omniverse.nvidia.com/app_isaacsim/app_isaacsim/streaming.html).


> `full-isaac` is the heaviest option (full Sim + Lab + Arena + GR00T/openpi clients; Arena 0.3 is Alpha: APIs still move) and pulls many assets. Pick it when you need the **editor + training (+ benchmarking) on one workstation with one volume**; for pure headless training jobs the lighter `lab` image is faster.

---

## NVIDIA Omniverse asset cache

> **Not built yet** — planned component.

Isaac Sim/Lab loads its 3D assets (robots, environments, materials) from the cloud through Omniverse by default. In the minimal container the cache service (OmniHub) does not start, so every run fetches the assets again: slower loading and log noise. The Omniverse asset cache component will provide a local cache of the assets on persistent storage, so that Isaac Sim/Lab can load them from disk instead of the cloud.

---

## Claude Code mod: workspace status

[`claude-mod/surf-workspace`](claude-mod/surf-workspace/README.md) shows in Claude Code (status line + `/surf` pane) whether your workspace's GPUs are available, starts and stops it, and raises a toast when the GPUs come free or a start fails.
