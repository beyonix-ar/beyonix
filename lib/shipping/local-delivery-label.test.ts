import assert from "node:assert/strict"
import test from "node:test"

import { dispatchActionProviderError, dispatchError, localDispatchStage, LOCAL_DISPATCH_STAGE_LABELS } from "../admin/dispatch.ts"
import { getNextDispatchStep } from "../admin/dispatch-next-step.ts"
import { buildLabelsDocument } from "../barcodes/labels-document.ts"
import { isPrintableBarcode } from "../barcodes/codes.ts"
import { getLocalDeliveryPreparationError } from "../orders/local-delivery-status.ts"
import { buildLocalDeliveryLabels, LocalDeliveryLabelError, splitDeliveryAddress, type LocalDeliveryLabelOrder } from "./local-delivery-label.ts"
import { estimateLabelLines, fitLocalDeliveryLabel, LOCAL_DELIVERY_LABEL_TIERS, LOCAL_DELIVERY_LABEL_TOO_LONG } from "./local-delivery-label-layout.ts"

const ORDER: LocalDeliveryLabelOrder = {
  id: 1041,
  cliente_nombre: "María José Peña",
  cliente_direccion: "Córdoba 1234 Piso 3 Dto B. Referencias: Portón verde, timbre 2",
  localidad: "Rosario",
  provincia: "Santa Fe",
  cp_destino: "2000",
  cliente_telefono: "341 555-0000",
}
const parcels = (count: number, attempt = 1) => Array.from({ length: count }, (_, index) => ({
  barcode: `BX-PKG-2041${attempt > 1 ? `-R${attempt}` : ""}-${String(index + 1).padStart(2, "0")}`,
  parcel_index: index + 1,
  parcel_count: count,
}))
const DEFINED_AT = "2026-11-03T15:30:00.000Z"
const svgs = (codes: string[]) => Object.fromEntries(codes.map((code) => [code, `<svg data-code="${code}"></svg>`]))

test("etiqueta: un bulto con pedido, destinatario, dirección, referencia, CP, localidad, teléfono, fecha y BX-PKG", () => {
  const [label] = buildLocalDeliveryLabels(ORDER, parcels(1), DEFINED_AT)
  assert.deepEqual(label, {
    kind: "local_delivery", code: "BX-PKG-2041-01", orderCode: "BX-2041", index: 1, count: 1,
    recipient: "María José Peña", address: "Córdoba 1234 Piso 3 Dto B", reference: "Portón verde, timbre 2",
    locality: "Rosario", province: "Santa Fe", postalCode: "2000", phone: "341 555-0000", date: "03/11/2026",
  })
  assert.equal(isPrintableBarcode(label.code), true, "Code 128 imprimible con los lectores actuales")
})

test("etiqueta: varios bultos => una por bulto, 1/N … N/N, mismo destino y barcode distinto", () => {
  const labels = buildLocalDeliveryLabels(ORDER, parcels(3).reverse(), DEFINED_AT)
  assert.deepEqual(labels.map((label) => [label.index, label.count, label.code]), [
    [1, 3, "BX-PKG-2041-01"], [2, 3, "BX-PKG-2041-02"], [3, 3, "BX-PKG-2041-03"],
  ])
  assert.equal(new Set(labels.map((label) => label.code)).size, 3)
  assert.equal(new Set(labels.map((label) => `${label.orderCode}|${label.address}|${label.phone}`)).size, 1)
})

test("etiqueta: reimprimir el mismo intento da exactamente los mismos códigos; un rearmado usa -R<n> sin colisionar", () => {
  const first = buildLocalDeliveryLabels(ORDER, parcels(2), DEFINED_AT)
  const reprint = buildLocalDeliveryLabels(ORDER, parcels(2), DEFINED_AT)
  assert.deepEqual(reprint, first)
  const rearmed = buildLocalDeliveryLabels(ORDER, parcels(2, 2), "2026-11-04T10:00:00.000Z")
  assert.deepEqual(rearmed.map((label) => label.code), ["BX-PKG-2041-R2-01", "BX-PKG-2041-R2-02"])
  assert.equal(rearmed.some((label) => first.some((old) => old.code === label.code)), false)
})

