import "server-only"

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import QRCode from "qrcode"

import { buildArcaQrUrl } from "@/lib/arca/qr"

interface InvoicePdfItem {
  cantidad: number
  precio: number
  productos?: { nombre?: string | null } | null
  producto_variantes?: { nombre?: string | null } | null
}

export interface InvoicePdfOrder {
  id: number
  total: number
  shipping_cost_charged?: number | null
  shipping_type?: "sucursal" | "domicilio" | null
  shipping_provider?: string | null
  envio_proveedor?: string | null
  andreani_costo?: number | null
  free_shipping_applied?: boolean | null
  payment_method_id?: string | null
  transfer_discount_amount?: number | null
  cliente_nombre?: string | null
  cliente_email?: string | null
  cliente_telefono?: string | null
  cliente_direccion?: string | null
  cp_destino?: string | null
  localidad?: string | null
  provincia?: string | null
  invoice_number: number
  invoice_point: number
  invoice_cae: string
  invoice_cae_due: string
  invoice_created_at: string
  voucher_type?: number
  document_title?: string
  detail_title?: string
  filename_prefix?: string
  original_invoice_total?: number | null
  original_invoice_created_at?: string | null
  original_invoice_cae?: string | null
  credit_note_for_invoice?: {
    point: number
    number: number
  }
  orden_items?: InvoicePdfItem[]
}

interface InvoiceDetailLine {
  label: string
  detail?: string
  quantity: number
  unitAmountCents: number
  subtotalCents: number
  kind: "product" | "shipping" | "discount" | "adjustment"
}

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 38
const BLACK = rgb(0, 0, 0)
const DARK = rgb(0.067, 0.067, 0.067)
const MUTED = rgb(0.32, 0.32, 0.32)
const BLUE = rgb(17 / 255, 42 / 255, 67 / 255)
const PANEL = rgb(0.965, 0.965, 0.965)
const BORDER = rgb(0.72, 0.72, 0.72)
const WHITE = rgb(1, 1, 1)

function requiredCuit() {
  const cuit = process.env.ARCA_CUIT?.replace(/\D/g, "")
  if (!cuit || cuit.length !== 11) {
    throw new Error("ARCA_CUIT debe contener 11 dígitos.")
  }

  return cuit
}

