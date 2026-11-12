# surf-isaac-components

SURF Research Cloud **components** (Ansible playbooks) for Isaac Sim / Lab / Arena, and for the services around a robot cell: a WireGuard tunnel, the Universal Robots simulator and the Paradaim plan server.

## Components

| Component | Path | Purpose |
|---|---|---|
| `wireguard` | `wireguard/install-wireguard.yml` | WireGuard server on the workspace. The other components listen on its tunnel IP, so only one UDP port is public |
| `nvidia-isaac-sim-lab-arena` | `nvidia-isaac-sim-lab-arena/install-isaac.yml` | Headless GPU workstation running Isaac Sim / Lab / Arena as a container, pinned by digest |
| `universal-robots-ursim` | `universal-robots-ursim/install-ursim.yml` | **Optional.** Universal Robots URSim (e-Series simulator) as a container, to test ur_rtde / the ROS driver / cuRobo before the real arm |
| `paradaim-planserver` | `paradaim-planserver/install-planserver.yml` | **Optional.** Plan server of the Paradaim planner: answers a laptop next to the robot with a joint trajectory (stored expert trajectories and the model on the CPU; cuRobo on a GPU is planned) |
| `nvidia-omni-asset-cache` | `nvidia-omni-asset-cache/install-asset-cache.yml` | **Not built yet** local cache of the Omniverse/Isaac assets on persistent storage |

### Catalog items

A catalog item runs its components in order. `wireguard` goes first: the components after it look for the tunnel and listen on its IP.

| Catalog item | Components, in order | Flavour |
|---|---|---|
| Isaac workstation | SURF's CUDA component → `wireguard` → `nvidia-isaac-sim-lab-arena` → `universal-robots-ursim` → `paradaim-planserver` (the last two optional) | GPU |
| Robot test server | `wireguard` → `universal-robots-ursim` → `paradaim-planserver` (`planserver_mode=cpu`) | CPU only |
| Plan server with cuRobo (planned) | SURF's CUDA component → `wireguard` → `universal-robots-ursim` → `paradaim-planserver` (`planserver_mode=gpu`) | 1× RTX 6000 |

In the access rules of every item open only the WireGuard port (`51820/UDP`) and SSH.

---

## WireGuard

