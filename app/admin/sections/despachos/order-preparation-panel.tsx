"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { AlertTriangle, ArrowRight, CheckCircle2, Download, History, PackageCheck, Printer, RotateCcw, Scale, Truck, XCircle } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminRowMenu, AdminTextarea, AdminTextInput, type AdminRowMenuAction } from "@/app/admin/components/admin-controls"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_ADJUSTMENT_PROBLEMS, DISPATCH_ADJUSTMENT_SETTLEMENTS, DISPATCH_STAGE_LABELS, orderCode, type DispatchSaleItem, type DispatchScanResult, type DispatchShippingInfo, type DispatchVariantCandidate, type OrderDispatchDetail } from "@/lib/admin/dispatch"
import { dispatchBatchName } from "@/lib/admin/dispatch-queue"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { openAndreaniLabel } from "./andreani-label"
import { CancellationResolution } from "./cancellation-resolution"
import { DifferenceResolution, type DifferenceInput } from "./difference-resolution"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { initialParcelDrafts, ParcelMeasuresEditor, readParcelDrafts, resizeParcelDrafts, type ParcelDraft } from "./parcel-measures"
import { ScanField } from "./scan-field"

type ScanFeedback = { tone: "success" | "warning" | "error"; message: string }
/** Qué puede hacer quien mira el pedido (lo decide el servidor y lo vuelve a validar al ejecutar). */
type Viewer = { costsVisible: boolean; canShip: boolean; canForce: boolean }
type Detail = OrderDispatchDetail & { viewer?: Viewer }
type OrderResponse = Detail & { scan?: DispatchScanResult | null }
/** Código de grupo en un renglón aleatorio: falta confirmar la variante física. */
type PendingVariant = { code: string; productName: string | null; candidates: DispatchVariantCandidate[] }
type OrderLine = OrderDispatchDetail["lines"][number]
type Dialog = "ship" | "force" | "reset" | "difference"
type PrimaryAction = { label: string; icon?: ReactNode; onClick?: () => void; disabled?: boolean; hint?: string }

export const DISPATCH_STAGE_TONE = { pending: "info", packing: "info", shipment: "info", label: "warning", ready: "success", in_batch: "info", batch_closed: "success", handed_over: "success" } as const