function formatCuit(cuit: string) {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`
}

function formatInvoiceNumber(point: number, number: number) {
  return `${String(point).padStart(4, "0")}-${String(number).padStart(8, "0")}`
}

function formatDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-")
    return `${day}/${month}/${year}`
  }

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function cleanInvoiceAddress(value?: string | null) {
  return (value ?? "")
    .replace(/\.?\s*referencias?:\s*.+$/i, "")
    .trim()
}

function getAddressPostalCode(value?: string | null) {
  return value?.match(/\bCP\s*([A-Z0-9 -]+)/i)?.[1]?.trim().replace(/\.$/, "") || ""
}

function getInvoiceAddressParts(order: InvoicePdfOrder) {
  const cleanAddress = cleanInvoiceAddress(order.cliente_direccion)
  const parts = cleanAddress
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^referencias?:/i.test(part))
  const postalCode = order.cp_destino || getAddressPostalCode(cleanAddress)
  const filteredParts = parts.filter((part) => {
    if (/^cp\s+/i.test(part)) return false
    if (order.localidad && part.toLowerCase() === order.localidad.toLowerCase()) return false
    if (order.provincia && part.toLowerCase() === order.provincia.toLowerCase()) return false
    return true
  })
  const street = filteredParts.shift() || cleanAddress || "No informada"
  const floor =
    filteredParts
      .find((part) => /^piso\b/i.test(part))
      ?.replace(/^piso\s*/i, "")
      .trim() || ""
  const apartment =
    filteredParts
      .find((part) => /^(depto|dpto|departamento)\b/i.test(part))
      ?.replace(/^(depto|dpto|departamento)\.?\s*/i, "")
      .trim() || ""
  const place = [order.localidad, order.provincia].filter(Boolean).join(", ")

  return {
    street,
    floor,
    apartment,
    place,
    postalCode,
  }
}

function formatMoney(value: number) {
  return value.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
  })
}

function toCents(value: number | null | undefined) {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? Math.round(numericValue * 100) : 0
}

function formatCents(value: number) {
  return formatMoney(value / 100)
}

function getShippingLabel(order: InvoicePdfOrder) {
  if (order.shipping_type === "sucursal") return "Retiro en sucursal"
  if (order.shipping_type === "domicilio") return "Envío a domicilio"

  const provider = order.shipping_provider || order.envio_proveedor
  return provider ? `Envío ${provider}` : "Envío"
}

function getShippingCents(order: InvoicePdfOrder) {
  if (order.shipping_cost_charged != null) {
    return toCents(order.shipping_cost_charged)
  }

  return toCents(order.andreani_costo)
}

export function buildInvoiceDetailLines(order: InvoicePdfOrder) {
  const creditNoteTotalCents = toCents(order.total)
  const originalInvoiceTotalCents = toCents(order.original_invoice_total)
  const isPartialCreditNote =
    order.voucher_type === 13 &&
    originalInvoiceTotalCents > 0 &&
    creditNoteTotalCents !== originalInvoiceTotalCents

  if (isPartialCreditNote) {
    return [
      {
        label: "Crédito parcial sobre Factura C",
        detail: order.credit_note_for_invoice
          ? `Factura asociada: ${formatInvoiceNumber(
              order.credit_note_for_invoice.point,
              order.credit_note_for_invoice.number,
            )}`
          : "Comprobante asociado a devolución/cancelación",
        quantity: 1,
        unitAmountCents: toCents(order.total),
        subtotalCents: toCents(order.total),
        kind: "adjustment" as const,
      },
    ]
  }

  const lines: InvoiceDetailLine[] = (order.orden_items ?? []).map((item) => {
    const quantity = Math.max(0, Number(item.cantidad) || 0)
    const unitAmountCents = toCents(item.precio)
    const productName = item.productos?.nombre || "Producto"
    const variant = item.producto_variantes?.nombre

    return {
      label: productName,
      detail: variant ? `Variante: ${variant}` : undefined,
      quantity,
      unitAmountCents,
      subtotalCents: unitAmountCents * quantity,
      kind: "product",
    }
  })
  const shippingCents = getShippingCents(order)
  const hasShippingConcept =
    shippingCents !== 0 ||
    order.free_shipping_applied === true ||
    Boolean(
      order.shipping_type ||
        order.shipping_provider ||
        order.envio_proveedor,
    )

  if (hasShippingConcept) {
    lines.push({
      label: getShippingLabel(order),
      detail:
        order.free_shipping_applied === true && shippingCents === 0
          ? "Envío bonificado"
          : undefined,
      quantity: 1,
      unitAmountCents: shippingCents,
      subtotalCents: shippingCents,
      kind: "shipping",
    })
  }

  const transferDiscountCents = Math.max(
    0,
    toCents(order.transfer_discount_amount),
  )

  if (transferDiscountCents > 0) {
    lines.push({
      label: "Descuento transferencia",
      quantity: 1,
      unitAmountCents: -transferDiscountCents,
      subtotalCents: -transferDiscountCents,
      kind: "discount",
    })
  }

  const targetTotalCents = toCents(order.total)
  const currentTotalCents = lines.reduce(
    (sum, line) => sum + line.subtotalCents,
    0,
  )
  const reconciliationCents = targetTotalCents - currentTotalCents

  if (reconciliationCents !== 0) {
    const isDiscount = reconciliationCents < 0
    lines.push({
      label: isDiscount ? "Descuento aplicado" : "Ajuste de la orden",
      detail: isDiscount
        ? "Promoción o descuento incluido en la compra"
        : "Importe conciliado con el total cobrado",
      quantity: 1,
      unitAmountCents: reconciliationCents,
      subtotalCents: reconciliationCents,
      kind: isDiscount ? "discount" : "adjustment",
    })
  }

  return lines
}

function getInvoiceBreakdown(lines: InvoiceDetailLine[]) {
  return {
    productsSubtotalCents: lines
      .filter((line) => line.kind === "product")
      .reduce((sum, line) => sum + line.subtotalCents, 0),
    summaryLines: lines.filter((line) => line.kind !== "product"),
  }
}

function issueDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value))
}

function pdfSafeText(value: string) {
  return value.replace(
    /[^\x20-\x7e\u00a0-\u00ff\u20ac\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]/g,
    "?",
  )
}

function wrapText(
  value: string,
  maxWidth: number,
  size: number,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
) {
  const words = pdfSafeText(value).trim().split(/\s+/).filter(Boolean)
  if (!words.length) return [""]

  const lines: string[] = []
  let line = ""

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
      continue
    }

    if (line) lines.push(line)

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word
      continue
    }

    let fragment = ""
    for (const character of word) {
      const next = `${fragment}${character}`
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        fragment = next
      } else {
        if (fragment) lines.push(fragment)
        fragment = character
      }
    }
    line = fragment
  }

  if (line) lines.push(line)
  return lines
}

export async function generateInvoicePdf(order: InvoicePdfOrder) {
  const cuit = requiredCuit()
  const voucherType = order.voucher_type ?? 11
  const documentTitle = order.document_title ?? "FACTURA"
  const detailTitle = order.detail_title ?? "DETALLE DE FACTURA"
  const totalLabel = voucherType === 13 ? "TOTAL ACREDITADO" : "TOTAL"
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const qrUrl = buildArcaQrUrl({
    issueDate: issueDate(order.invoice_created_at),
    cuit,
    pointOfSale: order.invoice_point,
    voucherType,
    voucherNumber: order.invoice_number,
    total: Number(order.total),
    cae: order.invoice_cae,
  })
  const qrPng = await QRCode.toBuffer(qrUrl, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  })
  const qrImage = await pdf.embedPng(qrPng)

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN
  const contentWidth = PAGE_WIDTH - MARGIN * 2
  const detailLines = buildInvoiceDetailLines(order)
  const productLines = detailLines.filter((line) => line.kind === "product")
  const tableLines = detailLines.filter(
    (line) =>
      line.kind === "product" ||
      (voucherType === 13 && line.kind === "adjustment"),
  )
  const breakdown = getInvoiceBreakdown(detailLines)
  const pageBottom = 44

  const drawText = (
    text: string,
    x: number,
    currentY: number,
    size = 10,
    isBold = false,
    color = DARK,
  ) => {
    page.drawText(pdfSafeText(text), {
      x,
      y: currentY,
      size,
      font: isBold ? bold : regular,
      color,
    })
  }

  const drawRightText = (
    text: string,
    rightX: number,
    currentY: number,
    size = 10,
    isBold = false,
    color = DARK,
  ) => {
    const safeText = pdfSafeText(text)
    const font = isBold ? bold : regular
    drawText(
      safeText,
      rightX - font.widthOfTextAtSize(safeText, size),
      currentY,
      size,
      isBold,
      color,
    )
  }

  const drawWrappedText = (
    text: string,
    x: number,
    currentY: number,
    maxWidth: number,
    size = 10,
    isBold = false,
    color = DARK,
    lineHeight = size + 3,
  ) => {
    const font = isBold ? bold : regular
    const lines = wrapText(text, maxWidth, size, font)
    lines.forEach((line, index) => {
      drawText(line, x, currentY - index * lineHeight, size, isBold, color)
    })
    return lines.length * lineHeight
  }

  const drawFooter = () => {
    page.drawLine({
      start: { x: MARGIN, y: 34 },
      end: { x: PAGE_WIDTH - MARGIN, y: 34 },
      thickness: 0.5,
      color: BORDER,
    })
    drawText(
      "Documento generado electrónicamente por BEYONIX.",
      MARGIN,
      21,
      7.5,
      false,
      MUTED,
    )
  }

  const newPage = (continuation = false) => {
    drawFooter()
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN

    if (continuation) {
      drawText("BEYONIX", MARGIN, y - 3, 14, true, BLUE)
      drawRightText(
        `${documentTitle} ${formatInvoiceNumber(order.invoice_point, order.invoice_number)}`,
        PAGE_WIDTH - MARGIN,
        y - 3,
        10,
        true,
        DARK,
      )
      y -= 28
    }
  }

  const drawTableHeader = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - 29,
      width: contentWidth,
      height: 29,
      color: BLUE,
    })
    drawText(
      voucherType === 13 ? "Producto / concepto" : "Producto",
      MARGIN + 12,
      y - 19,
      9.5,
      true,
      WHITE,
    )
    drawRightText("Cant.", 382, y - 19, 9.5, true, WHITE)
    drawRightText("P. unitario", 472, y - 19, 9.5, true, WHITE)
    drawRightText("Subtotal", PAGE_WIDTH - MARGIN - 10, y - 19, 9.5, true, WHITE)
    y -= 29
  }

  page.drawRectangle({
    x: MARGIN,
    y: y - 112,
    width: contentWidth,
    height: 112,
    color: BLUE,
    borderColor: BLACK,
    borderWidth: 1,
  })
  drawText("BEYONIX", MARGIN + 18, y - 33, 24, true, WHITE)
  drawText(
    "Tecnología pensada para tu comodidad",
    MARGIN + 18,
    y - 53,
    9.5,
    false,
    WHITE,
  )
  drawText(
    `CUIT: ${formatCuit(cuit)}`,
    MARGIN + 18,
    y - 80,
    9,
    false,
    WHITE,
  )
  drawText(
    "Condición fiscal: Monotributo",
    MARGIN + 18,
    y - 97,
    9,
    false,
    WHITE,
  )

  page.drawRectangle({
    x: PAGE_WIDTH / 2 - 20,
    y: y - 42,
    width: 40,
    height: 40,
    color: WHITE,
    borderColor: BLACK,
    borderWidth: 1,
  })
  drawText("C", PAGE_WIDTH / 2 - 7, y - 31, 23, true, BLACK)
  drawText(`CÓD. ${String(voucherType).padStart(3, "0")}`, PAGE_WIDTH / 2 - 18, y - 55, 7, true, WHITE)

  drawText(documentTitle, PAGE_WIDTH / 2 + 38, y - 31, 18, true, WHITE)
  drawText(
    formatInvoiceNumber(order.invoice_point, order.invoice_number),
    PAGE_WIDTH / 2 + 38,
    y - 56,
    12.5,
    true,
    WHITE,
  )
  drawText(
    `Fecha de emisión: ${formatDate(order.invoice_created_at)}`,
    PAGE_WIDTH / 2 + 38,
    y - 80,
    9,
    false,
    WHITE,
  )
  drawText(
    `Punto de venta: ${String(order.invoice_point).padStart(4, "0")}`,
    PAGE_WIDTH / 2 + 38,
    y - 98,
    9,
    false,
    WHITE,
  )

  y -= 126
  const addressParts = getInvoiceAddressParts(order)
  const addressLines = [
    `Dirección: ${addressParts.street}`,
    `Piso: ${addressParts.floor || "-"}    Dpto: ${addressParts.apartment || "-"}`,
    addressParts.place,
    addressParts.postalCode ? `CP: ${addressParts.postalCode}` : "CP: -",
  ].filter(Boolean)
  const clientLeftWidth = 238
  const clientRightX = MARGIN + 272
  const clientRightWidth = contentWidth - 286
  const nameLines = wrapText(
    `Nombre: ${order.cliente_nombre || "Consumidor final"}`,
    clientLeftWidth,
    9.5,
    regular,
  )
  const emailLines = wrapText(
    `Email: ${order.cliente_email || "No informado"}`,
    clientLeftWidth,
    9.5,
    regular,
  )
  const orderLines = wrapText(
    `Pedido: BX-${1000 + order.id}`,
    clientLeftWidth,
    9.5,
    regular,
  )
  const wrappedAddressLines = addressLines.flatMap((line) =>
    wrapText(line, clientRightWidth, 9.5, regular),
  )
  const clientLines = Math.max(
    nameLines.length + emailLines.length + orderLines.length,
    wrappedAddressLines.length,
  )
  const clientHeight = Math.max(76, 39 + clientLines * 13)

  page.drawRectangle({
    x: MARGIN,
    y: y - clientHeight,
    width: contentWidth,
    height: clientHeight,
    color: PANEL,
    borderColor: BORDER,
    borderWidth: 0.7,
  })
  drawText("DATOS DEL CLIENTE", MARGIN + 14, y - 19, 9.5, true, BLUE)
  const nameHeight = drawWrappedText(
    `Nombre: ${order.cliente_nombre || "Consumidor final"}`,
    MARGIN + 14,
    y - 39,
    clientLeftWidth,
    9.5,
  )
  const emailHeight = drawWrappedText(
    `Email: ${order.cliente_email || "No informado"}`,
    MARGIN + 14,
    y - 39 - nameHeight,
    clientLeftWidth,
    9.5,
  )
  drawWrappedText(
    `Pedido: BX-${1000 + order.id}`,
    MARGIN + 14,
    y - 45 - nameHeight - emailHeight,
    clientLeftWidth,
    9.5,
  )
  wrappedAddressLines.forEach((line, index) => {
    drawText(line, clientRightX, y - 39 - index * 13, 9.5)
  })

  y -= clientHeight + 18
  drawText(detailTitle, MARGIN, y, 10, true, BLUE)
  y -= 13
  drawTableHeader()

  for (const line of tableLines) {
    const productNameLines = wrapText(line.label, 278, 10, bold)
    const variantLines = line.detail
      ? wrapText(line.detail, 278, 9, regular)
      : []
    const rowHeight = Math.max(
      42,
      17 + productNameLines.length * 13 + variantLines.length * 12,
    )

    if (y - rowHeight < pageBottom) {
      newPage(true)
      drawTableHeader()
    }

    page.drawRectangle({
      x: MARGIN,
      y: y - rowHeight,
      width: contentWidth,
      height: rowHeight,
      color: WHITE,
      borderColor: BORDER,
      borderWidth: 0.5,
    })
    productNameLines.forEach((productLine, index) => {
      drawText(
        productLine,
        MARGIN + 12,
        y - 18 - index * 13,
        10,
        true,
        DARK,
      )
    })
    variantLines.forEach((line, index) => {
      drawText(
        line,
        MARGIN + 12,
        y - 18 - productNameLines.length * 13 - index * 12,
        9,
        false,
        MUTED,
      )
    })

    const valueY = y - rowHeight / 2 - 3
    const amountColor = line.subtotalCents < 0 ? BLUE : DARK
    drawRightText(String(line.quantity), 382, valueY, 10, true, DARK)
    drawRightText(
      formatCents(line.unitAmountCents),
      472,
      valueY,
      10,
      line.kind === "discount",
      amountColor,
    )
    drawRightText(
      formatCents(line.subtotalCents),
      PAGE_WIDTH - MARGIN - 10,
      valueY,
      10,
      true,
      amountColor,
    )
    y -= rowHeight
  }

  const summaryWidth = 260
  const summaryX = PAGE_WIDTH - MARGIN - summaryWidth
  const summaryRows = [
    ...(productLines.length > 0
      ? [
          {
            label: "Subtotal productos",
            value: breakdown.productsSubtotalCents,
            color: DARK,
          },
        ]
      : []),
    ...breakdown.summaryLines.map((line) => ({
      label: line.kind === "shipping" ? "Envío" : line.label,
      value: line.subtotalCents,
      color: line.subtotalCents < 0 ? BLUE : DARK,
    })),
  ]
  const summaryHeight = summaryRows.length * 18 + 12
  const associatedHeight =
    voucherType === 13 && order.credit_note_for_invoice ? 74 : 0
  const authorizationHeight = 92
  const postTableGap = 10
  const totalBlockHeight = 45
  const totalToAssociatedGap = associatedHeight > 0 ? 10 : 0
  const associatedToAuthorizationGap = associatedHeight > 0 ? 10 : 0
  const requiredSummaryHeight =
    postTableGap + summaryHeight + 6 + totalBlockHeight

  if (y - requiredSummaryHeight < pageBottom) newPage(true)

  y -= postTableGap

  page.drawRectangle({
    x: summaryX,
    y: y - summaryHeight,
    width: summaryWidth,
    height: summaryHeight,
    color: PANEL,
    borderColor: BORDER,
    borderWidth: 0.6,
  })
  summaryRows.forEach((row, index) => {
    const rowY = y - 19 - index * 18
    drawText(row.label, summaryX + 12, rowY, 9, false, MUTED)
    drawRightText(
      formatCents(row.value),
      PAGE_WIDTH - MARGIN - 12,
      rowY,
      9.5,
      row.value < 0,
      row.color,
    )
  })

  y -= summaryHeight + 6
  page.drawRectangle({
    x: summaryX,
    y: y - 45,
    width: summaryWidth,
    height: 45,
    color: BLUE,
    borderColor: BLACK,
    borderWidth: 0.6,
  })
  drawText(
    totalLabel,
    summaryX + 14,
    y - 28,
    12,
    true,
    WHITE,
  )
  drawRightText(
    formatMoney(Number(order.total)),
    PAGE_WIDTH - MARGIN - 14,
    y - 29,
    15,
    true,
    WHITE,
  )

  y -= totalBlockHeight + totalToAssociatedGap

  const requiredAuthorizationGroupHeight =
    associatedHeight + associatedToAuthorizationGap + authorizationHeight
  if (y - requiredAuthorizationGroupHeight < pageBottom) newPage(true)

  if (voucherType === 13 && order.credit_note_for_invoice) {
    page.drawRectangle({
      x: MARGIN,
      y: y - associatedHeight,
      width: contentWidth,
      height: associatedHeight,
      color: PANEL,
      borderColor: BORDER,
      borderWidth: 0.7,
    })
    drawText("COMPROBANTE ASOCIADO", MARGIN + 14, y - 20, 9.5, true, BLUE)
    drawText(
      `Factura C ${formatInvoiceNumber(
        order.credit_note_for_invoice.point,
        order.credit_note_for_invoice.number,
      )}`,
      MARGIN + 14,
      y - 42,
      11,
      true,
      DARK,
    )
    drawText(
      `CAE: ${order.original_invoice_cae || "-"}`,
      MARGIN + 14,
      y - 60,
      9.5,
      false,
      DARK,
    )
    if (order.original_invoice_created_at) {
      drawRightText(
        `Fecha factura: ${formatDate(order.original_invoice_created_at)}`,
        PAGE_WIDTH - MARGIN - 14,
        y - 60,
        9.5,
        false,
        DARK,
      )
    }
    y -= associatedHeight + associatedToAuthorizationGap
  }

  page.drawRectangle({
    x: MARGIN,
    y: y - authorizationHeight,
    width: contentWidth,
    height: authorizationHeight,
    color: PANEL,
    borderColor: BORDER,
    borderWidth: 0.7,
  })
  page.drawImage(qrImage, {
    x: MARGIN + 16,
    y: y - 76,
    width: 60,
    height: 60,
  })
  drawText("COMPROBANTE AUTORIZADO", MARGIN + 96, y - 23, 10, true, BLUE)
  drawText(`CAE: ${order.invoice_cae}`, MARGIN + 96, y - 47, 11, true, DARK)
  drawText(
    `Vencimiento CAE: ${formatDate(order.invoice_cae_due)}`,
    MARGIN + 96,
    y - 66,
    10,
    false,
    DARK,
  )
  drawText(
    "El QR permite constatar este comprobante en ARCA.",
    MARGIN + 96,
    y - 82,
    8,
    false,
    MUTED,
  )

  drawFooter()

  return pdf.save()
}

export function invoicePdfFilename(
  order: Pick<InvoicePdfOrder, "invoice_point" | "invoice_number" | "filename_prefix">,
) {
  return `${order.filename_prefix ?? "Factura"}-BEYONIX-${formatInvoiceNumber(
    order.invoice_point,
    order.invoice_number,
  )}.pdf`
}