test("etiqueta: sin datos de entrega o con bultos incompletos no se imprime", () => {
  assert.throws(() => buildLocalDeliveryLabels({ ...ORDER, cliente_direccion: " " }, parcels(1), DEFINED_AT), LocalDeliveryLabelError)
  assert.throws(() => buildLocalDeliveryLabels({ ...ORDER, cp_destino: null }, parcels(1), DEFINED_AT), LocalDeliveryLabelError)
  assert.throws(() => buildLocalDeliveryLabels(ORDER, [], DEFINED_AT), /Definí los bultos/)
  assert.throws(() => buildLocalDeliveryLabels(ORDER, parcels(3).slice(0, 2), DEFINED_AT), /no están completos/)
  // Sin teléfono se imprime igual (el cadete ve "—"), sin referencia tampoco.
  const [label] = buildLocalDeliveryLabels({ ...ORDER, cliente_telefono: null, cliente_direccion: "Mitre 10" }, parcels(1), DEFINED_AT)
  assert.deepEqual([label.phone, label.address, label.reference], [null, "Mitre 10", null])
  assert.deepEqual(splitDeliveryAddress("Oroño 55.  Referencias:  casa  azul "), { address: "Oroño 55", reference: "casa azul" })
})

test("dirección/referencia: separador exacto del checkout; si es ambiguo, todo queda como dirección (nunca se pierde texto)", () => {
  const whole = (text: string) => ({ address: text, reference: null })
  // Más de un separador: no se sabe cuál puso el checkout.
  const twice = "Pasaje Referencias. Referencias: 12. Referencias: timbre 2"
  assert.deepEqual(splitDeliveryAddress(twice), whole(twice))
  // Sin texto antes o después del separador, o con otra forma (no la genera el checkout).
  assert.deepEqual(splitDeliveryAddress("Referencias: portón verde"), whole("Referencias: portón verde"))
  assert.deepEqual(splitDeliveryAddress("Mitre 10. Referencias:"), whole("Mitre 10. Referencias:"))
  assert.deepEqual(splitDeliveryAddress("Oroño 55. referencias: casa azul"), whole("Oroño 55. referencias: casa azul"))
  // Histórico normal del checkout.
  assert.deepEqual(splitDeliveryAddress("Córdoba 1234 Dto. B. Referencias: Portón verde"), { address: "Córdoba 1234 Dto. B", reference: "Portón verde" })
  for (const text of [twice, "Córdoba 1234 Dto. B. Referencias: Portón verde"]) {
    const { address, reference } = splitDeliveryAddress(text)
    const kept = `${address} ${reference ?? ""}`
    const separatorRemoved = reference !== null
    for (const word of text.split(/[ .:]+/).filter((token) => token && !(separatorRemoved && token === "Referencias"))) assert.ok(kept.includes(word), `${word} no se pierde`)
  }
})

const LONG_ORDER: LocalDeliveryLabelOrder = {
  ...ORDER,
  cliente_nombre: "María de los Ángeles Fernández Echeverría Ñúñez de la Santísima Trinidad",
  cliente_direccion: "Avenida Presidente Domingo Faustino Sarmiento 12345 Piso 14 Departamento B Torre Norte. Referencias: Entre Bv. Oroño y Balcarce, portón de rejas verde al lado de la farmacia, tocar timbre 2B",
  localidad: "Villa Gobernador Gálvez",
  provincia: "Santa Fe",
  cliente_telefono: "+54 9 341 555-0000 int. 1234",
}

