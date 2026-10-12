import { useMemo, useState } from 'react'
import { ASSET_KINDS } from '../../shared/assets'
import { CHIP_IDS } from '../../core'
import type { AssetKind, AssetMeta } from '../../tools'
import { useAssets } from '../hooks/useAssets'
import { useSession } from '../hooks/useSession'
import { assetMatches } from '../lib/assetForm'
import { deleteAsset, openSaveAsset, openSongAsset, placeAsset, setReference } from '../state/assetActions'
import { session } from '../state/session'

function primaryAction(asset: AssetMeta): { label: string; title: string } {
  if (asset.kind === 'motif') return { label: 'Place at cursor', title: 'Write the motif at the cursor, transposed to the song key (one undo step)' }
  if (asset.kind === 'instrument') return { label: 'Add instrument', title: 'Add the instrument (or its role on this chip) to the song' }
  return { label: 'Open song', title: 'Open the song as the current song (undo brings the old one back)' }
}

function AssetCard({ asset, thumb, isRef, onDelete }: { asset: AssetMeta; thumb?: string; isRef: boolean; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const act = primaryAction(asset)
  return (
    <div className="asset-card" data-testid="asset-card" data-asset-id={asset.id}>
      <div className="asset-thumb">{thumb ? <img src={thumb} alt={asset.name} draggable={false} /> : <span className="hint">no preview</span>}</div>
      <div className="asset-info">
        <div className="asset-name" title={asset.name}>
          {asset.name}
        </div>
        <div className="asset-meta">
          <span className="badge">{asset.kind}</span>
          <span>{asset.chip.toUpperCase()}</span>
          <span>
            {asset.key} {asset.scale}
          </span>
          <span>{asset.bpm} BPM</span>
        </div>
        {(asset.tags.length > 0 || asset.moods.length > 0) && <div className="asset-tags">{[...asset.moods, ...asset.tags.map((t) => `#${t}`)].join(' ')}</div>}
        {asset.notes && (
          <div className="asset-notes" title={asset.notes}>
            {asset.notes}
          </div>
        )}
        <div className="asset-actions">
          <button title={act.title} onClick={() => (asset.kind === 'song' ? void openSongAsset(asset) : void placeAsset(asset))} data-testid="asset-place">
            {act.label}
          </button>
          <label className="asset-ref" title="Use this asset as a style reference for the song and the agent">
            <input type="checkbox" checked={isRef} onChange={(e) => void setReference(asset.id, e.target.checked)} data-testid="asset-ref" />
            Style ref
          </label>
          {confirming ? (
            <span className="asset-confirm">
              Delete?{' '}
              <button
                className="danger"
                onClick={() => {
                  setConfirming(false)
                  onDelete(asset.id)
                }}
                data-testid="asset-delete-yes"
              >
                Yes
              </button>{' '}
              <button onClick={() => setConfirming(false)} data-testid="asset-delete-no">
                No
              </button>
            </span>
          ) : (
            <button title="Delete this asset from the library" onClick={() => setConfirming(true)} data-testid="asset-delete">
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** The Library tab: songs, motifs and instruments saved on disk, with style references. */
export function LibraryPanel() {
  useSession()
  const { assets, thumbs, loading, error, reload } = useAssets()
  const [kind, setKind] = useState<AssetKind | ''>('')
  const [chip, setChip] = useState('')
  const [query, setQuery] = useState('')
  const refs = new Set(session.song.references.map((r) => r.assetId))
  const shown = useMemo(() => assets.filter((a) => assetMatches(a, kind, chip, query)), [assets, kind, chip, query])

  const remove = async (id: string): Promise<void> => {
    await deleteAsset(id)
    reload()
  }

  return (
    <section className="library" data-testid="assets-panel">
      <header className="library-head">
        <span className="label">Library</span>
        <span className="spacer" />
        <button title="Save a song, motif or instrument in the library" onClick={() => openSaveAsset()} data-testid="asset-save-open">
          Save to library...
        </button>
      </header>
      <div className="asset-filters">
        <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind | '')} aria-label="Kind" data-testid="asset-kind">
          <option value="">All kinds</option>
          {ASSET_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={chip} onChange={(e) => setChip(e.target.value)} aria-label="Chip" data-testid="asset-chip">
          <option value="">All chips</option>
          {CHIP_IDS.map((c) => (
            <option key={c} value={c}>
              {c.toUpperCase()}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Search name, tag or mood" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="asset-search" />
      </div>
      {error && <p className="error">{error}</p>}
      {!error && loading && <p className="hint">Loading...</p>}
      {!error && !loading && assets.length === 0 && (
        <p className="hint" data-testid="asset-empty">
          The library is empty. Compose something and use &quot;Save to library...&quot;.
        </p>
      )}
      {!error && assets.length > 0 && shown.length === 0 && <p className="hint">No asset matches the filter.</p>}
      <div className="asset-grid" data-testid="asset-grid">
        {shown.map((a) => (
          <AssetCard key={a.id} asset={a} thumb={thumbs[a.id]} isRef={refs.has(a.id)} onDelete={(id) => void remove(id)} />
        ))}
      </div>
    </section>
  )
}
