import { isFiscalArcaVoucher } from "./environment.ts"

export interface ArcaQrData {
  issueDate: string
  cuit: string
  pointOfSale: number
  voucherType: number
  voucherNumber: number
  total: number
  documentType?: number
  documentNumber?: number
  cae: string
}

export function buildArcaQrPayload(data: ArcaQrData) {
  return {
    ver: 1,
    fecha: data.issueDate,
    cuit: Number(data.cuit.replace(/\D/g, "")),
    ptoVta: data.pointOfSale,
    tipoCmp: data.voucherType,
    nroCmp: data.voucherNumber,
    importe: Number(data.total.toFixed(2)),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: data.documentType ?? 99,
    nroDocRec: data.documentNumber ?? 0,
    tipoCodAut: "E",
    codAut: Number(data.cae),
  }
}

function buildArcaQrUrl(data: ArcaQrData) {
  const payload = JSON.stringify(buildArcaQrPayload(data))
  const encoded = Buffer.from(payload, "utf8").toString("base64")

  return `https://www.arca.gob.ar/fe/qr/?p=${encodeURIComponent(encoded)}`
}

const positiveInteger = (value: number) => Number.isInteger(value) && value > 0

/**
 * QR fiscal de ARCA SÓLO para un comprobante de producción con CAE real
 * (14 dígitos) y datos completos. Un comprobante de homologación, sin
 * ambiente o con datos incompletos devuelve null: nunca se genera un QR que
 * aparente constatar en ARCA algo que no es fiscal.
 */
export function buildFiscalArcaQrUrl(data: ArcaQrData & { environment: unknown }) {
  if (!isFiscalArcaVoucher(data.environment)) return null
  if (!/^\d{14}$/.test(data.cae)) return null
  if (data.cuit.replace(/\D/g, "").length !== 11) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.issueDate)) return null
  if (!positiveInteger(data.pointOfSale) || !positiveInteger(data.voucherType) || !positiveInteger(data.voucherNumber)) {
    return null
  }
  if (!Number.isFinite(data.total) || data.total <= 0) return null

  return buildArcaQrUrl(data)
}
