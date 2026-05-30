import type { CSSProperties } from "react"

type StarStyle = CSSProperties & {
  "--star-delay": string
  "--star-duration": string
  "--star-left": string
  "--star-top": string
  "--star-width": string
  "--star-opacity": string
}

type DotStyle = CSSProperties & {
  "--dot-left": string
  "--dot-top": string
  "--dot-size": string
  "--dot-opacity": string
  "--dot-delay": string
}

const SHOOTING_STAR_COUNT = 72
const BACKGROUND_DOT_COUNT = 96

function makeShootingStarStyle(index: number): StarStyle {
  const left = (index * 37 + 11) % 118
  const top = (index * 19 + 7) % 96
  const duration = 4.8 + (index % 9) * 0.28
  const delay = -1 * ((index * 0.31) % 6.4)
  const width = 110 + (index % 8) * 13
  const opacity = 0.36 + (index % 5) * 0.08

  return {
    "--star-delay": `${delay}s`,
    "--star-duration": `${duration}s`,
    "--star-left": `${left}%`,
    "--star-top": `${top}%`,
    "--star-width": `${width}px`,
    "--star-opacity": `${opacity}`,
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

const shootingStars = Array.from({ length: SHOOTING_STAR_COUNT }, (_, index) =>
  makeShootingStarStyle(index)
)

const backgroundDots = Array.from({ length: BACKGROUND_DOT_COUNT }, (_, index) =>
  makeDotStyle(index)
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
          />
        ))}
      </div>
    </div>
  )
}