A WireGuard server on the workspace. Everything else (Isaac's WebRTC stream, URSim, the plan server, a Foxglove WebSocket) listens on the tunnel IP `10.8.0.1`, so none of it is on the public interface.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `wireguard_port` | `51820` | WireGuard listen port (UDP). Open only this port in the catalog access rules |
| `wireguard_address` | `10.8.0.1/24` | Server tunnel IP + subnet. Clients get `.2`, `.3`, … in order of `wireguard_peers` |
| `wireguard_peers` | `""` | Client **public** keys, comma/space/newline separated. `PUBKEY` or `PUBKEY@10.8.0.7` (explicit tunnel IP). Empty = tunnel up without peers |
| `wireguard_endpoint` | `{{ ansible_fqdn }}` | Host the client connects to (written into the client example config). Set via the **Resource** source type `workspace_fqdn` |
| `wireguard_private_key` | `""` | Optional server private key as a **collaboration secret** so the server key survives a rebuild. Empty = generated on the workspace |

The component installs WireGuard, creates the server key (or uses the `wireguard_private_key` secret), writes `/etc/wireguard/wg0.conf` with one `[Peer]` per key in `wireguard_peers` and starts `wg-quick@wg0`. The playbook output and the SSH login banner show the **server public key**; a ready-to-fill client config is in `/etc/wireguard-client-example.conf`.

### Client

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

Then `wg-quick up wg0`. To add a peer later, add its key to `wireguard_peers` and rerun the component, or ad hoc on the workspace: `sudo wg set wg0 peer <PUBKEY> allowed-ips 10.8.0.9/32` (not persisted). Without the `wireguard_private_key` secret a rebuild generates a new server key, so update `[Peer] PublicKey` on the clients afterwards.

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
| `isaac_option` | `lab` | Which variant to deploy: `full-isaac` / `lab` / `sim` / `arena` (`full_isaac` and capitals are accepted too) |
| `isaac_sim_version` / `isaac_lab_version` | `latest` / `latest` | Which version to pull. `latest` = the newest version tag of `nvcr.io/nvidia/isaac-sim` / `isaac-lab` on NGC at provisioning (the playbook lists the registry tags and takes the highest version). Or a tag, e.g. `6.1.0` or `3.0.0-rc1`, to stay on that version |
| `isaac_sim_prerelease` / `isaac_lab_prerelease` | `false` / `true` | Whether `latest` may pick a pre-release (`-rc`, `-beta`, `-dev`). On for Isaac Lab while 3.0 is a release candidate, because the newest Lab *release* is still the 2.x line on Isaac Sim 5. Turn it off once Lab 3.0 is GA |
| `image_sim` / `image_lab` | `""` | Optional full image reference, wins over the version (`""` and `latest` both mean: use the version): e.g. `nvcr.io/nvidia/isaac-sim@sha256:<digest>` to pin exactly. The tag and digest actually pulled are printed by the playbook and stored in `/etc/isaac/image-digest` (see [Pinning images](#pinning-images)). **Leave it empty to get the newest version**: a catalog item that still sets it stays on that image |
| `image_full` | `""` | Empty (default) = build full-isaac from source at provisioning. Set to a registry digest to pull a pre-built image instead |
| `arena_ref` | `8737b4ce…` | full-isaac build-on-deploy: Arena git commit/tag/branch to build. Default = `release/0.3.0` tip (2026-09-15, Arena 0.3 Alpha, builds on `isaac-sim:6.0.1` + Isaac Lab 3.0); change to roll forward |
| `isaac_data_root` | `isaac-data` | The **persistent data volume** (survives a rebuild): its **name** (`isaac-data`) or its mount path (`/data/isaac-data`). SURF mounts a volume at `/data/<volume-name>`, so a name gets `/data/` in front. The playbook stops when the directory does not exist and warns when it is not a separate mount |
| `scratch_root` | `/mnt/scratch` | Mount point of the **ephemeral scratch disk** (fast local NVMe, auto-added on GPU flavours, **wiped on reboot**). Holds the regenerable Omniverse/Kit caches; the unit recreates the dirs at each start |
| `isaacsim_host` | `127.0.0.1` | Address the streaming client connects to. `127.0.0.1` only works locally — for remote streaming set it to a reachable address: easiest is SURF's **Resource** source type with value `workspace_fqdn` (auto-fills the workspace DNS name). With a WireGuard tunnel on the workspace (the `wireguard` component) it is ignored: the stream is advertised on the tunnel IP |
| `isaac_autostart` | `false` | Start the container at boot. `false` = installed but stopped, so the GPU stays free for training; start it when needed with `sudo systemctl start isaac` (stop: `sudo systemctl stop isaac`). `true` = enabled and started |
| `isaac_signal_port` | `49100` | WebRTC **signaling** (TCP) — establishes the connection between client and workstation |
| `isaac_stream_port` | `47998` | WebRTC **media** (UDP) — carries the video stream itself |
| `manage_nvidia_driver` | `true` | Installs and pins the NVIDIA driver to the version recommended by NVIDIA. `false` = leave the CUDA component's driver as-is |
| `nvidia_driver_branch` | `580` | Driver branch to install. **R580** runs the A10 (Ampere) and the RTX PRO 6000 (Blackwell) with Isaac Sim 6.x and CUDA 13 |
| `nvidia_kernel_modules` | `open` | `open` installs `nvidia-open-<branch>` (NVIDIA's open kernel modules): **required for Blackwell** (RTX PRO 6000) and supported on the A10. `proprietary` = the old `cuda-drivers-<branch>` (A10 only). A driver with the other flavour is purged and replaced |
| `nvidia_driver_pin_glob` | `580.*` | Keeps the driver on this branch (any 580.x) and blocks a jump to a newer branch (590+) |
| `nvidia_driver_apt_version` | `""` | Optionally pin an **exact** driver version (e.g. NVIDIA's tested `580.95.05`). Empty = latest 580.x |
| `isaac_stream_over_wireguard` | `true` | When the `wireguard` component ran before this one, advertise the stream on the tunnel IP (no public WebRTC ports). `false` = always use `isaacsim_host`. Without a tunnel the value does not matter. See [Option B](#streaming-and-network-access) |

**Secret:** the NGC API key is provided as the var `ngc_api_key` from a **SURF collaboration secret (Vault)**.

**Versions (2026-09-22):** `sim` = Isaac Sim **6.1.0** GA (2026-09-10) · `lab` = Isaac Lab **3.0.0 RC1** (`v3.0.0-EA`, 2026-09-16, GA targeted end of October 2026) on Isaac Sim 6.1 · `full-isaac` = Arena **release/0.3.0** (0.3 Alpha, 2026-09-10) which still builds on `isaac-sim:6.0.1`. Isaac Lab 3.0 needs Python 3.12 and the pre-built image now runs its runtime as uid 1000 (`isaaclab`), which matches the `isaac_uid` this component already used.

### Pinning images
By default the playbook pulls the newest version on NGC, so two workstations made a month apart can run different versions. To stay on a version, set `isaac_sim_version` / `isaac_lab_version` to its tag. To freeze a deploy exactly, take the digest the playbook reports (also in `/etc/isaac/image-digest` on the workstation) and set the parameter to `nvcr.io/nvidia/isaac-sim@sha256:<digest>`. To resolve a digest without a workstation, from any machine logged in to NGC:

```bash
docker buildx imagetools inspect nvcr.io/nvidia/isaac-sim:6.1.0 | grep Digest
docker buildx imagetools inspect nvcr.io/nvidia/isaac-lab:3.0.0-rc1 | grep Digest
```

### GPU flavours: A10 and RTX 6000
The component runs on SURF HPC Cloud's `A10` flavours and on the `RTX 6000` flavour that replaces the RTX 2080 (service notice 2026-10-28). SURF's RTX 6000 is the **RTX PRO 6000 Blackwell** (96 GB, compute capability 12.0). Add the flavour to the catalog item in the portal; nothing else changes per flavour:
- **Driver:** the same R580 pin, with the open kernel modules (default `nvidia_kernel_modules: open`). Blackwell does not run on the proprietary modules. Check after the first boot: `cat /proc/driver/nvidia/version` shows `Open Kernel Module`.
- **Images:** Isaac Sim 6.1 lists the RTX PRO 6000 Blackwell as its "Ideal" GPU; the NGC images ship a PyTorch with sm_120.
- **Prices:** SURF has one GPU credit tariff in 2026 and will differentiate by GPU type from 2027.

### Multiple GPUs (e.g. 2× A10)
The unit starts the container with `--gpus all`, so every GPU on the flavour is visible inside it. Isaac Sim renders/streams on one GPU; Isaac Lab training picks its device per run, e.g. `./isaaclab.sh -p scripts/... --device cuda:1` to keep training off the GPU that drives the stream. All GPUs stay on the R580 driver branch.

**Catalog item order:** `… → CUDA component → this component`

> **First boot:** the CUDA component installs a newer driver, so this component replaces it with R580 (open kernel modules). The new driver only loads after a reboot — SURF does not reboot automatically. After the first provisioning, `nvidia-smi` reports a "Driver/library version mismatch"; reboot the workspace once (`sudo systemctl reboot -i`). With `isaac_autostart: true` `isaac.service` then comes up on its own; otherwise start it with `sudo systemctl start isaac`.

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

**Option A — public ports (simplest, for testing).** Leave the `wireguard` component out of the catalog item (or set `isaac_stream_over_wireguard=false`), open `49100/TCP` and `47998/UDP` to your client IP (`/32`) in the catalog item's access rules. Set `isaacsim_host` via the **Resource** source type with value `workspace_fqdn`, so the stream advertises the workspace's public DNS name.

**Option B — WireGuard (no public WebRTC ports, recommended).** Put the [`wireguard`](#wireguard) component before this one and open only the WireGuard port (`51820/UDP`) in the access rules. This component finds the tunnel and advertises its IP (default `10.8.0.1`) instead of `isaacsim_host`; leave `isaacsim_host` at its default. Bring the tunnel up on your client and point the Isaac Sim WebRTC client at `10.8.0.1`.

> **Catalog items from before 2026-11-12** passed `wireguard_enabled` and the other `wireguard_*` parameters to this component, which installed WireGuard itself. Add the `wireguard` component before this one, move the `wireguard_*` parameters to it and remove `wireguard_enabled`. Keep the `wireguard_private_key` secret, so the clients do not notice the change. A workstation that is already running keeps its tunnel; the playbook only stops when `wireguard_enabled=true` is passed and no tunnel exists.

> The value applied to `isaacsim_host` comes from the catalog item and is (re)applied on create/rebuild — a normal reboot keeps any manual change, a rebuild resets it to the catalog value.

For more information, see [Livestream Clients](https://docs.omniverse.nvidia.com/app_isaacsim/app_isaacsim/streaming.html).


> `full-isaac` is the heaviest option (full Sim + Lab + Arena + GR00T/openpi clients; Arena 0.3 is Alpha: APIs still move) and pulls many assets. Pick it when you need the **editor + training (+ benchmarking) on one workstation with one volume**; for pure headless training jobs the lighter `lab` image is faster.

---

## Universal Robots URSim (optional)

URSim is the official Universal Robots simulator: the real controller and PolyScope in a container. Robot code talks to it exactly like to the real arm (dashboard 29999, RTDE 30004, ROS driver), so a planner or controller can be tested before it moves the real robot.

**Catalog item order:** `wireguard → (nvidia-isaac-sim-lab-arena →) universal-robots-ursim`. The tunnel comes from the `wireguard` component; Docker from the Isaac component, or this component installs it when it is missing.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `ursim_version` | `5.21` | URSim image tag. **Match the PolyScope version of the real robot** (tablet: menu → About) |
| `ursim_robot_model` | `UR5E` | Robot model (`UR3E`, `UR5E`, `UR7E`, `UR10E`, `UR12E`, `UR16E`, `UR15`, `UR20`, `UR30`) |
| `ursim_data_root` | `isaac-data` | Volume name or mount path; data go to `<volume>/ursim` |
| `ursim_bind_address` | `10.8.0.1` | Host address the ports listen on. Default = WireGuard tunnel IP, so nothing is public. Use `127.0.0.1` without WireGuard (SSH tunnel) |
| `ursim_subnet` / `ursim_ip` | `172.30.56.0/24` / `.101` | Private Docker network. Not `192.168.56.0/24` from the ROS-driver docs: that overlaps SURF's `192.168.0.0/16` |
| `ursim_autostart` | `false` | `false` = installed but **not started at boot** (the workstation is mainly for training); start it with `sudo systemctl start ursim`. `true` = starts at every boot |
| `ursim_auto_remote` | `true` | After every start, confirm a pending safety configuration and switch PolyScope to **Remote Control** |
| `externalcontrol_urcap_version` | `1.0.6` | External Control URCap for the ROS driver |

### Access

| From | Robot address | Ports |
|---|---|---|
| the workstation | `172.30.56.101` (`ursim_ip`) | all |
| a WireGuard client | `10.8.0.1` (`ursim_bind_address`) | 6080 (PolyScope in the browser), 5900 (VNC), 29999, 30001–30004 |

PolyScope in the browser: `http://10.8.0.1:6080/vnc.html?autoconnect=1&resize=scale`. For the ROS driver / External Control URCap the reverse IP is the host side of the Docker network, `172.30.56.1`, port 50002. A program that runs on a WireGuard client (the UR Client Library on a laptop) gives its own tunnel IP as reverse IP (`10.8.0.2`): the controller then connects back through the tunnel to ports 50001–50004 on the client, which the client's firewall has to allow on the WireGuard interface. This path relies on Docker's default NAT from the URSim network to the tunnel and has not been tested over a real tunnel yet.

Start on demand: `sudo systemctl start ursim` (about a minute until PolyScope is up and switched to Remote), stop with `sudo systemctl stop ursim`. Smoke test (power on, brakes released, two `moveJ`s): `/opt/ursim/venv/bin/python /opt/ursim/test_rtde.py`. Logs: `docker logs -f ursim`.

### Why Remote Control is switched automatically

Two PolyScope states block external control, on URSim exactly as on the real arm:

- **Unconfirmed safety configuration.** RTDE accepts the connection but never starts streaming (`Failed to start RTDE data synchronization`). Confirmed once, it is stored in the installation in `<volume>/ursim/programs`.
- **Local mode.** ur_rtde refuses with `Please enable remote control on the robot!`. Remote Control is enabled in the settings (seeded into `<volume>/ursim/polyscope`), but PolyScope **always boots in Local**, and there is no API to switch.

`ursim-ready.sh` (run by `ursim.service` after every start) therefore clicks both through VNC. Switch back to Local in PolyScope (top right) to run programs from the screen yourself. URSim uses UR's default safety limits, not those of your cell.

### Storage

| Where | Container path | Why |
|---|---|---|
| `<volume>/ursim/programs` | `/ursim/programs` | programs + installation (incl. the confirmed safety configuration) |
| `<volume>/ursim/polyscope` | `/ursim/.polyscope` | PolyScope settings (Remote Control enabled, welcome screen off) |
| `<volume>/ursim/urcaps` | `/urcaps` | External Control URCap, installed at start |
| `/opt/ursim` (boot disk) | — | compose file, helper scripts, venv with ur_rtde + vncdotool; recreated by the component |

---

## Paradaim plan server (optional)

The plan server of the [Paradaim planner](https://github.com/MarkHeeling/planner) (`scripts/planserver.py`) as a systemd service. A laptop next to the robot sends a world, a start configuration and a goal over HTTP and gets a joint trajectory back; the laptop validates it (start, limits, collision, world hash) and executes it. The server never moves anything itself, and it answers one plan at a time.

**Catalog item order:** `wireguard → (universal-robots-ursim →) paradaim-planserver`.

| `planserver_mode` | Planners | Needs |
|---|---|---|
| `cpu` (default) | `stored` (the expert trajectories of the dataset) and, with a checkpoint, `model` | no GPU |
| `gpu` | adds `curobo` and `model_curobo` (the model's samples as seeds for cuRobo) | **not available yet**; the playbook stops with a message |

A laptop that runs the model itself still uses the server for the worlds, the stored trajectories and, later, cuRobo: for `model_curobo` it sends its own samples as seeds in the request.

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `planserver_mode` | `cpu` | `cpu` or `gpu` (see above) |
| `planner_repo` / `planner_ref` | `https://github.com/MarkHeeling/planner.git` / `master` | Repository and branch, tag or commit to serve |
| `planner_git_token` | `""` | For a private repository: a read-only GitHub token as a **collaboration secret**. Used for the clone only and not left in `.git/config` |
| `planner_checkout` | `""` | Serve from a checkout that is already on the workspace (e.g. the one used for training) instead of cloning. The component never runs git in it |
| `planserver_dir` | `/opt/planserver` | Clone, Python environment and uv (boot disk, about 6 GB: the planner's lockfile installs PyTorch with its CUDA libraries, also in `cpu` mode) |
| `planserver_data_root` | `isaac-data` | Volume name or mount path; relative paths below are relative to it |
| `planserver_blocks` | `""` | Block directories of the dataset (`problems/`, `pointclouds/`, `trajectories_s*.zarr`), comma/space separated, e.g. `v5/block_00`. Empty = the eight environments of the test fixture in the repository |
| `planserver_checkpoint` | `""` | Model checkpoint, e.g. `planner/outputs/<run>/checkpoint.pt`. Empty = no `model`, only `stored` |
| `planserver_esdf_cache` | `/var/cache/planserver/esdf` | Distance fields the model computes once per environment |
| `planserver_bind_address` | `10.8.0.1` | Address the server listens on. Default = WireGuard tunnel IP. Use `127.0.0.1` without WireGuard (SSH tunnel). The playbook stops when the address is not on the workspace |
| `planserver_port` | `8770` | HTTP port |
| `planserver_autostart` | `true` | Start at boot (the `cpu` mode is light). `false` = installed but stopped: `sudo systemctl start planserver` |
| `planserver_user` | `planserver` | System user the service runs as. It needs read access to the block directories and the checkpoint |

### Access

The server has **no login and no TLS**: it is meant for the tunnel only. Never bind it to a public address.

| From | URL |
|---|---|
| the workspace | `planserver health`, `planserver worlds`, `planserver plan --world <id> --goal <n>` (a wrapper around `scripts/planserver.py` with the right URL) |
| a WireGuard client | `http://10.8.0.1:8770`: `GET /health`, `/worlds`, `/worlds/<id>`; `POST /plan`; `GET /worlds/<id>/ik_request`, `/worlds/<id>/pointcloud` and `/model/checkpoint` to run the model on the client |

On the laptop, in the planner repository: `uv run python scripts/planserver.py health --url http://10.8.0.1:8770`, and `scripts/ursim_foxglove.py --planserver http://10.8.0.1:8770` for the Foxglove controls. Logs: `journalctl -u planserver -f` (one line per request with its duration and outcome).

To serve a newer planner, rerun the component: it updates the clone to `planner_ref`, syncs the Python environment with the lockfile and restarts the service.

---

## NVIDIA Omniverse asset cache

> **Not built yet** — planned component.

Isaac Sim/Lab loads its 3D assets (robots, environments, materials) from the cloud through Omniverse by default. In the minimal container the cache service (OmniHub) does not start, so every run fetches the assets again: slower loading and log noise. The Omniverse asset cache component will provide a local cache of the assets on persistent storage, so that Isaac Sim/Lab can load them from disk instead of the cloud.

---

## Browser extension: workspace status

[`browser-extension/surf-workspace`](browser-extension/surf-workspace/README.md) is an extension for Helium (or any Chromium browser) that shows whether your workspace runs and whether its GPUs are available, and starts and stops it. It notifies you when the GPUs come free or a start fails, instead of waiting for the portal's timeout.
