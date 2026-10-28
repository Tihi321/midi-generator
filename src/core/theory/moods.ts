// Mood recipes: one per game-music mood. Data only: the LLM reads these to plan a track.

import type { ChipId, PitchClass, Role, ScaleId } from '../types'
import { CHIP_IDS } from '../types'
import { DRUM_STYLES } from './drums'
import { PROGRESSIONS } from './progressions'

export interface MoodArrangement {
  sections: { name: string; bars: number }[]
  totalBars: number
  /** Section the song loops back to; null = jingle (plays once). */
  loopFrom: string | null
}

export interface ChannelPlan {
  channel: string
  role: Role
  /** What this channel plays in the arrangement. */
  part: string
}

export interface MoodRecipe {
  id: string
  name: string
  description: string
  bpm: [number, number]
  bpmDefault: number
  keys: PitchClass[]
  scales: ScaleId[]
  /** Progression ids from progressions.ts that carry this mood. */
  progressions: string[]
  /** Drum style ids from drums.ts that carry this mood. */
  drumStyles: string[]
  /** Alternating ticks per row (swing), e.g. [7, 5]; absent = straight. */
  groove?: number[]
  parts: { lead: Role; harmony: Role; pad: Role; bass: Role }
  arrangement: MoodArrangement
  /** Composition advice specific to the mood. */
  techniques: string[]
  /** Chip-specific channel plans and idioms. */
  chips: Record<ChipId, { channels: ChannelPlan[]; idioms: string[] }>
  /** Rows per bar and recommended pattern length (64 rows = 4 bars at 4/4, 4 rows per beat). */
  rowsPerBar: number
  patternLength: number
}

interface MoodSeed {
  id: string
  name: string
  description: string
  bpm: [number, number]
  keys: PitchClass[]
  scales: ScaleId[]
  groove?: number[]
  lead: Role
  harmony: Role
  pad: Role
  bass?: Role
  sections: [string, number][]
  loopFrom: string | null
  techniques: string[]
}

