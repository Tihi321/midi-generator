import { useCallback, useEffect, useRef, useState } from 'react'
import { ASSETS_IPC } from '../../shared/assets'
import type { AssetMeta } from '../../tools'
import { uiServices } from '../lib/tools'

export interface AssetsState {
  assets: AssetMeta[]
  /** Object URLs of the thumbnails by asset id. */
  thumbs: Record<string, string>
  loading: boolean
  error: string
  reload: () => void
}

/** The asset library with thumbnails; refreshes live when main reports `assets:changed`. */
export function useAssets(): AssetsState {
  const [assets, setAssets] = useState<AssetMeta[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const urls = useRef<string[]>([])
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const svc = uiServices().assets
      if (!svc) throw new Error('The asset library is not available.')
      const list = await svc.list()
      const next: Record<string, string> = {}
      const fresh: string[] = []
      await Promise.all(
        list.map(async (a) => {
          try {
            const bytes = await svc.thumbnail(a.id)
            if (bytes) {
              const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
              next[a.id] = url
              fresh.push(url)
            }
          } catch {
            /* no thumbnail: the card shows a placeholder */
          }
        })
      )
      if (mine !== seq.current) {
        for (const u of fresh) URL.revokeObjectURL(u)
        return
      }
      for (const u of urls.current) URL.revokeObjectURL(u)
      urls.current = fresh
      setAssets(list)
      setThumbs(next)
      setError('')
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const off = window.chiptuneStudio?.on(ASSETS_IPC.changed, () => void load())
    return () => {
      off?.()
      seq.current++
      for (const u of urls.current) URL.revokeObjectURL(u)
      urls.current = []
    }
  }, [load])

  return { assets, thumbs, loading, error, reload: () => void load() }
}
