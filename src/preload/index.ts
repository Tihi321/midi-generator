import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ChiptuneStudioApi } from '../shared/ipc'

const api: ChiptuneStudioApi = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on(channel, callback) {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('chiptuneStudio', api)
