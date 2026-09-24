// Herramienta manual: compara la captura de superficies de dos CSS.
// npx tsx lib/theme/surface-compare.ts <css-antes> <css-despues>
import { readFileSync } from "node:fs"

import { captureAll, launch } from "./surface-capture"

async function main() {
  const [beforePath, afterPath] = process.argv.slice(2)
  const before = readFileSync(beforePath, "utf8")
  const after = readFileSync(afterPath, "utf8")
  const browser = await launch()
  try {
    for (const theme of ["dark", "light"] as const) {
      const a = await captureAll(before, theme, browser)
      const b = await captureAll(after, theme, browser)
      console.log(`\n== ${theme.toUpperCase()}`)
      let differences = 0
      for (const [fixture, probes] of Object.entries(b)) {
        for (const [selector, style] of Object.entries(probes)) {
          const previous = a[fixture][selector]
          const same = previous.background === style.background && previous.border === style.border
          if (!same) differences++
          console.log(
            `${same ? " " : "*"} ${fixture.padEnd(13)} ${selector.padEnd(24)} ${previous.background.padEnd(26)} -> ${style.background}`,
          )
        }
      }
      console.log(`diferencias ${theme}: ${differences}`)
    }
  } finally {
    await browser.close()
  }
}

void main()
