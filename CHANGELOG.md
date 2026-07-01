# Changelog

Notable changes to the `nvidia-isaac-sim-lab-arena` SURF Research Cloud component.
Images are pinned by digest, so a "version" is the pinned image plus this history.
Dates are when the change landed in the repo.

## 2026-07-01 — full-isaac rolled forward to Arena release/0.2.1

- Bumped `arena_ref` from `baa1b119` (main, 2026-06-23) to the `release/0.2.1` tip
  (`0a1b8c23`), so build-on-deploy now builds the newest **tested** Arena instead of a
  bare main commit. Pinned by commit (not the branch name) to keep the build reproducible.
- No Sim bump: every 0.2.x branch — including `main` — still builds on
  `isaac-sim:6.0.0-dev2`. Isaac Sim reached 6.0.0 GA (2026-06-04) and 6.0.1 (2026-06-22),
  but Arena has not moved its base image off `6.0.0-dev2` yet, so full-isaac does not use
  6.0.1. Forcing it via `--build-arg BASE_IMAGE=…:6.0.1` is an untested combination and
  is deliberately not done here.
- Not re-validated end-to-end on a workstation after the bump — the 2026-06-23 validation
  was against `baa1b119`. Re-run the Lab train + editor + Arena checks on the next deploy.

## 2026-06-23 — full-isaac validated + build-on-deploy

- Validated the source-built full-isaac image (`isaaclab_arena:latest`, ~40 GB) end-to-end on
  a workstation: Isaac Lab training, the full Isaac Sim **editor** (runheadless WebRTC — stage
  authoring works, which the minimal `lab` image cannot), and the Arena test suite.
- Switched full-isaac distribution to **build-on-deploy**: a tarball on personal storage isn't
  shareable and no free registry can host a 40 GB NVIDIA-derived image. The component now clones
  Arena at `arena_ref` and `docker build`s the image at provisioning (~15 min), so the catalog
  item is shareable via the repo, not an image binary. `image_full` becomes an optional registry
  override; new parameters `arena_repo` / `arena_ref` / `arena_src_dir`.
- full-isaac unit corrected to the Arena run model: the image's custom entrypoint creates a user
  from `DOCKER_RUN_*` env (no `-u`/`--entrypoint`), `--ipc=host`, Arena paths, and a `chown` of
  the root-owned IsaacLab submodule dir at start so Lab can write outputs/logs. The container
  command is passed as one quoted string (the entrypoint runs `bash -ic "$@"`).

## 2026-06-22 — Add `full-isaac` option (editor + training + Arena, one image)

- New `isaac_option=full-isaac`: a single **source-built** image with the full Isaac Sim
  editor + Isaac Lab + Isaac Lab Arena, so stage authoring, training and benchmarking run on
  **one workstation with one persistent volume**. A SURF external volume is single-attach, so
  splitting Sim and Lab across two workspaces (and moving data between them) was impractical.
- Rationale: the minimal pre-built `lab` image is headless-training-only (no full editor).
  `full-isaac` is built via the Arena Docker build (`IsaacLab-Arena/docker/run_docker.sh`),
  which pulls in Isaac Lab and the full Isaac Sim. See README "Building full-isaac".
- New `image_full` parameter (empty by default; set it to your built, digest-pinned image).
  The playbook fails fast if `full-isaac` is selected while `image_full` is empty.
- Options are now `full-isaac` / `lab` / `sim` / `arena`. `arena` stays a reserved placeholder
  until NVIDIA ships a pre-built Arena image (Arena is already included in `full-isaac`).
- `full-isaac` reuses the `lab` run pattern (idle container, uid 1000, scratch caches +
  persistent logs/data_storage); its uid and in-container paths must be verified against the
  built image, since a source build can differ from the minimal `lab` image.

## 2026-06-22 — Storage split + NVIDIA-aligned mounts

- **Persistent vs scratch split (lab).** Only the data worth keeping stays on the
  external volume (`isaac_data_root`): `/workspace/isaaclab/logs` (training output)
  and `/workspace/isaaclab/data_storage`. The regenerable Omniverse/Kit caches move
  to the ephemeral scratch disk (`scratch_root`, `/mnt/scratch`). Follows SURF
  guidance (caches → scratch, persistent data → external volume).
- **Completed the mount set** against the NVIDIA Isaac Lab Docker volume table:
  added the Kit cache (`/isaac-sim/kit/cache`), the CUDA ComputeCache (`/root/.nv`),
  and the persistent `data_storage` volume that were previously missing.
- **New parameter `scratch_root`** (default `/mnt/scratch`). The systemd unit
  recreates the scratch cache dirs at each start, since scratch is wiped on reboot.
- **`isaac_data_root` default** changed from `/data/disk-name` to `/data/isaac-data`.
- **Container uid no longer hardcoded.** The unit uses `{{ isaac_uid }}` everywhere,
  so the dir owner (chown), `docker run -u`, and the scratch `install -d` can never
  drift. The images run as root by default; we override to a non-root uid only
  because SURF's external volume squashes root.
- **Docs:** README gains a "Storage layout" table and a "Known headless warnings
  (cosmetic)" section (OmniHub launch failure, missing `packaging` module, the
  `(unhealthy)` healthcheck) — all confirmed harmless for headless training.
- Validated on a live workspace: `Isaac-Cartpole-v0` trains and checkpoints land on
  `/data/isaac-data/isaac-lab/logs/`. Not yet validated via a fresh recreate.

## 2026-06-20 — SURF registration

- Registered the component in the SURF portal (Development) and built the catalog
  item. Component order: SRC-OS → SRC-CO → SRC-External → CUDA → this component.
- Exposed parameters (`isaac_option`, image digests, data root, streaming host/ports,
  driver pin). Generic keys prefixed `isaac_*`. NGC API key supplied as the
  `ngc_api_key` collaboration secret (Vault).
- Streaming over WireGuard (no public WebRTC ports); `isaacsim_host` via the
  `workspace_fqdn` Resource source for the public-port alternative.

## 2026-06-19 — Initial component

- Single Ansible component deploying Isaac Sim / Lab as a digest-pinned container:
  Docker CE + NVIDIA Container Toolkit, NGC login, image pull, and a systemd unit
  (`sim` = WebRTC stream, `lab` = idle + `docker exec` to train).
- Section 0 pins the NVIDIA driver to the R580 branch after the SURF CUDA component
  (`apt-mark hold` + apt preference blocking 590). One reboot is needed after first
  provisioning to load the pinned driver; `isaac.service` recovers on the next boot.
- `arena` reserved as a third option (no pre-built image yet).
