export type Workspace = {
  id: string
  name: string
  /** Lower-case SURF status: running, paused, resuming, pausing, failed, ... */
  status: string
  ip?: string
  /** Size flavour, e.g. "A10 - 2 GPU". */
  flavour?: string
  /** An error-like text on the workspace itself, if the API gives one. */
  message?: string
  lastAction?: { type?: string; status?: string; message?: string }
}

export type GpuFlavour = {
  /** Size flavour name, e.g. "A10 - 2 GPU". */
  name: string
  /** The portal's `available` flag: false while no GPUs of this kind are free. */
  available: boolean | null
}

declare module 'claude-code' {
  interface PluginState {
    'surf-workspace': {
      workspaces: Workspace[]
      /** Last fetch or action error, shown in the status line and pane. */
      error: string | null
      /** Epoch ms of the last successful fetch. */
      updatedAt: number | null
      /** Workspace id with an action in flight. */
      busy: string | null
      /** Workspace id waiting for the pause confirmation. */
      confirm: string | null
      /** Epoch ms per workspace id since it was first seen resuming. */
      resumingSince: Record<string, number>
      /** GPU flavours of the catalog item with their availability. */
      flavours: GpuFlavour[]
      /** Why the availability check failed, if it did. */
      flavoursError: string | null
    }
  }
}
