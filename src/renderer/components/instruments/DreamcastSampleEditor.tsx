import { useMemo } from 'react'
import { type AicaAeg, type AicaFilter, type AicaLfo, type AicaLfoWave, type AicaSampleInstrument, type Instrument, aicaTargetFor, resolveSampleSlot } from '../../../core'
import { aicaAegTimes, aicaDecayLevel, aicaEnvelopeCurve } from '../../lib/aicaEnv'
import { formatSeconds } from '../../lib/ps1Env'
import { session } from '../../state/session'
import { NumberField } from '../Controls'
import { MacroSection } from '../InstrumentEditors'
import { CurveGraph, TargetSamplePicker } from './Ps1SampleEditor'
import { RecipeForm } from './SampleEditor'

type Commit = (next: Instrument, label?: string) => void

const FORMATS: { id: AicaSampleInstrument['format']; label: string; unit: string }[] = [
  { id: 'pcm16', label: 'PCM 16-bit (clean, 2 bytes per sample)', unit: 'PCM16' },
  { id: 'pcm8', label: 'PCM 8-bit (1 byte per sample)', unit: 'PCM8' },
  { id: 'adpcm', label: 'ADPCM 4-bit (0.5 byte per sample)', unit: 'ADPCM' }
]
const LFO_WAVES: AicaLfoWave[] = ['saw', 'square', 'tri', 'noise']

/** A starting filter: a closed-ish start that opens over the attack and settles (the usual brass / bass sweep). */
const DEFAULT_FILTER: AicaFilter = { q: 6, flv: [1500, 8191, 5000, 4000, 2000], far: 22, fd1r: 14, fd2r: 0, frr: 16 }
const DEFAULT_LFO: AicaLfo = { freq: 12, pitchWave: 'tri', pitchDepth: 1, ampWave: 'tri', ampDepth: 0, reset: true }
const FLV_LABELS = ['FLV0', 'FLV1', 'FLV2', 'FLV3', 'FLV4']
const FLV_TITLES = ['Cutoff at key-on', 'Cutoff after the attack (FAR)', 'Cutoff after decay 1 (FD1R)', 'Cutoff after decay 2 (FD2R)', 'Cutoff at the key-off (FRR)']