test("composición adaptativa: casos normales usan el tamaño mayor; datos largos bajan el escalón sin cortar nada", () => {
  const fields = (order: LocalDeliveryLabelOrder) => {
    const [label] = buildLocalDeliveryLabels(order, parcels(1), DEFINED_AT)
    return label
  }
  assert.equal(fitLocalDeliveryLabel(fields(ORDER)), LOCAL_DELIVERY_LABEL_TIERS[0], "normal: escalón mayor")
  const long = fitLocalDeliveryLabel(fields(LONG_ORDER))
  assert.ok(long, "el caso extremo realista entra")
  assert.ok(LOCAL_DELIVERY_LABEL_TIERS.indexOf(long) > 0, "con letra más chica")
  assert.ok(long.address >= 7 && long.recipient >= 7 && long.phone >= 7 && long.city >= 7 && long.reference >= 6.5, "siempre legible")
  // Un único campo largo no achica todo indiscriminadamente: sigue siendo más grande que el mínimo.
  const longAddress = fitLocalDeliveryLabel(fields({ ...ORDER, cliente_direccion: `${"Avenida Presidente Domingo Faustino Sarmiento ".repeat(2)}1234` }))
  assert.ok(longAddress && LOCAL_DELIVERY_LABEL_TIERS.indexOf(longAddress) < LOCAL_DELIVERY_LABEL_TIERS.length - 1)
  assert.ok(estimateLabelLines("Córdoba 1234", 11) === 1 && estimateLabelLines("W".repeat(200), 7) > 2, "palabras imposibles se parten")
})

test("composición adaptativa: si ni el escalón mínimo alcanza, NO se genera la etiqueta (mensaje claro, sin imprimir cortado)", () => {
  const huge = { ...LONG_ORDER, cliente_direccion: `${"Calle muy larga con muchísimo texto ".repeat(8)}123. Referencias: ${"referencia extensa ".repeat(14)}` }
  assert.throws(() => buildLocalDeliveryLabels(huge, parcels(1), DEFINED_AT), (error: Error) =>
    error instanceof LocalDeliveryLabelError && error.message === LOCAL_DELIVERY_LABEL_TOO_LONG)
  assert.equal(LOCAL_DELIVERY_LABEL_TOO_LONG, "Los datos de entrega son demasiado largos para esta etiqueta. Revisalos antes de imprimir.")
  // El documento de impresión aplica la misma regla aunque reciba la etiqueta directo.
  const [label] = buildLocalDeliveryLabels(ORDER, parcels(1), DEFINED_AT)
  assert.throws(() => buildLabelsDocument([{ ...label, address: "X".repeat(900) }], svgs([label.code]), "single"), new RegExp(LOCAL_DELIVERY_LABEL_TOO_LONG))
})

test("impresión: HTML 101,6 × 50,8 mm con jerarquía para el cadete, escapado y sin datos financieros", () => {
  const labels = buildLocalDeliveryLabels({ ...ORDER, cliente_nombre: "Ana <b>Ñandú</b>" }, parcels(2), DEFINED_AT)
  const html = buildLabelsDocument(labels, svgs(labels.map((label) => label.code)), "single")
  assert.match(html, /@page \{ size: 101\.6mm 50\.8mm; margin: 0; \}/)
  for (const text of ["BEYONIX", "ENVÍO BEYONIX", "PEDIDO BX-2041", "BULTO 1/2", "BULTO 2/2", "DESTINATARIO", "Ana &lt;b&gt;Ñandú&lt;/b&gt;",
    "DIRECCIÓN", "Córdoba 1234 Piso 3 Dto B", "REFERENCIA", "Portón verde, timbre 2", "Rosario, Santa Fe", "CP 2000", "TELÉFONO", "341 555-0000", "03/11/2026",
    "BX-PKG-2041-01", "BX-PKG-2041-02", 'data-code="BX-PKG-2041-01"', 'data-code="BX-PKG-2041-02"']) {
    assert.ok(html.includes(text), text)
  }
  assert.doesNotMatch(html, /<b>Ñandú/, "texto escapado")
  // Ningún dato de entrega con recorte: sin ellipsis, line-clamp ni recortes por carácter.
  const localCss = html.slice(html.indexOf(".local_delivery {"), html.indexOf("</style>"))
  assert.doesNotMatch(localCss, /ellipsis|line-clamp|nowrap; overflow: hidden; text-overflow/)
  assert.doesNotMatch(html, /…/)
  // Code 128 con zona de silencio, alto fijo y el código legible debajo.
  assert.match(localCss, /\.local_delivery \.barcode \{ flex: none; height: 9mm; margin: 0; padding-inline: 7mm; \}/)
  for (const forbidden of [/\$/, /total/i, /pago/i, /saldo/i, /cuit/i, /precio/i, /Mercado Pago/i, /transferencia/i, /Auriculares/i]) {
    assert.doesNotMatch(html, forbidden)
  }
  assert.doesNotMatch(html, /Andreani/i, "nada de Andreani")
  // Las otras etiquetas conservan su tamaño.
  assert.match(buildLabelsDocument([{ kind: "parcel", code: "BX-PKG-2041-01", orderCode: "BX-2041", index: 1, count: 1 }], svgs(["BX-PKG-2041-01"]), "single"), /size: 76mm 40mm/)
})

