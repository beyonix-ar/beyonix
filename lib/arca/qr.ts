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

export function buildArcaQrUrl(data: ArcaQrData) {
  const payload = JSON.stringify(buildArcaQrPayload(data))
  const encoded = Buffer.from(payload, "utf8").toString("base64")

  return `https://www.arca.gob.ar/fe/qr/?p=${encodeURIComponent(encoded)}`
}
