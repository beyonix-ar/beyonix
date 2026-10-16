"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { AlertTriangle, ArrowRight, CheckCircle2, Info, Printer, XCircle } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_STAGE_LABELS, orderCode, type DispatchScanResult, type DispatchShippingInfo, type DispatchVariantCandidate, type OrderDispatchDetail } from "@/lib/admin/dispatch"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { CancellationResolution } from "./cancellation-resolution"
import { DispatchProgress } from "./dispatch-progress"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import { PhysicalIdentification } from "./physical-identification"
import {
  EstimateVsReal,
  initialParcelDrafts,
  ParcelMeasuresEditor,
  ParcelQuoteNotice,
  readParcelDrafts,
  resizeParcelDrafts,
  type ParcelDraft,
} from "./parcel-measures"
import { PreparationStep, preparationStepStates } from "./preparation-steps"
import { ScanField } from "./scan-field"

type ScanFeedback = { tone: "success" | "warning" | "error"; message: string }
type OrderResponse = OrderDispatchDetail & { scan?: DispatchScanResult | null }
/** Código de grupo en un renglón aleatorio: falta confirmar la variante física. */
type PendingVariant = { code: string; productName: string | null; candidates: DispatchVariantCandidate[] }
type OrderLine = OrderDispatchDetail["lines"][number]

export const DISPATCH_STAGE_TONE = { pending: "info", packing: "info", identify: "warning", measures: "info", parcels_ready: "success", in_batch: "info", batch_closed: "success", handed_over: "success" } as const

// Motor único de armado: Despachos y la solapa "ARMAR PEDIDO" del pedido usan
// este mismo panel contra las mismas RPC (scan_order_preparation_code y
// set_order_package_parcels). El escaneo valida identidad; sólo en venta
// aleatoria puede pasar la unidad a la variante física escaneada (la base
// mueve el stock de forma atómica y conserva la variante reservada).
const NO_SHIPPING_INFO: DispatchShippingInfo = { costsVisible: false, estimate: null, parcelQuote: null }
const formatMeasure = (value: number | null | undefined, digits = 1) =>
  value == null ? "—" : new Intl.NumberFormat("es-AR", { maximumFractionDigits: digits }).format(value)
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Preparación de un pedido en cuatro pasos: pickeo → identificar pedido
 * (BX-PREP) → medidas del paquete → listo para Bulto general. A la izquierda
 * (o abajo en pantallas angostas) el pedido y sus productos; a la derecha los
 * pasos, con la acción del paso actual.
 */
