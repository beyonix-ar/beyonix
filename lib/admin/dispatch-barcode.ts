import bwipjs from "bwip-js/node"

export function renderDispatchBarcode(code: string) {
  if (!/^DSP-\d{8}-\d{3,}$/.test(code)) throw new Error("Código de tanda inválido.")
  return bwipjs.toSVG({ bcid: "code128", text: code, scale: 3, height: 18, includetext: false, backgroundcolor: "FFFFFF" })
}