const SEEDS: MoodSeed[] = [
  {
    id: 'heroic', name: 'Heroic', description: 'Bold, uplifting adventure theme with a confident melody and driving rhythm.',
    bpm: [112, 140], keys: ['C', 'D', 'G', 'F'], scales: ['major', 'mixolydian', 'minor'], lead: 'brass', harmony: 'arp', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['Bridge', 4]], loopFrom: 'A',
    techniques: [
      'Melody leaps up a fourth or fifth on the downbeat, then steps down; use dotted rhythms (E5:3 D5 C5:4).',
      'Bass pedals on the tonic or walks root-fifth in eighths; keep the kick on 1 and 3.',
      'Double the lead an octave lower on the second voice during the B section for weight.',
      'Finish phrases on a long note over the V chord, resolve on the next phrase.'
    ]
  },
  {
    id: 'battle', name: 'Battle', description: 'Fast, aggressive and relentless: minor ostinatos, galloping bass, constant drums.',
    bpm: [150, 180], keys: ['A', 'E', 'D', 'F#'], scales: ['minor', 'harmonic-minor', 'minor-pentatonic'], lead: 'lead', harmony: 'arp', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['B', 8]], loopFrom: 'A',
    techniques: [
      'Bass plays running eighth or sixteenth notes on the root with octave jumps.',
      'Arpeggiate chords fast (speed 3-4) on the second melodic voice with 0xy.',
      'Lead uses minor-pentatonic runs with quick repeated notes; end phrases with a tritone or minor-second pull.',
      'Keep drums busy: kick gallop, snare backbeat, hat on every step; crash at each section start.'
    ]
  },
  {
    id: 'boss', name: 'Boss fight', description: 'Heavy and ominous: slower power, chromatic pressure, big hits.',
    bpm: [140, 175], keys: ['D', 'E', 'C#', 'F#'], scales: ['phrygian', 'harmonic-minor', 'minor'], lead: 'brass', harmony: 'arp', pad: 'organ',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['Climax', 8]], loopFrom: 'A',
    techniques: [
      'Use a low, repeating bass riff (sixteenths on the root, jumping the b2) that never stops.',
      'Stab chords on beats 1 and the "and" of 2 with a short, loud instrument; leave space after.',
      'Lead melody in long threatening notes that climb by minor seconds, then a fast run.',
      'Use the harmonic-minor V (major) at the end of each 4-bar phrase to build tension.'
    ]
  },
  {
    id: 'spooky', name: 'Spooky', description: 'Eerie and sparse: chromatic creeping, odd intervals, silence.',
    bpm: [60, 90], keys: ['A', 'E', 'C#', 'G#'], scales: ['phrygian', 'locrian', 'harmonic-minor', 'whole-tone'], lead: 'bell', harmony: 'pad', pad: 'choir',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Melody on a bell or music-box timbre using the b2 and tritone; leave rests of 1-2 beats between phrases.',
      'Bass moves in slow semitone pairs (root and b2) or a heartbeat pattern.',
      'Add a high, sparse note an octave or two above the lead for a ghostly shimmer.',
      'Vibrato (4xy) and slow volume swells on the pad make it breathe.'
    ]
  },
  {
    id: 'dungeon', name: 'Dungeon', description: 'Dark, patient, tension-filled exploration.',
    bpm: [60, 100], keys: ['D', 'A', 'F', 'C'], scales: ['minor', 'phrygian', 'locrian'], lead: 'flute', harmony: 'pad', pad: 'organ',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Low bass drone on the tonic with an occasional minor-second slip.',
      'Sparse melody in short motifs repeated with small changes; echo it a beat later on the second voice.',
      'Keep drums to kick and toms (or none) for a slow pulse; avoid hats.',
      'Use a dissonant sustained note (b2 or b5) over the pad for dread.'
    ]
  },
  {
    id: 'chill', name: 'Chill', description: 'Relaxed, warm and lo-fi: seventh chords, gentle swing, soft sounds.',
    bpm: [70, 100], keys: ['F', 'C', 'G', 'D#'], scales: ['major', 'dorian', 'major-pentatonic', 'lydian'], groove: [7, 5], lead: 'pluck', harmony: 'pad', pad: 'organ',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Use seventh chords and gentle swing (groove 7/5 ticks).',
      'Melody is sparse and syncopated, mostly stepwise with long notes; avoid fast runs.',
      'Bass plays root and fifth on beats 1 and 3, walking notes only at phrase ends.',
      'Keep drums quiet: kick and snare with soft hats; lower hat volume (v6).'
    ]
  },
  {
    id: 'town', name: 'Town', description: 'Friendly, bouncy and cozy village music.',
    bpm: [100, 125], keys: ['C', 'G', 'F', 'D'], scales: ['major', 'major-pentatonic', 'mixolydian'], lead: 'flute', harmony: 'pluck', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Bass alternates root and fifth ("oom-pah") on quarter notes.',
      'Melody in simple stepwise phrases that answer each other (call and response).',
      'Pluck on the offbeats (chord stabs) gives the bounce.',
      'Stay in the major pentatonic for safe, cheerful melodies.'
    ]
  },
  {
    id: 'overworld', name: 'Overworld', description: 'Open, adventurous travel music with a memorable, singable theme.',
    bpm: [110, 140], keys: ['C', 'G', 'D', 'A'], scales: ['major', 'mixolydian', 'dorian', 'lydian'], lead: 'lead', harmony: 'arp', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['C', 8]], loopFrom: 'A',
    techniques: [
      'Write a theme of 2 bars and repeat it with a changed ending (question and answer).',
      'Bass walks in eighths with the root on downbeats; kick and snare keep a steady march.',
      'Arpeggiated chords underneath carry the harmony; change the chord every bar.',
      'Section B goes to the relative minor or a IV chord for contrast.'
    ]
  },
  {
    id: 'victory', name: 'Victory', description: 'Short triumphant fanfare that plays once.',
    bpm: [120, 160], keys: ['C', 'F', 'G', 'A#'], scales: ['major', 'mixolydian'], lead: 'brass', harmony: 'arp', pad: 'strings',
    sections: [['Fanfare', 4], ['Resolve', 4]], loopFrom: null,
    techniques: [
      'Open with a rising triad figure in triplets-feel (even eighths); land on a held tonic.',
      'Use I - IV - V - I with a bVI-bVII-I lift for the finale.',
      'Crash on beat 1; snare roll in the last half bar.',
      'Set no loop (set_loop null): it is a jingle.'
    ]
  },
  {
    id: 'game-over', name: 'Game over', description: 'Slow, sad descending jingle that plays once.',
    bpm: [50, 80], keys: ['D', 'A', 'E', 'C'], scales: ['minor', 'harmonic-minor', 'phrygian'], lead: 'flute', harmony: 'pad', pad: 'strings',
    sections: [['Jingle', 8]], loopFrom: null,
    techniques: [
      'Descend stepwise by a fifth or octave over 2-3 bars, ending on the tonic or the V.',
      'Use a long final note with release and no drums, or a single soft kick.',
      'Chord movement i - bVI - iv - i; keep everything slow.',
      'Set no loop (set_loop null).'
    ]
  },
  {
    id: 'title', name: 'Title screen', description: 'Memorable, grand and inviting theme that sets the tone of the game.',
    bpm: [80, 120], keys: ['C', 'D', 'F', 'A'], scales: ['major', 'lydian', 'minor'], lead: 'strings', harmony: 'arp', pad: 'pad',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'State the main theme early and clearly; it should be hummable after one listen.',
      'Slow harmonic rhythm: one chord per bar, with arpeggios in the background.',
      'Build in layers: bass and pad first, then lead, then drums at the second A.',
      'Use a bell or pluck high above the lead for sparkle.'
    ]
  },
  {
    id: 'shop', name: 'Shop', description: 'Smooth, jazzy and friendly: seventh chords with a light swing.',
    bpm: [90, 120], keys: ['F', 'A#', 'C', 'D#'], scales: ['major', 'dorian', 'major-pentatonic'], groove: [7, 5], lead: 'pluck', harmony: 'organ', pad: 'pad',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'ii-V-I turnarounds with sevenths; play the chords on the offbeats.',
      'Walking bass in quarters, passing notes on beat 4.',
      'Syncopated melody that starts on the "and" of 1; keep it short and tuneful.',
      'Swing feel (groove 7/5) with bossa or lo-fi drums.'
    ]
  },
  {
    id: 'underwater', name: 'Underwater', description: 'Floating, flowing and dreamy with slow movement.',
    bpm: [60, 90], keys: ['E', 'B', 'F#', 'A'], scales: ['lydian', 'whole-tone', 'dorian', 'major-pentatonic'], lead: 'bell', harmony: 'pad', pad: 'choir',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Slow arpeggios up and down (eighth-note 0xy waves) as the base layer.',
      'Melody floats in long notes with vibrato; avoid strong downbeats.',
      'Use lydian (raised 4th) or whole-tone for a dreamy, unresolved color.',
      'Soft, rare drums (heartbeat kick, a hat now and then).'
    ]
  },
  {
    id: 'desert', name: 'Desert', description: 'Exotic and sun-baked, with a snake-charmer melody and hand drums.',
    bpm: [90, 120], keys: ['D', 'E', 'A', 'G'], scales: ['phrygian-dominant', 'harmonic-minor'], lead: 'flute', harmony: 'pluck', pad: 'organ',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Use phrygian dominant: the b2 and major 3rd sit a step apart and create the exotic sound.',
      'Melody ornaments with quick upper neighbours (grace notes as 1-row notes); long held tonic.',
      'Drone bass on the tonic and fifth; drums as kick and toms (darbuka).',
      'Add a plucked counter-line in parallel thirds-ish above.'
    ]
  },
  {
    id: 'castle', name: 'Castle', description: 'Stately, gothic and dramatic with organ-like voices and baroque motion.',
    bpm: [80, 120], keys: ['D', 'A', 'E', 'C'], scales: ['harmonic-minor', 'minor', 'dorian'], lead: 'organ', harmony: 'arp', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Use harmonic minor, and make the V chord major for a dramatic cadence.',
      'Baroque sequences: repeat a short motif a step lower each bar.',
      'Arpeggios in eighth notes underneath, a slow bass walking by step.',
      'March-like drums: kick on 1 and 3, a snare lift on beat 4.'
    ]
  },
  {
    id: 'sad', name: 'Sad', description: 'Melancholic, slow and heartfelt.',
    bpm: [55, 85], keys: ['A', 'D', 'E', 'C'], scales: ['minor', 'dorian', 'harmonic-minor'], lead: 'flute', harmony: 'pad', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8]], loopFrom: 'A',
    techniques: [
      'Long descending melody lines with a sighing step down to the tonic.',
      'Use the axis or lament progressions; arpeggiate gently on the second voice.',
      'Keep drums to a soft kick, or none at all.',
      'A high bell or pluck at phrase ends adds a tear-drop sparkle.'
    ]
  },
  {
    id: 'ambient', name: 'Ambient', description: 'Very calm, spacious background music: slow pads, long soft notes, no drums.',
    bpm: [60, 76], keys: ['C', 'D', 'F', 'A'], scales: ['lydian', 'major-pentatonic', 'dorian', 'major'], lead: 'bell', harmony: 'pad', pad: 'strings',
    sections: [['A', 8], ['B', 8]], loopFrom: 'A',
    techniques: [
      'Change the chord only every two bars and let the notes ring into each other.',
      'Melody is a few long notes with rests between them; mostly stepwise, in the upper register.',
      'Use soft pads and strings with slow attacks; no drums, or a very quiet pulse at most.',
      'End the last bar on a chord that also works as the first, so the loop has no seam.'
    ]
  },
  {
    id: 'lullaby', name: 'Lullaby', description: 'Gentle, rocking and tender, like a bedtime song: simple tune over slow major chords.',
    bpm: [60, 78], keys: ['F', 'C', 'G', 'D'], scales: ['major', 'major-pentatonic'], lead: 'bell', harmony: 'pad', pad: 'strings',
    sections: [['A', 8], ['B', 8]], loopFrom: 'A',
    techniques: [
      'Write a very simple, stepwise tune that repeats with a small change (call and answer).',
      'Rock the bass root and fifth in whole notes; keep chords plain (I, IV, V, vi).',
      'Use a music-box or soft flute lead and a warm pad; no drums.',
      'Finish phrases on a long chord tone and rest before the next one.'
    ]
  },
  {
    id: 'peaceful', name: 'Peaceful', description: 'Warm, safe and unhurried: sunlit meadow or cozy room music with a slow melody.',
    bpm: [66, 88], keys: ['G', 'C', 'D', 'F'], scales: ['major', 'major-pentatonic', 'lydian'], lead: 'flute', harmony: 'pad', pad: 'strings',
    sections: [['A', 8], ['B', 8]], loopFrom: 'A',
    techniques: [
      'Spaced, singable melody in the major pentatonic: half and quarter notes with rests.',
      'Slow chords (one per two bars) with maj7 and add9 colours; arpeggiate softly if the chip has one voice for harmony.',
      'Keep every part soft; use the soft presets; no drums.',
      'Answer a phrase with a lower echo of itself.'
    ]
  },
  {
    id: 'mysterious-calm', name: 'Mysterious calm', description: 'Quiet and curious: unresolved harmony, sparse notes and a faint pulse, but not scary.',
    bpm: [60, 80], keys: ['D', 'A', 'E', 'C'], scales: ['dorian', 'melodic-minor', 'lydian', 'whole-tone'], lead: 'bell', harmony: 'pad', pad: 'choir',
    sections: [['A', 8], ['B', 8]], loopFrom: 'A',
    techniques: [
      'Hover between two chords a step or a fourth apart and avoid strong cadences.',
      'Sparse bell or flute notes with long gaps; occasional leap of a fifth or a seventh.',
      'A very soft, slow kick pulse (or nothing) keeps time without driving.',
      'Pad and choir sounds with slow attacks make the harmony breathe.'
    ]
  },
  // ---- synth moods (MDI-10): default chips are PS1 and Dreamcast; they also work on the other chips
  {
    id: 'synthwave', name: 'Synthwave', description: '80s neon night-drive: detuned saw lead over a plucky 16th arpeggio, straight eighth bass, gated-reverb snare.',
    bpm: [96, 118], keys: ['A', 'E', 'D', 'F#', 'C'], scales: ['minor', 'dorian'], lead: 'lead', harmony: 'arp', pad: 'pad',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['Bridge', 4]], loopFrom: 'A',
    techniques: [
      'Detuned saw lead an octave above the arp; let the notes ring and answer a 2-bar phrase with a variation.',
      'Gated snare on 2 and 4, kick on 1, the "and" of 2 and 3, eighth-note hats, a crash on the first bar of each phrase.',
      'Sidechain feel: pads enter on the off-beat just after the kick, so the volume seems to duck on every kick hit.',
      'Chords i-bVI-bIII-bVII (or i-bVII-bVI-bVII), one chord per bar; the bass keeps straight eighths on the root with an octave on the last one.'
    ]
  },
  {
    id: 'outrun', name: 'Outrun', description: 'Driving chase music: rolling 16th bass, four on the floor, bright brass stabs and a soaring lead.',
    bpm: [108, 118], keys: ['A', 'E', 'F#', 'D'], scales: ['minor', 'phrygian', 'dorian'], lead: 'lead', harmony: 'arp', pad: 'pad',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['B', 8]], loopFrom: 'A',
    techniques: [
      'Rolling sixteenth-note bass on the root with an octave pop; it never stops and keeps the car moving.',
      'Kick on every beat, open hat on the off-beats, snare (gated) on 2 and 4; a tom run fills the last bar of a phrase.',
      'Stab brass on the chord changes (and a push on the last 8th before the next chord); leave space after each stab.',
      'Lead in long, soaring notes that climb to the fifth; double it an octave down with a short delay for the chorus-style width.'
    ]
  },
  {
    id: 'darkwave', name: 'Darkwave', description: 'Cold and brooding: minor and phrygian colour, steady eighth bass, sparse icy arps and a big hall reverb.',
    bpm: [88, 112], keys: ['E', 'A', 'D', 'C#'], scales: ['minor', 'phrygian', 'harmonic-minor'], lead: 'lead', harmony: 'arp', pad: 'strings',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['Bridge', 4]], loopFrom: 'A',
    techniques: [
      'Keep the bass on straight eighths (an FM or analog bass), root only, with the octave on the last eighth.',
      'Sparse, cold arps: soft sixteenths high above the lead; let the pads hold the harmony with a long reverb tail.',
      'Chords i-bII-bVI-bVII or i-bVII-bVI-bVII; use the b2 (phrygian) and the leading tone (harmonic minor) for tension.',
      'Gated snare on 2 and 4 with a pulsing kick; keep hats on the off-beats and leave the fills small.'
    ]
  },
  {
    id: 'dreamwave', name: 'Dreamwave', description: 'Hazy, nostalgic and slow: maj7 colour, lush chorus pads, a half-time beat and a floating lead.',
    bpm: [80, 100], keys: ['F', 'C', 'G', 'D#'], scales: ['dorian', 'minor'], lead: 'lead', harmony: 'arp', pad: 'pad',
    sections: [['Intro', 4], ['A', 8], ['B', 8], ['A', 8], ['Bridge', 4]], loopFrom: 'A',
    techniques: [
      'Slow pads with maj7 and 7th colour (i7, bVImaj7, bIIImaj7, bVII), one chord every two bars, with a big chorus.',
      'Half-time drums: snare only on beat 3, a soft kick, toms in the fills.',
      'An electric-piano pad doubles the chords; a detuned saw lead floats above in long notes.',
      'Keep the bass slow (root and fifth) so the pads and the chorus carry the sound.'
    ]
  }
]