export function OrderPreparationPanel({ orderId, onDone, onReady, footer }: {
  orderId: number
  /** Cierre tras resolver una cancelación con armado. */
  onDone?: () => void
  /** Despachos: lleva el pedido listo a la selección del Bulto general. */
  onReady?: () => void
  footer?: ReactNode
}) {
  const [detail, setDetail] = useState<OrderDispatchDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null)
  const [scan, setScan] = useState("")
  const [dialog, setDialog] = useState<"parcels" | "reset" | "labels" | null>(null)
  const [parcelInput, setParcelInput] = useState("")
  const [parcelDrafts, setParcelDrafts] = useState<ParcelDraft[]>([])
  const [reason, setReason] = useState("")
  const [pendingVariant, setPendingVariant] = useState<PendingVariant | null>(null)
  const scanKey = useRef<string | null>(null)
  const variantKey = useRef<{ variantId: number; key: string } | null>(null)
  const parcelsKey = useRef<string | null>(null)
  const resetKey = useRef<string | null>(null)
  const busyRef = useRef(false)

  const load = useCallback(async () => {
    try { setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`)); setError("") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar el pedido.") }
    finally { setLoading(false) }
  }, [orderId])

  useEffect(() => { setLoading(true); setDetail(null); setFeedback(null); void load() }, [load])
  // La recotización con bultos reales corre después de guardar el armado:
  // Admin recarga una vez para ver el resultado (el operador no ve importes).
  const quotePending = Boolean(detail?.shipping?.costsVisible && detail.package?.parcel_count && !detail.shipping.parcelQuote?.current)
  useEffect(() => {
    if (!quotePending) return
    const timer = setTimeout(() => { if (!busyRef.current) void load() }, 5_000)
    return () => clearTimeout(timer)
  }, [quotePending, load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { if (!busyRef.current) void load() }, 200) }
    window.addEventListener(ADMIN_DISPATCH_CHANGED_EVENT, reload)
    return () => { if (timer) clearTimeout(timer); window.removeEventListener(ADMIN_DISPATCH_CHANGED_EVENT, reload) }
  }, [load])

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError("")
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.") }
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
    // La lectura de cámara queda en el campo: si la red falla, reintentar
    // (botón o una nueva lectura del mismo código) usa la misma clave.
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

  if (loading && !detail) return <p role="status" className="text-sm text-white/70">Cargando pedido…</p>
  if (!detail) return <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error || "No se pudo cargar el pedido."}</div>

  // Filtro de cancelación 1/2: cancelado con armado completo (dentro o fuera de un lote).
  if (detail.hold) return <CancellationResolution hold={detail.hold} onResolved={() => void load()} onClose={onDone ?? (() => void load())} />

  const pkg = detail.package
  const prepared = pkg?.status === "prepared"
  const parcelCount = pkg?.parcel_count ?? null
  const inBatch = Boolean(detail.membership)
  const units = detail.lines.reduce((sum, line) => sum + line.scanned_quantity, 0)
  const code = orderCode(detail.order.id)
  const shippingInfo = detail.shipping ?? NO_SHIPPING_INFO
  const parcelLabels = detail.parcels.map((parcel) => ({ kind: "parcel" as const, code: parcel.barcode, orderCode: code, index: parcel.parcel_index, count: parcel.parcel_count }))
  const openParcels = () => {
    parcelsKey.current = null
    const count = parcelCount ?? (shippingInfo.estimate?.parcels.length || 1)
    setParcelInput(String(count))
    setParcelDrafts(initialParcelDrafts(detail.parcels, count))
    setDialog("parcels")
  }
  const parcelValue = Number(parcelInput)
  const validParcels = Number.isInteger(parcelValue) && parcelValue >= 1 && parcelValue <= 50
  const parcelsReading = validParcels ? readParcelDrafts(parcelDrafts) : null

  if (detail.order.estado === "cancelado" || detail.order.cancelled_at || ["cancellation_requested", "refund_pending", "refunded"].includes(detail.order.financial_status ?? "")) {
    return <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-950/40 p-4 text-sm font-semibold text-white">
      Pedido cancelado — no requiere preparación
    </div>
  }

  // Factura o etiqueta pendientes no frenan el pickeo: sólo el ingreso al Bulto general.
  const packingBlocked = detail.packingBlocked
  const pendingBeforeDispatch = detail.pendingBeforeDispatch
  const startPacking = () => void run(async () => { setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "start" })) })
  const [pickState, identifyState, measureState, readyState] = preparationStepStates(detail.stage)
  const missingBeforeBundle = pendingBeforeDispatch.length ? pendingBeforeDispatch.join(" · ") : detail.blocked ? detail.blockReason ?? "Revisión requerida" : null
  const canChangeMeasures = detail.stage === "identify" || detail.stage === "parcels_ready" || detail.stage === "in_batch"

  return <div className="@container min-w-0 space-y-3">
    {packingBlocked && <div role="alert" className="rounded-xl border border-red-500/50 bg-red-950 p-3 text-sm text-white">
      <p className="font-black">{inBatch ? "RETIRAR DEL DESPACHO" : "Pedido bloqueado"} · {detail.blockReason ?? "Revisión requerida"}</p>
      {inBatch && detail.parcels.length > 0 && <p className="mt-1 text-xs">Separá {detail.parcels.length === 1 ? "el paquete de envío" : `los ${detail.parcels.length} paquetes de envío`}: {detail.parcels.map((parcel) => parcel.barcode).join(", ")}. No se entrega a Andreani ni se reintegra automáticamente.</p>}
    </div>}
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}

    <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)] @2xl:items-start @2xl:gap-4">
      {/* Pedido actual: resumen, avance y productos. En pantallas angostas va debajo de los pasos. */}
      <AdminCard className="dispatch-card order-last min-w-0 overflow-hidden p-0 @2xl:order-first">
        <div className="p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="block text-10px font-black uppercase tracking-widest text-sky-200/70">Pedido</span>
              <h3 className="text-2xl font-black tabular-nums text-white">{code}</h3>
              {detail.order.cliente_nombre && <p className="truncate text-sm text-white/65">{detail.order.cliente_nombre}</p>}
            </div>
            <AdminBadge tone={packingBlocked ? "danger" : DISPATCH_STAGE_TONE[detail.stage]}>{DISPATCH_STAGE_LABELS[detail.stage]}</AdminBadge>
          </div>
          <DispatchProgress className="mt-4" done={units} total={detail.expectedUnits} unit="unidades" />
          <p className="mt-2 text-xs font-bold text-white/60">{plural(detail.itemCount, "producto", "productos")}{parcelCount ? ` · ${plural(parcelCount, "paquete de envío", "paquetes de envío")}` : ""}</p>
        </div>
        <div className="dispatch-divider border-t">
          <p className="dispatch-subheading px-4 pt-3 sm:px-5">Productos <span>{detail.itemCount}</span></p>
          <ul className="dispatch-lines px-4 pb-1 sm:px-5" aria-label="Productos del pedido">{detail.lines.map((line) => <ProductLine key={line.order_item_id} line={line} />)}</ul>
        </div>
        {!packingBlocked && pendingBeforeDispatch.length > 0 && <p role="status" className="dispatch-divider flex items-start gap-2 border-t bg-sky-950/30 px-4 py-3 text-xs font-bold text-sky-100 sm:px-5">
          <Info className="mt-0.5 size-4 shrink-0" />{pendingBeforeDispatch.join(" · ")}: podés preparar el pedido igual; se completa antes de entrar al Bulto general.
        </p>}
      </AdminCard>

      {/* Pasos en orden: sólo el paso actual muestra su acción principal. */}
      <div className="order-first min-w-0 space-y-3 @2xl:sticky @2xl:top-4 @2xl:order-last">
        <ol className="dispatch-steps" aria-label="Pasos de preparación">
          <PreparationStep index={0} state={pickState} hint={pickState === "done" ? `${detail.expectedUnits} de ${detail.expectedUnits} unidades verificadas` : "Escaneá cada unidad del pedido."}>
            {!pkg ? <AdminPrimaryButton className="h-12 w-full justify-center text-base" disabled={busy || packingBlocked} onClick={startPacking}>Empezar pickeo</AdminPrimaryButton>
              : !prepared ? <div className="dispatch-scanner space-y-2">
                <ScanField label="Escanear o ingresar código / SKU" placeholder="Escaneá el producto" submitLabel="Verificar"
                  value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
                  busy={busy} disabled={packingBlocked} autoFocus={!pendingVariant && dialog === null}
                  cameraTitle={`Pickeo ${code}`} cameraHint="Encuadrá el código de barras del producto" continuousCamera feedback={feedback} />
                <LastScan feedback={feedback} />
              </div>
              : feedback ? <LastScan feedback={feedback} /> : null}
          </PreparationStep>

          <PreparationStep index={1} state={identifyState} hint={identifyState === "pending" ? "Se habilita al terminar el pickeo." : undefined}>
            {prepared && detail.preparedCode && pkg ? <PhysicalIdentification orderId={orderId} orderCode={code} preparedCode={detail.preparedCode}
              method={pkg.identification_method ?? null} identifiedAt={pkg.identified_at ?? null} units={detail.expectedUnits} parcelCount={parcelCount}
              disabled={packingBlocked} onUpdated={setDetail} /> : null}
          </PreparationStep>

          <PreparationStep index={2} state={measureState} hint={parcelCount ? null : measureState === "pending" ? "Primero identificá el pedido." : "Cantidad de paquetes, peso y medidas reales para Andreani."}>
            {parcelCount ? <section aria-label="Paquetes de envío">
              <ul className="space-y-1.5 text-sm text-white/80">{detail.parcels.map((parcel) => <li key={parcel.id}>
                <span className="font-mono text-xs font-bold text-white">{parcel.barcode} · Paquete {parcel.parcel_index}/{parcel.parcel_count}</span>
                {parcel.weight_kg != null ? <span className="block text-xs text-white/65">{formatMeasure(parcel.length_cm)} × {formatMeasure(parcel.width_cm)} × {formatMeasure(parcel.height_cm)} cm · {formatMeasure(parcel.weight_kg, 3)} kg</span> : <span className="block text-xs text-amber-200">Medidas no cargadas</span>}
              </li>)}</ul>
              <EstimateVsReal estimate={shippingInfo.estimate} parcels={detail.parcels} />
              <ParcelQuoteNotice shipping={shippingInfo} />
              <div className="mt-3 flex flex-wrap gap-2">
                <AdminButton size="sm" icon={<Printer className="size-4" />} disabled={!parcelLabels.length} onClick={() => setDialog("labels")}>Imprimir etiquetas de paquetes</AdminButton>
                {canChangeMeasures ? <AdminButton size="sm" variant="ghost" disabled={busy} onClick={openParcels}>Cambiar medidas</AdminButton> : null}
              </div>
            </section>
              : measureState === "current" ? <AdminPrimaryButton className="h-12 w-full justify-center text-base" disabled={busy || packingBlocked} onClick={openParcels}>Cargar medidas del paquete</AdminPrimaryButton> : null}
          </PreparationStep>

          <PreparationStep index={3} state={readyState} hint={inBatch && detail.batch ? `Ya está en el Bulto general ${detail.batch.code}.` : readyState === "pending" ? "Se habilita al completar los pasos anteriores." : missingBeforeBundle ? null : "Todo listo: el pedido puede entrar al Bulto general."}>
            {inBatch && detail.batch ? <Link href={`/admin/despachos?batch=${detail.batch.id}`} className="inline-flex items-center gap-1 text-sm font-bold text-beyonix-cyan underline">Abrir Bulto general {detail.batch.code}<ArrowRight className="size-4" /></Link>
              : readyState === "done" && missingBeforeBundle ? <p role="status" className="flex items-start gap-2 rounded-lg bg-amber-950/60 px-3 py-2 text-xs font-bold text-amber-100"><AlertTriangle className="mt-0.5 size-4 shrink-0" />Antes del Bulto general falta: {missingBeforeBundle}</p>
              : readyState === "done" && onReady ? <>
                <AdminPrimaryButton className="h-12 w-full justify-center text-base" icon={<ArrowRight className="size-4" />} onClick={onReady}>Pasar al Bulto general</AdminPrimaryButton>
                <p className="mt-1.5 text-xs text-white/55">Queda seleccionado en Listos para crear el Bulto general.</p>
              </> : null}
          </PreparationStep>
        </ol>
        {footer}
        {pkg && !inBatch && !detail.order.andreani_handed_over_at && <details className="px-1 text-xs text-white/60"><summary className="cursor-pointer">Más opciones</summary><AdminButton className="mt-2" size="sm" variant="ghost" onClick={() => { resetKey.current = null; setReason(""); setDialog("reset") }}>Reiniciar armado</AdminButton></details>}
      </div>
    </div>

    <AdminModal open={dialog === "parcels"} title="MEDIDAS DEL PAQUETE" description="¿Cuántos paquetes de envío salen con este pedido?" onClose={() => setDialog(null)} footer={<div className="flex flex-wrap items-center justify-end gap-2">{parcelsReading && "error" in parcelsReading ? <span className="mr-auto text-xs font-bold text-amber-200">{parcelsReading.error}</span> : null}<AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || !parcelsReading || "error" in parcelsReading} onClick={() => void run(async () => {
      if (!parcelsReading || "error" in parcelsReading) return
      parcelsKey.current ??= crypto.randomUUID()
      setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "parcels", parcels: parcelsReading.parcels, requestKey: parcelsKey.current }))
      parcelsKey.current = null
      setDialog("labels")
    })}>Confirmar paquetes</AdminPrimaryButton></div>}>
      <AdminTextInput title="Cantidad de paquetes" placeholder="Ej.: 2" inputMode="numeric" value={parcelInput} onChange={(value) => {
        const next = value.replace(/\D/g, "").slice(0, 2)
        setParcelInput(next)
        const count = Number(next)
        if (Number.isInteger(count) && count >= 1 && count <= 50) setParcelDrafts((current) => resizeParcelDrafts(current, count))
        parcelsKey.current = null
      }} className="h-14 text-2xl font-black" />
      <p className="mt-2 text-xs text-white/60">Contá las cajas o paquetes que salen. Cada paquete de envío lleva su propia etiqueta {code} y necesita su peso y medidas reales.</p>
      {validParcels ? <ParcelMeasuresEditor drafts={parcelDrafts} disabled={busy} estimate={shippingInfo.estimate} onChange={(drafts) => { setParcelDrafts(drafts); parcelsKey.current = null }} /> : null}
    </AdminModal>
    <AdminModal open={dialog === "reset"} compact title="Reiniciar armado" description="Se vuelven a escanear todas las unidades. Las etiquetas de paquetes anteriores quedan anuladas." onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || reason.trim().length < 10} onClick={() => void run(async () => {
      resetKey.current ??= crypto.randomUUID()
      setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "reset", reason, requestKey: resetKey.current }))
      resetKey.current = null; setDialog(null); setReason(""); setFeedback(null)
    })}>Confirmar</AdminPrimaryButton></div>}>
      <AdminTextInput title="Motivo obligatorio" value={reason} onChange={setReason} placeholder="Ingresá el motivo (mínimo 10 caracteres)" />
    </AdminModal>
    <AdminModal open={pendingVariant !== null} compact title="¿Qué variante física estás despachando?" description={`Código reconocido: ${pendingVariant?.productName ?? "producto"}. El código no identifica el color: elegí el que tenés en la mano.`} onClose={() => { setPendingVariant(null); variantKey.current = null }} footer={<div className="flex justify-end"><AdminButton disabled={busy} onClick={() => { setPendingVariant(null); variantKey.current = null }}>Cancelar</AdminButton></div>}>
      <div className="grid gap-2 sm:grid-cols-2">{pendingVariant?.candidates.map((candidate) => <AdminButton key={candidate.variantId} className="h-12 justify-start text-base" disabled={busy || !candidate.selectable} onClick={() => confirmVariant(candidate.variantId)}>
        <span className="inline-flex size-4 shrink-0 rounded-full ring-1 ring-white/30" style={{ background: candidate.colorHexSecondary && candidate.colorHex ? `linear-gradient(135deg, ${candidate.colorHex} 50%, ${candidate.colorHexSecondary} 50%)` : candidate.colorHex ?? "transparent" }} aria-hidden="true" />
        <span className="min-w-0 truncate">{candidate.name ?? `Variante #${candidate.variantId}`}</span>
        {candidate.assigned ? <span className="ml-auto text-xs text-white/60">Asignada</span> : !candidate.selectable ? <span className="ml-auto text-xs text-amber-200">Sin stock libre</span> : null}
      </AdminButton>)}</div>
    </AdminModal>
    <LabelPrintDialog open={dialog === "labels"} title="Etiquetas de paquetes de envío" description={`${code} · ${parcelLabels.length} ${parcelLabels.length === 1 ? "paquete" : "paquetes"}`} labels={parcelLabels} onClose={() => setDialog(null)} />
  </div>
}

