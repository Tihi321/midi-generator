// IPC channel names for the asset library (renderer <-> main). Free of DOM and Electron imports.

export const ASSETS_IPC = {
  // renderer -> main (invoke / handle)
  list: 'assets:list',
  get: 'assets:get',
  save: 'assets:save',
  delete: 'assets:delete',
  thumbnail: 'assets:thumbnail',
  // main -> renderer (webContents.send): the library folder changed (payload: none)
  changed: 'assets:changed'
} as const

export const ASSET_KINDS = ['song', 'motif', 'instrument'] as const
