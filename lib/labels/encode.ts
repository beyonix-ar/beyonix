import bwipjs from "bwip-js/node"

import type { BarcodePattern } from "./drawing.ts"
import { classifyBarcode } from "./symbology.ts"

// Patrón de barras exacto (anchos en módulos) generado con BWIPP. El cliente
// lo dibuja como vector en mm, así el ancho real de cada barra lo decide la
// geometría de la etiqueta y nunca un escalado de imagen.
export function encodeBarcodePattern(code: string): BarcodePattern {
  const classification = classifyBarcode(code)
  if (!classification) throw new Error("El código no se puede imprimir.")
  const [symbol] = bwipjs.raw({ bcid: classification.symbology, text: classification.code })
  if (!symbol || !("sbs" in symbol) || !symbol.sbs.length) throw new Error("No se pudo codificar el código.")
  return { symbology: classification.symbology, bars: symbol.sbs.map((width) => Math.round(width)) }
}