/** Renglón operativo: producto, código, esperado vs. pickeado y estado. */
function ProductLine({ line }: { line: OrderLine }) {
  const { scanned_quantity: picked, expected_quantity: expected } = line
  const status = picked > expected ? { label: "Con diferencia", tone: "danger" as const }
    : picked === expected ? { label: "Completo", tone: "success" as const }
    : picked > 0 ? { label: `Faltan ${expected - picked}`, tone: "warning" as const }
    : { label: "Pendiente", tone: "neutral" as const }
  const complete = status.tone === "success"
  return <li className="dispatch-line flex items-center gap-3 py-3" data-status={status.tone}>
    {complete ? <CheckCircle2 className="size-5 shrink-0 text-emerald-300" aria-hidden="true" /> : <span aria-hidden="true" className="size-5 shrink-0 rounded-full border-2 border-white/25" />}
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-bold text-white">{line.name}</span>
      <span className="block truncate text-xs text-white/60">{line.random ? <>Reservado: {line.random.reservedVariant ?? "—"} · {line.random.dispatchedVariant ? <span className="font-bold text-emerald-300">Despachado: {line.random.dispatchedVariant}{line.random.manuallyConfirmed ? " (confirmado a mano)" : ""}</span> : "Escaneá la variante física que sale"}</> : [line.expected_sku, line.expected_barcode].filter(Boolean).join(" · ") || "Sin código"}</span>
    </span>
    <span className="flex shrink-0 flex-col items-end gap-1">
      <span className={`text-lg font-black leading-none tabular-nums ${complete ? "text-emerald-300" : "text-white"}`} aria-label={`${picked} pickeados de ${expected} esperados`}>{picked}<span className="text-sm text-white/50"> / {expected}</span></span>
      <AdminBadge tone={status.tone}>{status.label}</AdminBadge>
    </span>
  </li>
}

/** Resultado del último escaneo, siempre visible junto al campo de lectura. */
function LastScan({ feedback }: { feedback: ScanFeedback | null }) {
  if (!feedback) return <p className="text-xs text-white/50">Último escaneo: —</p>
  const Icon = feedback.tone === "error" ? XCircle : feedback.tone === "warning" ? AlertTriangle : CheckCircle2
  return <p role="status" className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-bold ${feedback.tone === "success" ? "bg-emerald-950 text-emerald-200" : feedback.tone === "warning" ? "bg-amber-950 text-amber-200" : "bg-red-950 text-red-200"}`}>
    <Icon className="mt-0.5 size-5 shrink-0" /><span className="min-w-0"><span className="block text-10px font-black uppercase tracking-widest opacity-70">Último escaneo</span>{feedback.message}</span>
  </p>
}
