import { BATCH_CODE } from "../barcodes/codes.ts"
import { renderCode128Svg } from "../barcodes/render.ts"

export function renderDispatchBarcode(code: string) {
  if (!BATCH_CODE.test(code)) throw new Error("Código de lote inválido.")
  return renderCode128Svg(code, { height: 18 })
}
