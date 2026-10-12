// Channel colours shared by the tracker and the piano roll (distinct hues with good contrast on the dark theme).

export const CHANNEL_COLORS: readonly string[] = [
  '#f2c14e', // amber
  '#5fb8ff', // blue
  '#7ddc8a', // green
  '#ff7a7a', // red
  '#c39bff', // violet
  '#ff9f5a', // orange
  '#5fe0d0', // teal
  '#f08fd0' // pink
]

export function channelColor(index: number): string {
  return CHANNEL_COLORS[((index % CHANNEL_COLORS.length) + CHANNEL_COLORS.length) % CHANNEL_COLORS.length]!
}