/** Chip-wide idioms (also surfaced by list_chips). */
export const CHIP_IDIOMS: Record<ChipId, string[]> = {
  nes: [
    'Chords on a single channel are arpeggios (0xy at speed 6); keep them to 3 notes within an octave.',
    'Triangle is the bass: no volume, so write note-offs (===) to shape rhythm.',
    'Noise carries kick/snare/hat as separate presets on one channel: only one hit sounds per row.',
    'Echo effect: repeat the lead on P2 one row later at lower volume.'
  ],
  gb: [
    'WV wave channel is the bass: its volume has only 4 levels, so use v15/v8/v4.',
    'P1 and P2 share the melody and harmony; use the 25% and 50% duties for variety.',
    'Noise short mode (W01) gives metallic hats; long mode gives snare hiss.',
    'Hard pan (X00 / X80 / XFF) widens the stereo image.'
  ],
  genesis: [
    'Put bass on F1 (FM), lead on F2, pads on F3/F4; keep 4-op instruments distinct for a rich mix.',
    'Use F6 as a DAC for drum samples (fm6Dac config) and PSG noise for hats.',
    'PSG squares double the lead one octave up for a bright edge; they cannot play below A-2.',
    'FM instruments with fast attack and moderate feedback give the signature slap bass.'
  ],
  snes: [
    'Everything is a sample: choose or generate samples; strings and choir sound great with echo.',
    'Echo is global: choose a delay (4-6) and feedback (0.4-0.5), then turn it on per voice with E01.',
    'Watch the ARAM budget (64 KB) - echo delay costs 2 KB per step.',
    'Pan voices apart (Xxx) to use the full stereo field.'
  ],
  pce: [
    'Six wavetable voices: bass on C1, lead on C2, harmony on C3/C4.',
    'C5 and C6 can be noise: use them for hats and snares.',
    'Switch waves with Wxx or the timbre macro for evolving timbres.',
    'Pan is per side (4-bit): mid-hard pans keep the mix open.'
  ],
  ps1: [
    'Everything is a sample (4-bit ADPCM grit): pads and strings with the hardware reverb sound huge; keep bass and kick dry.',
    'Reverb is global: pick a preset (studio-large, hall, space-echo) and depth, then switch it per voice with E01/E00.',
    'Sixteen voices in a fixed layout: bass V1, leads V2/V3, pads V4-V6, arp V7, pluck V8, drums V13-V16; 24-voice songs add free voices for doubling.',
    'Pitch modulation (pmod, from V2 on) and the noise generator give metallic and FM-like colours; watch the 512 KB of SPU RAM.'
  ],
  dreamcast: [
    'Clean 16-bit samples (or 8-bit / ADPCM to save the 2 MB of RAM) on up to 64 slots; every slot has its own envelope, LFO and filter.',
    'The resonant filter envelope shapes brass swells and bass plucks; the LFO adds vibrato and tremolo.',
    'The DSP is global: choose chorus-hall for pads and leads, delay or echo for rhythmic repeats, and switch it per slot with E01/E00.',
    'Sixteen slots in a fixed layout: bass V1, leads V2/V3, pads V4-V6, arp V7, pluck V8, drums V13-V16; 32 and 64 slots add free voices for doubling.'
  ]
}

