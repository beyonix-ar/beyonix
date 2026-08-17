export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => PromiseLike<R> | R,
): Promise<R[]> {
  if (items.length === 0) return []

  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency)),
  )
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}
