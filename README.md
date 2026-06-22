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
| `sim` | Isaac Sim | `isaac-sim:6.0.0-dev2` | pre-built image → pull (digest-pinned) |
| `lab` | Isaac Sim + Lab | `isaac-lab:3.0.0-beta2` | pre-built image → pull (digest-pinned) |
| `arena` | Isaac Sim + Lab + Arena | `IsaacLab-Arena/docker/run_docker.sh` | no pre-built image yet → built from source, then digest-pinned |

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `isaac_option` | `lab` | Which variant to deploy: `sim` / `lab` / `arena` |
| `image_sim` / `image_lab` | digests | Container image per option. Overridable → roll out a newer build without editing the playbook |
| `isaac_data_root` | `/data/isaac-data` | Mount point of the **persistent data volume** (survives a rebuild). Must match the volume's mount path — SURF mounts it at `/data/<volume-name>`, so name the volume `isaac-data` |
| `isaacsim_host` | `127.0.0.1` | Address the streaming client connects to: the workspace's public IP (or e.g. a WireGuard tunnel IP) |
| `isaac_signal_port` | `49100` | WebRTC **signaling** (TCP) — establishes the connection between client and workstation |
| `isaac_stream_port` | `47998` | WebRTC **media** (UDP) — carries the video stream itself |
| `manage_nvidia_driver` | `true` | Installs and pins the NVIDIA driver to the version recommended by NVIDIA. `false` = leave the CUDA component's driver as-is |
| `nvidia_driver_branch` | `580` | Driver branch to install. **R580** is validated by NVIDIA for the A10 (Ampere) with Isaac Sim 6.0 |
| `nvidia_driver_pin_glob` | `580.*` | Keeps the driver on this branch (any 580.x) and blocks a jump to a newer branch (590+) |
| `nvidia_driver_apt_version` | `""` | Optionally pin an **exact** driver version (e.g. NVIDIA's tested `580.95.05`). Empty = latest 580.x |

**Secret:** the NGC API key is provided as the var `ngc_api_key` from a **SURF collaboration secret (Vault)**.

**Catalog item order:** `… → CUDA component → this component`

### Streaming and network access
For viewing the Isaac Sim / Lab / Arena GUI, the container runs a **WebRTC** stream. The client connects to the workstation's public IP and receives the video stream.

The client can be downloaded from NVIDIA's site: [Isaac Sim WebRTC Streaming Client](https://docs.isaacsim.omniverse.nvidia.com/latest/installation/download.html#isaac-sim-latest-release).

Isaac streaming needs two ports reachable from your client:

- `49100/TCP` — signaling (`isaac_signal_port`)
- `47998/UDP` — media / video (`isaac_stream_port`)



Rather than opening 49100/47998 to the public internet, you could also use **WireGuard** to connect your client to the workstation's private network. The ports are then reachable through the WireGuard tunnel. 

For more information, see [Livestream Clients](https://docs.omniverse.nvidia.com/app_isaacsim/app_isaacsim/streaming.html).

---

## NVIDIA Omniverse asset cache

> **Not built yet** — planned component.

Isaac Sim/Lab loads its 3D assets (robots, environments, materials) from the cloud through Omniverse by default. In the minimal container the cache service (OmniHub) does not start, so every run fetches the assets again: slower loading and log noise. The Omniverse asset cache component will provide a local cache of the assets on persistent storage, so that Isaac Sim/Lab can load them from disk instead of the cloud.