function chipPlan(chip: ChipId, seed: MoodSeed): { channels: ChannelPlan[]; idioms: string[] } {
  const bass = seed.bass ?? 'bass'
  let channels: ChannelPlan[]
  switch (chip) {
    case 'nes':
      channels = [
        { channel: 'P1', role: seed.lead, part: 'lead melody' },
        { channel: 'P2', role: seed.harmony, part: 'arpeggiated chords / counter-melody' },
        { channel: 'TR', role: bass, part: 'bass line' },
        { channel: 'NO', role: 'kick', part: 'drums (kick, snare, hat as separate instruments)' }
      ]
      break
    case 'gb':
      channels = [
        { channel: 'P1', role: seed.lead, part: 'lead melody' },
        { channel: 'P2', role: seed.harmony, part: 'arpeggiated chords / counter-melody' },
        { channel: 'WV', role: bass, part: 'bass line' },
        { channel: 'NO', role: 'kick', part: 'drums' }
      ]
      break
    case 'genesis':
      channels = [
        { channel: 'F1', role: bass, part: 'bass line' },
        { channel: 'F2', role: seed.lead, part: 'lead melody' },
        { channel: 'F3', role: seed.pad, part: 'sustained chords' },
        { channel: 'F4', role: 'strings', part: 'counter-pad / second chord layer' },
        { channel: 'F5', role: seed.harmony, part: 'arpeggio or stabs' },
        { channel: 'F6', role: 'kick', part: 'kick/snare (DAC if fm6Dac) or second bass' },
        { channel: 'S1', role: 'lead', part: 'lead double an octave up' },
        { channel: 'S2', role: 'arp', part: 'counter-line or arpeggio' },
        { channel: 'S3', role: 'arp', part: 'high sparkle / arpeggio' },
        { channel: 'NO', role: 'hihat', part: 'hats' }
      ]
      break
    case 'snes':
      channels = [
        { channel: 'V1', role: bass, part: 'bass line' },
        { channel: 'V2', role: seed.pad, part: 'sustained chords (echo on)' },
        { channel: 'V3', role: 'strings', part: 'second chord layer (echo on)' },
        { channel: 'V4', role: seed.lead, part: 'lead melody' },
        { channel: 'V5', role: 'lead', part: 'counter-melody or lead double' },
        { channel: 'V6', role: seed.harmony, part: 'arpeggio or stabs' },
        { channel: 'V7', role: 'kick', part: 'kick and toms' },
        { channel: 'V8', role: 'snare', part: 'snare and hats' }
      ]
      break
    case 'pce':
      channels = [
        { channel: 'C1', role: bass, part: 'bass line' },
        { channel: 'C2', role: seed.lead, part: 'lead melody' },
        { channel: 'C3', role: seed.pad, part: 'sustained chords' },
        { channel: 'C4', role: seed.harmony, part: 'arpeggio or counter-line' },
        { channel: 'C5', role: 'hihat', part: 'hats (noise)' },
        { channel: 'C6', role: 'snare', part: 'snare (noise) / kick' }
      ]
      break
    case 'ps1':
    case 'dreamcast': {
      const fx = chip === 'ps1' ? 'reverb' : 'DSP'
      channels = [
        { channel: 'V1', role: bass, part: 'bass line' },
        { channel: 'V2', role: seed.lead, part: 'lead melody' },
        { channel: 'V3', role: seed.lead, part: `lead double (an octave down, ${fx} on)` },
        { channel: 'V4', role: seed.pad, part: `sustained chords, root (${fx} on)` },
        { channel: 'V5', role: seed.pad, part: `sustained chords, third (${fx} on)` },
        { channel: 'V6', role: seed.pad, part: `sustained chords, fifth (${fx} on)` },
        { channel: 'V7', role: seed.harmony, part: 'arpeggio or stabs' },
        { channel: 'V8', role: 'pluck', part: 'counter-line or pluck' },
        { channel: 'V13', role: 'kick', part: 'kick' },
        { channel: 'V14', role: 'snare', part: `snare and claps (${fx} on)` },
        { channel: 'V15', role: 'hihat', part: 'hats' },
        { channel: 'V16', role: 'tom', part: 'toms and crash' }
      ]
      break
    }
  }
  return { channels, idioms: CHIP_IDIOMS[chip] }
}

