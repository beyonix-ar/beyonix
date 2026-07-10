export type ProductVideoSource =
  | {
      kind: "youtube"
      originalUrl: string
      embedUrl: string
    }
  | {
      kind: "vimeo"
      originalUrl: string
      embedUrl: string
    }
  | {
      kind: "direct"
      originalUrl: string
      videoUrl: string
    }
  | {
      kind: "unsupported"
      originalUrl: string
    }

const DIRECT_VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "ogg",
  "ogv",
  "mov",
  "m4v",
])

function getHttpsUrl(value: string | null | undefined) {
  const trimmed = (value ?? "").trim()

  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    return url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

function normalizeHost(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, "")
}

function getYouTubeId(url: URL) {
  const host = normalizeHost(url)
  const pathParts = url.pathname.split("/").filter(Boolean)

  if (host === "youtu.be") {
    return pathParts[0] ?? null
  }

  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtube-nocookie.com"
  ) {
    if (url.searchParams.has("v")) {
      return url.searchParams.get("v")
    }

    if (pathParts[0] === "shorts" || pathParts[0] === "embed") {
      return pathParts[1] ?? null
    }
  }

  return null
}

function getVimeoId(url: URL) {
  const host = normalizeHost(url)
  const pathParts = url.pathname.split("/").filter(Boolean)

  if (host === "vimeo.com") {
    return pathParts.find((part) => /^\d+$/.test(part)) ?? null
  }

  if (host === "player.vimeo.com" && pathParts[0] === "video") {
    return /^\d+$/.test(pathParts[1] ?? "") ? pathParts[1] : null
  }

  return null
}

function hasDirectVideoExtension(url: URL) {
  const extension = url.pathname.split(".").pop()?.toLowerCase()
  return extension ? DIRECT_VIDEO_EXTENSIONS.has(extension) : false
}

export function isValidHttpsVideoUrl(value: string | null | undefined) {
  return getHttpsUrl(value) !== null
}

export function getProductVideoSource(
  value: string | null | undefined
): ProductVideoSource | null {
  const url = getHttpsUrl(value)

  if (!url) return null

  const originalUrl = url.toString()
  const youtubeId = getYouTubeId(url)

  if (youtubeId && /^[\w-]{6,64}$/.test(youtubeId)) {
    return {
      kind: "youtube",
      originalUrl,
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
    }
  }

  const vimeoId = getVimeoId(url)

  if (vimeoId) {
    return {
      kind: "vimeo",
      originalUrl,
      embedUrl: `https://player.vimeo.com/video/${vimeoId}`,
    }
  }

  if (hasDirectVideoExtension(url)) {
    return {
      kind: "direct",
      originalUrl,
      videoUrl: originalUrl,
    }
  }

  return {
    kind: "unsupported",
    originalUrl,
  }
}

export function isPlayableProductVideo(value: string | null | undefined) {
  const source = getProductVideoSource(value)
  return source !== null && source.kind !== "unsupported"
}

export function getImageIndexFromMediaIndex(
  mediaIndex: number,
  hasVideo: boolean
) {
  if (!hasVideo) {
    return Math.max(mediaIndex, 0)
  }

  if (mediaIndex <= 1) {
    return 0
  }

  return mediaIndex - 1
}

export function getImageUrlFromMediaIndex(
  images: string[],
  mediaIndex: number,
  videoUrl?: string | null
) {
  const imageIndex = getImageIndexFromMediaIndex(
    mediaIndex,
    isPlayableProductVideo(videoUrl)
  )

  return images[imageIndex] ?? images[0]
}