test("proveedor: Envío BEYONIX nunca usa acciones Andreani; Andreani nunca usa bultos/etiquetas BEYONIX", () => {
  for (const action of ["ship", "confirm_label"] as const) {
    assert.match(dispatchActionProviderError(true, action, "pagado") ?? "", /no lleva envío ni etiqueta Andreani/, action)
    assert.equal(dispatchActionProviderError(false, action, "pagado"), null, action)
  }
  for (const action of ["local_parcels", "confirm_parcel"] as const) {
    assert.match(dispatchActionProviderError(false, action, "pagado") ?? "", /sólo para pedidos con Envío BEYONIX/, action)
    assert.equal(dispatchActionProviderError(true, action, "pagado"), null, action)
  }
  for (const action of ["start", "scan", "adjust", "reset"] as const) {
    assert.equal(dispatchActionProviderError(true, action, "pagado"), null, `pickeo común: ${action}`)
    assert.equal(dispatchActionProviderError(false, action, "pagado"), null, `pickeo común: ${action}`)
  }
  assert.match(dispatchActionProviderError(true, "reset", "en_camino") ?? "", /ya salió con el cadete/)
  assert.equal(dispatchActionProviderError(false, "reset", "en_camino"), null, "Andreani sin cambios")
  assert.match(dispatchError({ message: "DISPATCH_LOCAL_DELIVERY_NO_ANDREANI" }), /no lleva etiqueta Andreani/)
  assert.match(dispatchError({ message: "DISPATCH_LOCAL_PARCELS_DEFINED" }), /reiniciá la preparación/)
  assert.match(dispatchError({ message: "DISPATCH_PARCEL_STALE" }), /Etiqueta anterior/)
})

test("etapas locales: pickeo → bultos → etiquetas → listo para el cadete; vuelve a Despachos, nunca a un Bulto general", () => {
  const prepared = { status: "prepared" as const }
  assert.equal(localDispatchStage(null, { packageStatus: null, parcelCount: null, confirmedParcels: 0 }, false), "pending")
  assert.equal(localDispatchStage({ status: "preparing" }, { packageStatus: "preparing", parcelCount: null, confirmedParcels: 0 }, false), "packing")
  assert.equal(localDispatchStage(prepared, { packageStatus: "prepared", parcelCount: null, confirmedParcels: 0 }, false), "shipment")
  assert.equal(localDispatchStage(prepared, { packageStatus: "prepared", parcelCount: 2, confirmedParcels: 1 }, false), "label")
  assert.equal(localDispatchStage(prepared, { packageStatus: "prepared", parcelCount: 2, confirmedParcels: 2 }, false), "ready")
  assert.equal(localDispatchStage(prepared, { packageStatus: "prepared", parcelCount: 2, confirmedParcels: 2 }, true), "handed_over")
  assert.equal(LOCAL_DISPATCH_STAGE_LABELS.ready, "Listo para el cadete")
  assert.equal(getLocalDeliveryPreparationError({ packageStatus: "prepared", parcelCount: 2, confirmedParcels: 2 }), null)
  const facts = { kind: "order" as const, orderId: 1041, blocked: false, batchId: null }
  assert.deepEqual(getNextDispatchStep({ ...facts, stage: "ready", localDelivery: true }), { screen: "list" })
  assert.deepEqual(getNextDispatchStep({ ...facts, stage: "label", localDelivery: true }), { screen: "current" })
  assert.deepEqual(getNextDispatchStep({ ...facts, stage: "ready" }), { screen: "bundle_list", orderId: 1041 }, "Andreani sin cambios")
})