/** Editor for `aica-sample` instruments: sample and format, AEG with readable times and a graph, send, filter, LFO and macros. */
export function DreamcastSampleEditor(props: { inst: AicaSampleInstrument; commit: Commit }) {
  const { inst, commit } = props
  const aeg = inst.aeg
  const setAeg = (patch: Partial<AicaAeg>, label = 'Edit envelope'): void => commit({ ...inst, aeg: { ...aeg, ...patch } }, label)
  const times = useMemo(() => aicaAegTimes(aeg), [aeg])
  const curve = useMemo(() => aicaEnvelopeCurve(aeg, { holdSec: 1, releaseSec: 0.4, points: 220 }), [aeg])
  const fmt = FORMATS.find((f) => f.id === inst.format) ?? FORMATS[0]!
  const target = aicaTargetFor(inst.format)
  const f = inst.filter
  const lfo = inst.lfo
  const setFilter = (patch: Partial<AicaFilter>, label = 'Edit filter'): void => {
    if (f) commit({ ...inst, filter: { ...f, ...patch } }, label)
  }
  const setLfo = (patch: Partial<AicaLfo>, label = 'Edit LFO'): void => {
    if (lfo) commit({ ...inst, lfo: { ...lfo, ...patch } }, label)
  }
  const level = aicaDecayLevel(aeg)
  return (
    <div className="editor-block" data-testid="dc-editor">
      <TargetSamplePicker value={inst.sample} onPick={(id) => commit({ ...inst, sample: id }, 'Pick sample')} target={target} unit={fmt.unit} />
      <RecipeForm
        onGenerated={(slot) => {
          let baseNote = inst.baseNote
          try {
            baseNote = resolveSampleSlot(session.song, slot.id, target)?.baseNote ?? baseNote
          } catch {
            // keep the old base note
          }
          commit({ ...inst, sample: slot.id, baseNote }, 'Generate sample')
        }}
      />
      <div className="group wrap">
        <span className="label">Format</span>
        <select value={inst.format} onChange={(e) => commit({ ...inst, format: e.target.value as AicaSampleInstrument['format'] }, 'Set sample format')} data-testid="dc-format" title="How the sample is stored in AICA RAM">
          {FORMATS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="group wrap">
        <span className="label">Base note</span>
        <NumberField value={inst.baseNote} min={0} max={127} onCommit={(v) => commit({ ...inst, baseNote: v }, 'Set base note')} width={40} title="MIDI note at which the sample plays at its native rate (60 = C-4)" testId="dc-base-note" />
        <span className="label">Fine</span>
        <NumberField value={inst.fine ?? 0} min={-100} max={100} onCommit={(v) => commit({ ...inst, fine: v }, 'Set fine tune')} width={44} title="Fine tune in cents" testId="dc-fine" />
        <span className="label">Send</span>
        <NumberField value={inst.send} min={0} max={15} onCommit={(v) => commit({ ...inst, send: v }, 'Set DSP send')} width={30} title="Send level to the DSP effect 0..15 (0 = dry; Exx on a cell switches it on or off)" testId="dc-send" />
      </div>
      <div className="group wrap">
        <span className="label">AR</span>
        <NumberField value={aeg.ar} min={0} max={31} onCommit={(v) => setAeg({ ar: v })} width={30} title="Attack rate 0..31 (31 = fastest, 0 = never attacks)" testId="dc-aeg-ar" />
        <span className="label">D1R</span>
        <NumberField value={aeg.d1r} min={0} max={31} onCommit={(v) => setAeg({ d1r: v })} width={30} title="Decay 1 rate 0..31: the fall from full level to DL (0 = holds)" testId="dc-aeg-d1r" />
        <span className="label">DL</span>
        <NumberField value={aeg.dl} min={0} max={31} onCommit={(v) => setAeg({ dl: v })} width={30} title="Decay level 0..31 in 3 dB steps (0 = full level, no decay 1)" testId="dc-aeg-dl" />
        <span className="label">D2R</span>
        <NumberField value={aeg.d2r} min={0} max={31} onCommit={(v) => setAeg({ d2r: v })} width={30} title="Decay 2 rate 0..31: the fall after DL while the key is held (0 = holds)" testId="dc-aeg-d2r" />
        <span className="label">RR</span>
        <NumberField value={aeg.rr} min={0} max={31} onCommit={(v) => setAeg({ rr: v })} width={30} title="Release rate 0..31 (31 = fastest)" testId="dc-aeg-rr" />
        <span className="label">KRS</span>
        <NumberField
          value={aeg.krs ?? 0}
          min={0}
          max={15}
          onCommit={(v) => {
            const next = { ...aeg }
            if (v > 0) next.krs = v
            else delete next.krs
            commit({ ...inst, aeg: next }, 'Set key rate scaling')
          }}
          width={30}
          title="Key rate scaling 0..15: higher notes get faster envelopes (0 = off)"
          testId="dc-aeg-krs"
        />
      </div>
      <span className="hint" data-testid="dc-times">
        attack {formatSeconds(times.attackSec)}, decay to {Math.round(level * 100)}% in {formatSeconds(times.decay1Sec)}, release {formatSeconds(times.releaseSec)} (approximate)
      </span>
      <CurveGraph curve={curve} testId="dc-env-graph" />

      <div className="group wrap">
        <label className="check" title="Per-slot resonant low-pass filter with its own envelope">
          <input
            type="checkbox"
            checked={!!f}
            onChange={(e) => {
              const next = { ...inst }
              if (e.target.checked) next.filter = { ...DEFAULT_FILTER, flv: [...DEFAULT_FILTER.flv] }
              else delete next.filter
              commit(next, 'Toggle filter')
            }}
            data-testid="dc-filter-on"
          />
          Filter (low-pass with envelope)
        </label>
      </div>
      {f && (
        <>
          <div className="group wrap" data-testid="dc-filter">
            <span className="label">Q</span>
            <NumberField value={f.q} min={0} max={31} onCommit={(v) => setFilter({ q: v })} width={30} title="Resonance 0..31" testId="dc-filter-q" />
            {FLV_LABELS.map((name, i) => (
              <span key={name} className="group">
                <span className="label">{name}</span>
                <NumberField
                  value={f.flv[i]!}
                  min={0}
                  max={8191}
                  onCommit={(v) => {
                    const flv = [...f.flv] as AicaFilter['flv']
                    flv[i] = v
                    setFilter({ flv })
                  }}
                  width={48}
                  title={`${FLV_TITLES[i]}, 0..8191 (8191 = open)`}
                  testId={`dc-filter-flv${i}`}
                />
              </span>
            ))}
          </div>
          <div className="group wrap">
            <span className="label">FAR</span>
            <NumberField value={f.far} min={0} max={31} onCommit={(v) => setFilter({ far: v })} width={30} title="Filter attack rate 0..31 (FLV0 to FLV1)" testId="dc-filter-far" />
            <span className="label">FD1R</span>
            <NumberField value={f.fd1r} min={0} max={31} onCommit={(v) => setFilter({ fd1r: v })} width={30} title="Filter decay 1 rate 0..31 (FLV1 to FLV2)" testId="dc-filter-fd1r" />
            <span className="label">FD2R</span>
            <NumberField value={f.fd2r} min={0} max={31} onCommit={(v) => setFilter({ fd2r: v })} width={30} title="Filter decay 2 rate 0..31 (FLV2 to FLV3)" testId="dc-filter-fd2r" />
            <span className="label">FRR</span>
            <NumberField value={f.frr} min={0} max={31} onCommit={(v) => setFilter({ frr: v })} width={30} title="Filter release rate 0..31 (to FLV4)" testId="dc-filter-frr" />
          </div>
        </>
      )}

      <div className="group wrap">
        <label className="check" title="Low-frequency oscillator for vibrato (pitch) and tremolo (amplitude)">
          <input
            type="checkbox"
            checked={!!lfo}
            onChange={(e) => {
              const next = { ...inst }
              if (e.target.checked) next.lfo = { ...DEFAULT_LFO }
              else delete next.lfo
              commit(next, 'Toggle LFO')
            }}
            data-testid="dc-lfo-on"
          />
          LFO (vibrato / tremolo)
        </label>
      </div>
      {lfo && (
        <div className="group wrap" data-testid="dc-lfo">
          <span className="label">Freq</span>
          <NumberField value={lfo.freq} min={0} max={31} onCommit={(v) => setLfo({ freq: v })} width={30} title="LFO frequency 0..31 (0 = slowest, about 0.2 Hz; 31 = fastest, about 170 Hz)" testId="dc-lfo-freq" />
          <span className="label">Pitch</span>
          <select value={lfo.pitchWave} onChange={(e) => setLfo({ pitchWave: e.target.value as AicaLfoWave }, 'Set vibrato wave')} title="Vibrato wave" data-testid="dc-lfo-pitch-wave">
            {LFO_WAVES.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <NumberField value={lfo.pitchDepth} min={0} max={7} onCommit={(v) => setLfo({ pitchDepth: v })} width={30} title="Vibrato depth 0..7 (0 = off)" testId="dc-lfo-pitch-depth" />
          <span className="label">Amp</span>
          <select value={lfo.ampWave} onChange={(e) => setLfo({ ampWave: e.target.value as AicaLfoWave }, 'Set tremolo wave')} title="Tremolo wave" data-testid="dc-lfo-amp-wave">
            {LFO_WAVES.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <NumberField value={lfo.ampDepth} min={0} max={7} onCommit={(v) => setLfo({ ampDepth: v })} width={30} title="Tremolo depth 0..7 (0 = off)" testId="dc-lfo-amp-depth" />
          <label className="check" title="Restart the LFO on every note">
            <input type="checkbox" checked={lfo.reset} onChange={(e) => setLfo({ reset: e.target.checked }, 'Toggle LFO reset')} data-testid="dc-lfo-reset" />
            reset on note
          </label>
        </div>
      )}
      <MacroSection inst={inst} commit={commit} />
    </div>
  )
}