// Motor único de armado: Despachos y la solapa "ARMAR PEDIDO" del pedido usan
// este mismo panel contra las mismas RPC. El escaneo valida identidad; sólo en
// venta aleatoria puede pasar la unidad a la variante física escaneada.
const NO_SHIPPING_INFO: DispatchShippingInfo = { costsVisible: false, estimate: null, parcelQuote: null }
const NO_VIEWER: Viewer = { costsVisible: false, canShip: false, canForce: false }
const money = (value: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(value)
const dateTime = (value: string) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hourCycle: "h23", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
// El panel también vive en el detalle del pedido: la navegación no depende del router de Despachos.
const goTo = (path: string) => window.location.assign(path)

/**
 * Pedido en Despachos: estado, progreso, productos y UNA acción principal
 * según la etapa (empezar → pickear → generar envío Andreani → imprimir su
 * etiqueta). Lo secundario vive en menús que sólo
 * muestran opciones válidas para el estado actual.
 */
export function OrderPreparationPanel({ orderId, onDone, footer }: {
  orderId: number
  /** Cierre tras resolver una cancelación con armado. */
  onDone?: () => void
  footer?: ReactNode
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null)
  const [scan, setScan] = useState("")
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [dialogError, setDialogError] = useState("")
  const [parcelInput, setParcelInput] = useState("")
  const [parcelDrafts, setParcelDrafts] = useState<ParcelDraft[]>([])
  const [reason, setReason] = useState("")
  const [pendingVariant, setPendingVariant] = useState<PendingVariant | null>(null)
  const scanKey = useRef<string | null>(null)
  const variantKey = useRef<{ variantId: number; key: string } | null>(null)
  const actionKey = useRef<string | null>(null)
  const busyRef = useRef(false)

  const load = useCallback(async () => {
    try { setDetail(await dispatchRequest<Detail>(`/orders/${orderId}`)); setError("") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar el pedido.") }
    finally { setLoading(false) }
  }, [orderId])

  useEffect(() => { setLoading(true); setDetail(null); setFeedback(null); void load() }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (!busyRef.current) void load() }, 200) }
    window.addEventListener(ADMIN_DISPATCH_CHANGED_EVENT, reload)
    return () => { if (timer) clearTimeout(timer); window.removeEventListener(ADMIN_DISPATCH_CHANGED_EVENT, reload) }
  }, [load])

  async function run(action: () => Promise<void>, onError: (message: string) => void = setError) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(""); setDialogError(""); setNotice("")
    try { await action() }
    catch (cause) { onError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
    finally { busyRef.current = false; setBusy(false) }
  }

  // Un escaneo con variantId confirma la variante física de un código de
  // grupo. Cada variante elegida usa su propia clave: un reintento de la
  // misma elección es idempotente y elegir otra nunca choca con la anterior.
  function sendScan(code: string, requestKey: string, variantId?: number) {
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        const updated = await dispatchRequest<OrderResponse>(`/orders/${orderId}`, { action: "scan", code, requestKey, ...(variantId ? { variantId } : {}) })
        setDetail(updated)
        const result = updated.scan
        if (result?.requiresVariant) {
          setPendingVariant({ code, productName: result.productName, candidates: result.candidates })
          setFeedback(null)
          playScanFeedback("warning")
        } else {
          const line = result ? updated.lines.find((item) => item.order_item_id === result.orderItemId) : undefined
          const physical = line?.random?.dispatchedVariant ? ` · ${line.random.dispatchedVariant}` : ""
          const remaining = line ? line.expected_quantity - line.scanned_quantity : 0
          setFeedback(line
            ? { tone: result?.duplicate ? "warning" : "success", message: `✓ ${line.name}${physical} · ${line.scanned_quantity} de ${line.expected_quantity}${remaining > 0 ? ` · faltan ${remaining}` : " · completo"}` }
            : { tone: "success", message: "✓ Producto verificado" })
          playScanFeedback(result?.duplicate ? "warning" : "success")
          setPendingVariant(null); variantKey.current = null
        }
        setScan(""); scanKey.current = null
      } catch (cause) {
        // Un código incorrecto avisa y no cambia nada: el pickeo sigue.
        const retryable = cause instanceof DispatchRequestError && cause.retryable
        if (!retryable) { scanKey.current = null; variantKey.current = null; setScan("") }
        if (variantId && !retryable) setPendingVariant(null)
        setFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "No se pudo verificar el código." })
        playScanFeedback("error")
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    })()
  }

  function submitScan(code: string) {
    if (busyRef.current) return
    // Mismo código pendiente de reintento: misma clave. Otro código: clave nueva.
    if (code !== scan.trim()) scanKey.current = null
    setScan(code)
    scanKey.current ??= crypto.randomUUID()
    sendScan(code, scanKey.current)
  }

  function confirmVariant(variantId: number) {
    if (!pendingVariant || busyRef.current) return
    if (variantKey.current?.variantId !== variantId) variantKey.current = { variantId, key: crypto.randomUUID() }
    sendScan(pendingVariant.code, variantKey.current.key, variantId)
  }

  /** Acción con request_key: el reintento de la misma acción no se duplica. */
  function post(body: Record<string, unknown>, after?: () => void) {
    void run(async () => {
      actionKey.current ??= crypto.randomUUID()
      setDetail(await dispatchRequest<Detail>(`/orders/${orderId}`, { ...body, requestKey: actionKey.current }))
      actionKey.current = null
      after?.()
    }, dialog ? setDialogError : setError)
  }

  function openDialog(next: Dialog) { actionKey.current = null; setDialogError(""); setReason(""); setDialog(next) }

  if (loading && !detail) return <p role="status" className="text-sm text-white/70">Cargando pedido…</p>
  if (!detail) return <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error || "No se pudo cargar el pedido."}</div>

  // Filtro de cancelación 1/2: cancelado con pickeo iniciado (dentro o fuera de un Bulto general).
  if (detail.hold) return <CancellationResolution hold={detail.hold} onResolved={() => void load()} onClose={onDone ?? (() => void load())} />
  if (detail.order.estado === "cancelado" || detail.order.cancelled_at || ["cancellation_requested", "refund_pending", "refunded"].includes(detail.order.financial_status ?? "")) {
    return <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-4 text-sm font-semibold text-white">Pedido cancelado — no requiere preparación</div>
  }

  const viewer = detail.viewer ?? NO_VIEWER
  const { stage, shipment } = detail
  const pkg = detail.package
  const code = orderCode(detail.order.id)
  const inBatch = Boolean(detail.membership)
  const handedOver = Boolean(detail.order.andreani_handed_over_at)
  const units = detail.lines.reduce((sum, line) => sum + line.scanned_quantity, 0)
  const remaining = Math.max(0, detail.expectedUnits - units)
  const packingBlocked = detail.packingBlocked
  const identified = Boolean(pkg?.identification_method)
  const shipmentUncertain = shipment.creationStatus === "claimed" || shipment.creationStatus === "reconciliation_required"
  const shippingInfo = detail.shipping ?? NO_SHIPPING_INFO
  const pendingLines = detail.lines.filter((line) => line.scanned_quantity < line.expected_quantity)
  // Pendientes que sólo frenan el Bulto general (p. ej. factura): se informan recién ahí.

  const printLabel = (mode: "print" | "download") => void run(async () => {
    await openAndreaniLabel(orderId, mode)
    setNotice(mode === "print" ? "Etiqueta Andreani lista para imprimir. Pegala en el paquete." : "Etiqueta Andreani descargada.")
    await load()
  })
  const openShip = () => {
    const count = pkg?.parcel_count ?? (shippingInfo.estimate?.parcels.length || 1)
    setParcelInput(String(count))
    setParcelDrafts(initialParcelDrafts(detail.parcels, count))
    openDialog("ship")
  }

  let primary: PrimaryAction | null = null
  if (stage === "pending") primary = { label: "Empezar preparación", icon: <PackageCheck className="size-5" />, disabled: packingBlocked, onClick: () => post({ action: "start" }) }
  else if (stage === "packing") primary = { label: "Generar envío Andreani", icon: <Truck className="size-5" />, disabled: true, hint: `Completá el pickeo: ${remaining === 1 ? "falta 1 unidad" : `faltan ${remaining} unidades`}.` }
  else if (stage === "shipment") primary = shipmentUncertain
    ? { label: "Generar envío Andreani", icon: <Truck className="size-5" />, disabled: true, hint: "Envío en revisión: requiere conciliación manual antes de reintentar." }
    : { label: "Generar envío Andreani", icon: <Truck className="size-5" />, disabled: !viewer.canShip || packingBlocked, hint: viewer.canShip ? undefined : "El envío lo genera un Admin.", onClick: openShip }
  else if (stage === "label") primary = { label: "Imprimir etiqueta Andreani", icon: <Printer className="size-5" />, onClick: () => printLabel("print") }
  else if (stage === "ready") primary = null
  else if (stage === "in_batch" && detail.batch) {
    const batchId = detail.batch.id
    primary = { label: `Abrir ${dispatchBatchName(detail.batch)}`, icon: <ArrowRight className="size-5" />, onClick: () => goTo(`/admin/despachos?batch=${batchId}`) }
  }

  const labelItems: AdminRowMenuAction[] = shipment.created ? [
    ...(identified ? [{ key: "print", label: "Reimprimir etiqueta Andreani", icon: <Printer className="size-4" />, disabled: busy, onSelect: () => printLabel("print") }] : []),
    { key: "download", label: "Guardar PDF de etiqueta Andreani", icon: <Download className="size-4" />, disabled: busy, onSelect: () => printLabel("download") },
  ] : []
  const orderItems: AdminRowMenuAction[] = [
    { key: "history", label: "Ver historial", icon: <History className="size-4" />, onSelect: () => goTo(`/admin/pedidos/${orderId}?tab=historial`) },
    ...(stage === "packing" && pendingLines.length && !packingBlocked ? [{ key: "difference", label: "Resolver diferencia", icon: <Scale className="size-4" />, onSelect: () => openDialog("difference") }] : []),
    ...(pkg && !inBatch && !handedOver ? [{ key: "reset", label: "Reiniciar preparación", icon: <RotateCcw className="size-4" />, tone: "danger" as const, onSelect: () => openDialog("reset") }] : []),
  ]
  const shipmentItems: AdminRowMenuAction[] = [
    ...(shipment.created ? [{ key: "tracking", label: "Ver seguimiento", icon: <Truck className="size-4" />, onSelect: () => goTo(`/admin/pedidos/${orderId}?tab=envio`) }] : []),
  ]
  // Excepciones: sólo Super Admin, con motivo y auditoría.
  const exceptionItems: AdminRowMenuAction[] = viewer.canForce && stage === "packing" && !shipment.created && !packingBlocked
    ? [{ key: "force", label: "Generar envío con pickeo incompleto", icon: <AlertTriangle className="size-4" />, tone: "danger", onSelect: () => openDialog("force") }]
    : []
  const lastAdjustment = new Map(detail.adjustments.map((adjustment) => [adjustment.orderItemId, adjustment]))
  const displayItems: DispatchSaleItem[] = detail.saleItems?.length ? detail.saleItems : detail.lines.map((line) => ({
    orderItemId: line.order_item_id, sku: line.expected_sku, productName: line.name ?? "Producto", variantName: null,
    orderedQuantity: line.orderedQuantity, unitPrice: line.unitPrice,
  }))
  const lineByItem = new Map(detail.lines.map((line) => [line.order_item_id, line]))
  const parcelValue = Number(parcelInput)
  const validParcels = Number.isInteger(parcelValue) && parcelValue >= 1 && parcelValue <= 50
  const parcelsReading = validParcels ? readParcelDrafts(parcelDrafts) : null

  return <div className="dispatch-order w-full min-w-0 space-y-2">
    {packingBlocked && <div role="alert" className="rounded-xl border border-red-500/50 bg-red-950 p-3 text-sm text-white">
      <p className="font-black">{inBatch ? "RETIRAR DEL DESPACHO" : "Pedido bloqueado"} · {detail.blockReason ?? "Revisión requerida"}</p>
    </div>}
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}

    <AdminCard className="dispatch-card dispatch-order-card min-w-0 p-0">
      <div className="dispatch-order-heading flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2.5 sm:px-4">
        <h3 className="text-base font-black tabular-nums text-white">Pedido {code}</h3>
        <span>Compra: {dateTime(detail.order.created_at)}</span>
        {pkg?.prepared_at && <span>Preparado: {dateTime(pkg.prepared_at)}</span>}
        {detail.order.invoice_status === "authorized" && <span>Factura: Emitida</span>}
        {shipment.created && <span>Andreani: {shipment.tracking ?? shipment.envioId}</span>}
        <AdminBadge tone={packingBlocked ? "danger" : DISPATCH_STAGE_TONE[stage]}>{DISPATCH_STAGE_LABELS[stage]}</AdminBadge>
        {stage !== "ready" && <span>{units} de {detail.expectedUnits} unidades</span>}
      </div>
      <div className="dispatch-order-actions flex flex-wrap gap-2 px-3 py-2 sm:px-4" aria-label="Acciones secundarias">
          {labelItems.length > 0 && <AdminRowMenu triggerLabel="Etiquetas" ariaLabel="Etiquetas" items={labelItems} />}
          <AdminRowMenu triggerLabel="Pedido" ariaLabel="Pedido" items={orderItems} />
          {shipmentItems.length > 0 && <AdminRowMenu triggerLabel="Envío" ariaLabel="Envío" items={shipmentItems} />}
          {exceptionItems.length > 0 && <AdminRowMenu triggerLabel="Más" ariaLabel="Más acciones" items={exceptionItems} />}
      </div>

      <div className="dispatch-product-table-wrap">
        <table className="dispatch-product-table w-full" aria-label="Productos del pedido">
          <thead><tr><th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Variante</th><th scope="col">Cantidad</th><th scope="col">Picking</th><th scope="col">Precio</th><th scope="col">Total</th></tr></thead>
          <tbody>{displayItems.map((item) => <ProductLine key={item.orderItemId} item={item} line={lineByItem.get(item.orderItemId)} adjusted={lastAdjustment.has(item.orderItemId)} />)}</tbody>
        </table>
        {displayItems.length === 0 && <p className="px-4 py-3 text-sm text-white/60">Sin productos para mostrar.</p>}
      </div>
      {detail.adjustments.length > 0 && <ul className="dispatch-divider space-y-1 border-t px-3 py-2 text-xs text-amber-100 sm:px-4" aria-label="Diferencias registradas">
        {detail.adjustments.map((adjustment) => <li key={adjustment.id}>
          {DISPATCH_ADJUSTMENT_PROBLEMS[adjustment.problem]} · {adjustment.quantityBefore} → {adjustment.quantityAfter} · {DISPATCH_ADJUSTMENT_SETTLEMENTS[adjustment.settlement]}{adjustment.differenceAmount != null ? ` · ${money(adjustment.differenceAmount)}` : ""}
        </li>)}
      </ul>}

      <div className="dispatch-scan-total border-t px-3 py-3 sm:px-4">
        {stage === "packing" && <div className="dispatch-scanner min-w-0 space-y-1">
          <ScanField label="Escanear o ingresar código / SKU" placeholder="Escaneá el producto" submitLabel="Verificar"
            value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
            busy={busy} disabled={packingBlocked} autoFocus={!pendingVariant && dialog === null}
            cameraTitle={`Pickeo ${code}`} cameraHint="Encuadrá el código de barras del producto" continuousCamera feedback={feedback} />
          <LastScan feedback={feedback} />
        </div>}
        {stage !== "packing" && feedback && <LastScan feedback={feedback} />}
        {detail.order.total != null && <p className="dispatch-order-total-amount">TOTAL PEDIDO: <strong>{money(Number(detail.order.total))}</strong></p>}
      </div>
      {notice && <p role="status" className="px-3 py-2 text-xs font-bold text-emerald-300 sm:px-4">{notice}</p>}
      {primary && <div className="dispatch-divider dispatch-primary-bar border-t px-3 py-2.5 sm:px-4">
        <AdminPrimaryButton className="h-10 w-full justify-center text-sm sm:w-auto" icon={primary.icon} disabled={busy || primary.disabled} onClick={primary.onClick}>{primary.label}</AdminPrimaryButton>
        {primary.hint && <p className="mt-1 text-xs text-white/60">{primary.hint}</p>}
      </div>}
    </AdminCard>
    {footer}

    <AdminModal open={dialog === "ship"} title="Generar envío Andreani" description={`${code} · Cantidad de bultos y medidas reales de cada uno.`} onClose={() => setDialog(null)} footer={<div className="flex flex-wrap items-center justify-end gap-2">
      {parcelsReading && "error" in parcelsReading ? <span className="mr-auto text-xs font-bold text-amber-200">{parcelsReading.error}</span> : null}
      <AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton>
      <AdminPrimaryButton disabled={busy || !parcelsReading || "error" in parcelsReading} onClick={() => {
        if (!parcelsReading || "error" in parcelsReading) return
        post({ action: "ship", parcels: parcelsReading.parcels }, () => { setDialog(null); setNotice("Envío Andreani generado. Imprimí la etiqueta y pegala en el paquete.") })
      }}>{busy ? "Generando…" : "Generar envío"}</AdminPrimaryButton>
    </div>}>
      <AdminTextInput title="Cantidad de bultos" placeholder="Ej.: 2" inputMode="numeric" value={parcelInput} onChange={(value) => {
        const next = value.replace(/\D/g, "").slice(0, 2)
        setParcelInput(next)
        const count = Number(next)
        if (Number.isInteger(count) && count >= 1 && count <= 50) setParcelDrafts((current) => resizeParcelDrafts(current, count))
        actionKey.current = null
      }} className="h-14 text-2xl font-black" />
      {validParcels ? <ParcelMeasuresEditor drafts={parcelDrafts} disabled={busy} estimate={shippingInfo.estimate} onChange={(drafts) => { setParcelDrafts(drafts); actionKey.current = null }} /> : null}
      {dialogError && <p role="alert" className="mt-3 text-sm font-bold text-red-300">{dialogError}</p>}
    </AdminModal>
    <AdminModal open={dialog === "force"} compact title="Generar envío con pickeo incompleto" description={`Excepción de Super Admin: ${code} tiene ${units} de ${detail.expectedUnits} unidades pickeadas. Queda registrada con tu usuario y el motivo.`} onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2">
      <AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton>
      <AdminPrimaryButton disabled={busy || reason.trim().length < 10} onClick={() => post({ action: "ship", force: true, reason }, () => setDialog(null))}>Generar envío igual</AdminPrimaryButton>
    </div>}>
      <AdminTextarea title="Motivo obligatorio" value={reason} onChange={setReason} rows={3} maxLength={1000} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />
      {dialogError && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{dialogError}</p>}
    </AdminModal>
    <AdminModal open={dialog === "reset"} compact title="Reiniciar preparación" description="Se vuelven a escanear todas las unidades y se descartan las diferencias registradas en esta preparación." onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2">
      <AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton>
      <AdminPrimaryButton disabled={busy || reason.trim().length < 10} onClick={() => post({ action: "reset", reason }, () => { setDialog(null); setFeedback(null) })}>Confirmar</AdminPrimaryButton>
    </div>}>
      <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />
      {dialogError && <p role="alert" className="mt-2 text-sm font-bold text-red-300">{dialogError}</p>}
    </AdminModal>
    <DifferenceResolution key={dialog === "difference" ? "open" : "closed"} open={dialog === "difference"} lines={detail.lines} busy={busy} error={dialogError} onClose={() => setDialog(null)}
      onSubmit={(input: DifferenceInput) => post({ action: "adjust", ...input }, () => { setDialog(null); setNotice("Diferencia registrada.") })} />
    <AdminModal open={pendingVariant !== null} compact title="¿Qué variante física estás despachando?" description={`Código reconocido: ${pendingVariant?.productName ?? "producto"}. El código no identifica el color: elegí el que tenés en la mano.`} onClose={() => { setPendingVariant(null); variantKey.current = null }} footer={<div className="flex justify-end"><AdminButton disabled={busy} onClick={() => { setPendingVariant(null); variantKey.current = null }}>Cancelar</AdminButton></div>}>
      <div className="grid gap-2 sm:grid-cols-2">{pendingVariant?.candidates.map((candidate) => <AdminButton key={candidate.variantId} className="h-12 justify-start text-base" disabled={busy || !candidate.selectable} onClick={() => confirmVariant(candidate.variantId)}>
        <span className="inline-flex size-4 shrink-0 rounded-full ring-1 ring-white/30" style={{ background: candidate.colorHexSecondary && candidate.colorHex ? `linear-gradient(135deg, ${candidate.colorHex} 50%, ${candidate.colorHexSecondary} 50%)` : candidate.colorHex ?? "transparent" }} aria-hidden="true" />
        <span className="min-w-0 truncate">{candidate.name ?? `Variante #${candidate.variantId}`}</span>
        {candidate.assigned ? <span className="ml-auto text-xs text-white/60">Asignada</span> : !candidate.selectable ? <span className="ml-auto text-xs text-amber-200">Sin stock libre</span> : null}
      </AdminButton>)}</div>
    </AdminModal>
  </div>
}

