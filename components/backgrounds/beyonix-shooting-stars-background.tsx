import type { CSSProperties } from "react"

type StarStyle = CSSProperties & {
  "--end-x": string
  "--end-y": string
  "--star-angle": string
  "--star-delay": string
  "--star-duration": string
  "--star-width": string
  "--star-opacity": string
  "--start-x": string
  "--start-y": string
}

type DotStyle = CSSProperties & {
  "--dot-left": string
  "--dot-top": string
  "--dot-size": string
  "--dot-opacity": string
  "--dot-delay": string
}

type MeteorRoute = {
  startX: number
  startY: number
  endX: number
  endY: number
}

const SHOOTING_STAR_COUNT = 18
const BACKGROUND_DOT_COUNT = 96

const meteorRoutes: MeteorRoute[] = [
  { startX: -12, startY: 14, endX: 72, endY: 84 },
  { startX: 18, startY: -10, endX: 96, endY: 58 },
  { startX: 112, startY: 8, endX: 28, endY: 76 },
  { startX: 86, startY: -8, endX: 18, endY: 64 },

  { startX: -10, startY: 42, endX: 84, endY: 12 },
  { startX: 112, startY: 44, endX: 24, endY: 96 },
  { startX: 12, startY: 108, endX: 88, endY: 26 },
  { startX: 92, startY: 112, endX: 18, endY: 32 },

  { startX: -14, startY: 78, endX: 68, endY: 108 },
  { startX: 116, startY: 82, endX: 42, endY: 16 },
  { startX: 34, startY: 112, endX: 104, endY: 46 },
  { startX: 104, startY: 106, endX: 30, endY: 38 },

  { startX: 24, startY: 22, endX: 94, endY: 92 },
  { startX: 76, startY: 18, endX: 8, endY: 88 },
  { startX: 42, startY: 88, endX: 108, endY: 18 },
  { startX: 88, startY: 72, endX: 16, endY: 8 },

  { startX: 4, startY: 58, endX: 98, endY: 34 },
  { startX: 98, startY: 28, endX: 6, endY: 62 },
]

function makeShootingStarStyle(index: number): StarStyle {
  const route = meteorRoutes[index % meteorRoutes.length]

  const startX = route.startX
  const startY = route.startY
  const endX = route.endX
  const endY = route.endY

  const dx = endX - startX
  const dy = endY - startY
  const angle = Math.atan2(dy, dx)

  const duration = 14 + (index % 7) * 0.9
  const delay = -1 * ((index * 0.91) % 9)
  const width = 78 + (index % 7) * 14
  const opacity = 0.2 + (index % 5) * 0.055

  return {
    "--end-x": `${endX}vw`,
    "--end-y": `${endY}vh`,
    "--star-angle": `${angle}rad`,
    "--star-delay": `${delay}s`,
    "--star-duration": `${duration}s`,
    "--star-width": `${width}px`,
    "--star-opacity": `${opacity}`,
    "--start-x": `${startX}vw`,
    "--start-y": `${startY}vh`,
  }
}

function makeDotStyle(index: number): DotStyle {
  const left = (index * 29 + 3) % 100
  const top = (index * 43 + 17) % 100
  const size = 1 + (index % 3) * 0.5
  const opacity = 0.18 + (index % 4) * 0.06
  const delay = -1 * ((index * 0.31) % 5)

  return {
    "--dot-left": `${left}%`,
    "--dot-top": `${top}%`,
    "--dot-size": `${size}px`,
    "--dot-opacity": `${opacity}`,
    "--dot-delay": `${delay}s`,
  }
}

const shootingStars = Array.from(
  { length: SHOOTING_STAR_COUNT },
  (_, index) => makeShootingStarStyle(index)
)

const backgroundDots = Array.from(
  { length: BACKGROUND_DOT_COUNT },
  (_, index) => makeDotStyle(index)
)

export function BeyonixShootingStarsBackground() {
  return (
    <div className="beyonix-shooting-stars-background" aria-hidden="true">
      <div className="beyonix-stars-depth beyonix-stars-depth-soft" />
      <div className="beyonix-stars-depth beyonix-stars-depth-bright" />

      <div className="beyonix-static-stars">
        {backgroundDots.map((style, index) => (
          <span
            key={`dot-${index}`}
            className="beyonix-static-star"
            style={style}
          />
        ))}
      </div>

      <div className="beyonix-shooting-stars-field">
        {shootingStars.map((style, index) => (
          <span
            key={`shooting-star-${index}`}
            className="beyonix-shooting-star"
            style={style}
          >
            <span className="beyonix-shooting-star-line" />
          </span>
        ))}
      </div>
    </div>
  )
}