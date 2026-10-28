import { useSession } from '../hooks/useSession'
import { play, setLoop, setSongInfo, setVolume, stop } from '../state/actions'
import { session } from '../state/session'
import { useUi } from '../state/ui'
import { NumberField } from './Controls'
import { DreamcastDspControls } from './DreamcastDspControls'
import { Ps1ReverbControls } from './Ps1ReverbControls'
import { SnesEchoControls } from './SnesEchoControls'

function clock(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
}

/** Transport bar: play/stop/loop, BPM and speed, position, octave and current instrument. */
export function Transport() {
  useSession()
  const playhead = useUi((s) => s.playhead)
  const loop = useUi((s) => s.loop)
  const follow = useUi((s) => s.follow)
  const volume = useUi((s) => s.volume)
  const editStep = useUi((s) => s.editStep)
  const set = useUi((s) => s.set)
  const song = session.song
  const t = song.timing
  const shown = playhead.playing ? playhead : { order: session.cursor.order, row: session.cursor.row, seconds: 0 }
  return (
    <div className="transport" data-testid="transport-bar">
      <div className="group">
        <button className={playhead.playing ? 'active' : ''} onClick={() => void play('cursor')} title="Play from the cursor (Space)" data-testid="btn-play">
          Play
        </button>
        <button onClick={() => void play('start')} title="Play from the start" data-testid="btn-play-start">
          From start
        </button>
        <button onClick={stop} disabled={!playhead.playing} title="Stop (Space)" data-testid="btn-stop">
          Stop
        </button>
        <button className={loop ? 'active' : ''} onClick={() => setLoop(!loop)} aria-pressed={loop} title="Loop at the song's loop point" data-testid="btn-loop">
          Loop
        </button>
        <button className={follow ? 'active' : ''} onClick={() => set({ follow: !follow })} aria-pressed={follow} title="Follow the playhead" data-testid="btn-follow">
          Follow
        </button>
      </div>
      <div className="sep" />
      <div className="group">
        <span className="label">BPM</span>
        <NumberField value={t.bpm} min={20} max={400} onCommit={(v) => setSongInfo({ bpm: v }, 'Set BPM')} testId="field-bpm" title="Tempo (20..400)" />
        <span className="label">Speed</span>
        <NumberField value={t.speed} min={1} max={31} onCommit={(v) => setSongInfo({ speed: v }, 'Set speed')} testId="field-speed" title="Ticks per row (1..31)" />
        <span className="label">Rows/beat</span>
        <NumberField value={t.rowsPerBeat} min={1} max={16} onCommit={(v) => setSongInfo({ rowsPerBeat: v }, 'Set rows per beat')} testId="field-rpb" />
      </div>
      <div className="sep" />
      <div className="readout mono" data-testid="position">
        <span className="label">Pos</span> {String(shown.order).padStart(2, '0')}:{String(shown.row).padStart(2, '0')} {clock(shown.seconds)}
      </div>
      <div className="sep" />
      <div className="group">
        <span className="label">Octave</span>
        <button onClick={() => session.setOctave(session.octave - 1)} title="Octave down (numpad -)">-</button>
        <span className="readout mono" data-testid="octave">{session.octave}</span>
        <button onClick={() => session.setOctave(session.octave + 1)} title="Octave up (numpad +)">+</button>
        <span className="label">Inst</span>
        <select value={session.currentInstrument} onChange={(e) => session.setCurrentInstrument(Number(e.target.value))} data-testid="current-instrument" title="Instrument used for note entry">
          {song.instruments.length === 0 && <option value={-1}>(none)</option>}
          {song.instruments.map((inst, i) => (
            <option key={i} value={i}>
              {i.toString(16).toUpperCase().padStart(2, '0')} {inst.name}
            </option>
          ))}
        </select>
        <span className="label">Step</span>
        <NumberField value={editStep} min={0} max={16} onCommit={(v) => set({ editStep: v })} width={34} title="Rows to move down after an entry" />
      </div>
      {song.chip === 'snes' && <div className="sep" />}
      {song.chip === 'snes' && <SnesEchoControls />}
      {song.chip === 'ps1' && <div className="sep" />}
      {song.chip === 'ps1' && <Ps1ReverbControls />}
      {song.chip === 'dreamcast' && <div className="sep" />}
      {song.chip === 'dreamcast' && <DreamcastDspControls />}
      <span className="spacer" />
      <div className="group">
        <span className="label">Vol</span>
        <input type="range" min={0} max={1.5} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Master volume" />
      </div>
    </div>
  )
}
