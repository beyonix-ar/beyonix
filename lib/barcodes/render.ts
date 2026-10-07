import bwipjs from "bwip-js/node"

import { isPrintableBarcode } from "./codes.ts"

export function renderCode128Svg(code: string, options: { height?: number } = {}) {
  if (!isPrintableBarcode(code)) throw new Error("El código no se puede imprimir en Code 128.")
  return bwipjs.toSVG({
    bcid: "code128",
    text: code,
    scale: 3,
    height: options.height ?? 14,
    includetext: false,
    backgroundcolor: "FFFFFF",
  })
}