/** Tabla del pedido: cantidades físicas y precios de venta visibles sólo con permiso. */
export function ProductLine({ item, line, adjusted }: { item: DispatchSaleItem; line?: OrderLine; adjusted: boolean }) {
  const picked = line?.scanned_quantity ?? 0
  const expected = line?.expected_quantity ?? item.orderedQuantity
  const complete = picked === expected
  const price = item.unitPrice
  return <tr className="dispatch-product-row">
    <td className="dispatch-product-sku" data-label="SKU">{item.sku ?? line?.expected_sku ?? "—"}</td>
    <td className="dispatch-product-name" data-label="Producto">{item.productName}</td>
    <td className="dispatch-product-variant" data-label="Variante">{line?.random?.dispatchedVariant ?? item.variantName ?? "—"}</td>
    <td className="dispatch-product-quantity" data-label="Cant. solicitada">{item.orderedQuantity}{adjusted && <small>Pedidas {item.orderedQuantity} · salen {expected}</small>}</td>
    <td data-label="Picking"><span className={`dispatch-pick-count ${complete ? "is-complete" : "is-missing"}`} aria-label={`${picked} pickeados de ${expected} esperados`}>{picked}/{expected}</span></td>
    <td className="dispatch-product-price" data-label="Precio unitario">{price == null ? "—" : money(price)}</td>
    <td className="dispatch-product-total" data-label="Total">{price == null ? "—" : money(price * expected)}</td>
  </tr>
}

/** Resultado del último escaneo, siempre visible junto al campo de lectura. */
function LastScan({ feedback }: { feedback: ScanFeedback | null }) {
  if (!feedback) return <p className="dispatch-last-scan text-xs text-white/50">Último escaneo: —</p>
  const Icon = feedback.tone === "error" ? XCircle : feedback.tone === "warning" ? AlertTriangle : CheckCircle2
  return <p role="status" data-tone={feedback.tone} className={`dispatch-last-scan flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs font-bold ${feedback.tone === "success" ? "bg-emerald-950 text-emerald-200" : feedback.tone === "warning" ? "bg-amber-950 text-amber-200" : "bg-red-950 text-red-200"}`}>
    <Icon className="mt-0.5 size-5 shrink-0" /><span className="min-w-0"><span className="block text-10px font-black uppercase tracking-widest opacity-70">Último escaneo</span>{feedback.message}</span>
  </p>
}