function buildRecipe(seed: MoodSeed): MoodRecipe {
  const totalBars = seed.sections.reduce((a, s) => a + s[1], 0)
  const chips = {} as MoodRecipe['chips']
  for (const c of CHIP_IDS) chips[c] = chipPlan(c, seed)
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    bpm: seed.bpm,
    bpmDefault: Math.round((seed.bpm[0] + seed.bpm[1]) / 2),
    keys: seed.keys,
    scales: seed.scales,
    progressions: PROGRESSIONS.filter((p) => p.moods.includes(seed.id)).map((p) => p.id),
    drumStyles: DRUM_STYLES.filter((s) => s.moods.includes(seed.id)).map((s) => s.id),
    ...(seed.groove ? { groove: seed.groove } : {}),
    parts: { lead: seed.lead, harmony: seed.harmony, pad: seed.pad, bass: seed.bass ?? 'bass' },
    arrangement: {
      sections: seed.sections.map(([name, bars]) => ({ name, bars })),
      totalBars,
      loopFrom: seed.loopFrom
    },
    techniques: seed.techniques,
    chips,
    rowsPerBar: 16,
    patternLength: 64
  }
}

export const MOODS: MoodRecipe[] = SEEDS.map(buildRecipe)
export const MOOD_IDS: string[] = MOODS.map((m) => m.id)

