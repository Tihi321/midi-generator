// Electron glue for the asset library: registers the assets:* IPC handlers and pushes `assets:changed`
// to the windows when the library folder changes. Kept out of index.ts so that file only gets one call.
import { app, BrowserWindow, ipcMain } from 'electron'
import { AssetStore, registerAssetIpc } from './assets'
import { ASSETS_IPC } from '../shared/assets'

export function startAssets(): AssetStore {
  const store = new AssetStore()
  const push = (): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ASSETS_IPC.changed)
  }
  registerAssetIpc(ipcMain, store, push)
  let stopWatching: (() => Promise<void>) | null = null
  void store
    .watch(push)
    .then((stop) => {
      stopWatching = stop
    })
    .catch((e: unknown) => console.warn(`[assets] cannot watch ${store.root}: ${e instanceof Error ? e.message : String(e)}`))
  app.on('before-quit', () => void stopWatching?.())
  return store
}
