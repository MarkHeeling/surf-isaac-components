export type Workspace = {
  id: string
  /** Host name ("markisaacsim"), else the portal name. */
  name: string
  /** Lower-case SURF status: running, paused, resuming, pausing, failed, ... */
  status: string
  /** Size flavour, e.g. "A10 - 2 GPU". */
  flavour?: string
  /** SURF's error text when the newest action (e.g. a resume) failed. */
  failure?: string
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
      /** Workspace id with an action in flight. */
      busy: string | null
      /** Workspace id waiting for the stop confirmation. */
      confirm: string | null
      /** GPU flavours of the catalog item with their availability. */
      flavours: GpuFlavour[]
    }
  }
}