const MOOD_ALIASES: Record<string, string> = {
  epic: 'heroic', hero: 'heroic', fight: 'battle', combat: 'battle', action: 'battle', miniboss: 'boss', horror: 'spooky', creepy: 'spooky',
  scary: 'spooky', cave: 'dungeon', lofi: 'chill', relaxed: 'chill', calm: 'chill', village: 'town', field: 'overworld', world: 'overworld',
  map: 'overworld', win: 'victory', fanfare: 'victory', gameover: 'game-over', lose: 'game-over', defeat: 'game-over', menu: 'title',
  intro: 'title', store: 'shop', market: 'shop', water: 'underwater', ocean: 'underwater', sea: 'underwater', arabian: 'desert',
  egypt: 'desert', fortress: 'castle', gothic: 'castle', melancholy: 'sad', sorrow: 'sad', emotional: 'sad',
  serene: 'peaceful', tranquil: 'peaceful', quiet: 'peaceful', sleep: 'lullaby', bedtime: 'lullaby', dreamy: 'ambient', drone: 'ambient',
  mysterious: 'mysterious-calm', enigmatic: 'mysterious-calm', curious: 'mysterious-calm',
  retrowave: 'synthwave', synth: 'synthwave', '80s': 'synthwave', chase: 'outrun', drive: 'outrun', coldwave: 'darkwave', goth: 'darkwave',
  chillwave: 'dreamwave', dreamsynth: 'dreamwave'
}

export function findMood(ref: string): MoodRecipe | undefined {
  const k = ref.trim().toLowerCase().replace(/[\s_]+/g, '-')
  const id = MOOD_ALIASES[k] ?? k
  return MOODS.find((m) => m.id === id)
}

export function requireMood(ref: string): MoodRecipe {
  const m = findMood(ref)
  if (!m) throw new Error(`Unknown mood "${ref}". Valid moods: ${MOOD_IDS.join(', ')}.`)
  return m
}

/** Short summary lines for listing moods. */
export function listMoods(): { id: string; name: string; description: string; bpm: [number, number] }[] {
  return MOODS.map((m) => ({ id: m.id, name: m.name, description: m.description, bpm: m.bpm }))
}
