/** In-process mutex per file path: read-modify-write of providers.md must not interleave (MDI-08). */
const tails = new Map<string, Promise<unknown>>()

export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(file) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  tails.set(file, tail)
  void tail.then(() => {
    if (tails.get(file) === tail) tails.delete(file)
  })
  return run
}
