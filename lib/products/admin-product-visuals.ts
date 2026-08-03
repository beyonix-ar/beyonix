export function firstUsableImage(
  ...sources: Array<string | null | undefined | string[]>
) {
  for (const source of sources) {
    const candidates = Array.isArray(source) ? source : [source]
    const image = candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )
    if (image) return image.trim()
  }

  return null
}
