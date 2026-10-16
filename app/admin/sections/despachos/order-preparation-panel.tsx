"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Info, PackageCheck, Printer, XCircle } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_STAGE_LABELS, orderCode, type DispatchScanResult, type DispatchShippingInfo, type DispatchVariantCandidate, type OrderDispatchDetail } from "@/lib/admin/dispatch"
import { playScanFeedback } from "@/lib/admin/scan-feedback"
import { CancellationResolution } from "./cancellation-resolution"
import { DispatchProgress } from "./dispatch-progress"
import { DispatchRequestError, dispatchRequest } from "./dispatch-request"
import {
  EstimateVsReal,
  initialParcelDrafts,
  ParcelMeasuresEditor,
  ParcelQuoteNotice,
  readParcelDrafts,
  resizeParcelDrafts,
  type ParcelDraft,
} from "./parcel-measures"
import { ScanField } from "./scan-field"

type ScanFeedback = { tone: "success" | "warning" | "error"; message: string }
type OrderResponse = OrderDispatchDetail & { scan?: DispatchScanResult | null }
/** Código de grupo en un renglón aleatorio: falta confirmar la variante física. */
type PendingVariant = { code: string; productName: string | null; candidates: DispatchVariantCandidate[] }

export const DISPATCH_STAGE_TONE = { pending: "info", packing: "info", packed: "success", parcels_ready: "success", in_batch: "info", batch_closed: "success", handed_over: "success" } as const

// Motor único de armado: Despachos y la solapa "ARMAR PEDIDO" del pedido usan
// este mismo panel contra las mismas RPC (scan_order_preparation_code y
// set_order_package_parcels). El escaneo valida identidad; sólo en venta
// aleatoria puede pasar la unidad a la variante física escaneada (la base
// mueve el stock de forma atómica y conserva la variante reservada).
const NO_SHIPPING_INFO: DispatchShippingInfo = { costsVisible: false, estimate: null, parcelQuote: null }
const formatMeasure = (value: number | null | undefined, digits = 1) =>
  value == null ? "—" : new Intl.NumberFormat("es-AR", { maximumFractionDigits: digits }).format(value)

export function OrderPreparationPanel({ orderId, onDone, footer }: {
  orderId: number
  onDone?: () => void
  footer?: ReactNode
}) {
  const [detail, setDetail] = useState<OrderDispatchDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null)
  const [scan, setScan] = useState("")
  const [dialog, setDialog] = useState<"parcels" | "reset" | "labels" | "prepared-label" | null>(null)
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

  if (loading && !detail) return <p role="status" className="text-sm text-white/70">Cargando armado…</p>
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
  const preparedLabels = detail.preparedCode ? [{ kind: "prepared" as const, code: detail.preparedCode, orderCode: code, units: detail.expectedUnits, parcelCount }] : []
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

  // Factura o etiqueta pendientes no frenan el pickeo: sólo el ingreso al lote.
  const packingBlocked = detail.packingBlocked
  const pendingBeforeDispatch = detail.pendingBeforeDispatch
  const startPacking = () => void run(async () => { setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "start" })) })

  return <div className="space-y-4">
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start">
      <div className="min-w-0 space-y-3">
        <AdminCard className="dispatch-card p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AdminBadge tone={packingBlocked ? "danger" : DISPATCH_STAGE_TONE[detail.stage]}>{DISPATCH_STAGE_LABELS[detail.stage]}</AdminBadge>
            <span className="text-xs font-bold text-white/60">{detail.itemCount} {detail.itemCount === 1 ? "producto" : "productos"} · {detail.expectedUnits} {detail.expectedUnits === 1 ? "unidad" : "unidades"}{parcelCount ? ` · ${parcelCount} ${parcelCount === 1 ? "bulto" : "bultos"}` : ""}</span>
          </div>
          <DispatchProgress className="mt-3" done={units} total={detail.expectedUnits} unit="unidades" />
        </AdminCard>

        {packingBlocked && <div role="alert" className="rounded-xl border border-red-500/50 bg-red-950 p-3 text-sm text-white">
          <p className="font-black">{inBatch ? "RETIRAR DEL DESPACHO" : "Pedido bloqueado"} · {detail.blockReason ?? "Revisión requerida"}</p>
          {inBatch && detail.parcels.length > 0 && <p className="mt-1 text-xs">Separá {detail.parcels.length === 1 ? "el bulto" : `los ${detail.parcels.length} bultos`}: {detail.parcels.map((parcel) => parcel.barcode).join(", ")}. No se entrega a Andreani ni se reintegra automáticamente.</p>}
        </div>}
        {!packingBlocked && pendingBeforeDispatch.length > 0 && <p role="status" className="flex items-start gap-2 rounded-xl border border-sky-500/30 bg-sky-950/50 px-3 py-2 text-xs font-bold text-sky-100">
          <Info className="mt-0.5 size-4 shrink-0" />{pendingBeforeDispatch.join(" · ")}: podés preparar el pedido igual; se completa antes de entrar al lote.
        </p>}
        {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}

        <ul className="space-y-2" aria-label="Productos del pedido">{detail.lines.map((line) => {
          const complete = line.scanned_quantity === line.expected_quantity
          const remaining = line.expected_quantity - line.scanned_quantity
          return <li key={line.order_item_id}>
            <AdminCard className={`dispatch-card flex items-center justify-between gap-3 p-3 ${complete ? "border-emerald-500/40" : ""}`}>
              <span className="flex min-w-0 items-start gap-2.5">
                {complete ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-300" aria-label="Completo" /> : <span aria-hidden="true" className="mt-1 size-4 shrink-0 rounded-full border-2 border-white/25" />}
                <span className="min-w-0 text-sm font-bold text-white">{line.name}<span className="block text-xs font-normal text-white/60">{line.random ? <>Reservado: {line.random.reservedVariant ?? "—"} · {line.random.dispatchedVariant ? <span className="font-bold text-emerald-300">Despachado: {line.random.dispatchedVariant}{line.random.manuallyConfirmed ? " (confirmado a mano)" : ""}</span> : "Escaneá la variante física que sale"}</> : [line.expected_sku, line.expected_barcode].filter(Boolean).join(" · ")}</span>
                  {!complete && <span className="mt-1 inline-block rounded-md bg-amber-500/15 px-1.5 py-0.5 text-10px font-black uppercase tracking-wide text-amber-200">Faltan {remaining}</span>}
                </span>
              </span>
              <span className={`shrink-0 text-right text-2xl font-black tabular-nums ${complete ? "text-emerald-300" : "text-white"}`} aria-label={`${line.scanned_quantity} escaneados de ${line.expected_quantity} requeridos`}>{line.scanned_quantity}<span className="text-base text-white/50"> / {line.expected_quantity}</span></span>
            </AdminCard>
          </li>
        })}</ul>
      </div>

      {/* Acción principal: en desktop a la derecha; en celular fija abajo, a una mano. */}
      <div className={`space-y-3 lg:sticky lg:top-4 ${pkg && !prepared ? "dispatch-action-bar" : ""}`}>
        {!pkg ? <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
          <p className="text-sm text-white/75">Empezá a pickear: cada unidad se verifica escaneando su código.</p>
          <AdminPrimaryButton className="h-14 w-full text-base" disabled={busy || packingBlocked} onClick={startPacking}>INICIAR ARMADO</AdminPrimaryButton>
        </AdminCard>
          : !prepared ? <AdminCard className="dispatch-card space-y-3 p-3 sm:p-4">
            <ScanField label="Escanear o ingresar código / SKU" placeholder="Escaneá el producto" submitLabel="Verificar"
              value={scan} onChange={(value) => { setScan(value); scanKey.current = null }} onScan={submitScan}
              busy={busy} disabled={packingBlocked} autoFocus={!pendingVariant && dialog === null}
              cameraTitle={`Armado ${code}`} cameraHint="Encuadrá el código de barras del producto" continuousCamera feedback={feedback} />
            <LastScan feedback={feedback} />
          </AdminCard>
          : <>
          {/* La última lectura (la que completó el pedido) sigue a la vista. */}
          {feedback && <LastScan feedback={feedback} />}
          {!parcelCount ? <div className="rounded-xl border border-emerald-500/35 bg-emerald-950 p-4">
            <p className="font-black text-white">✓ Todas las unidades verificadas</p>
            <p className="mt-1 text-sm text-white/70">{code} · {detail.expectedUnits} unidades</p>
            <AdminPrimaryButton className="mt-3 h-12 w-full text-base" disabled={busy || packingBlocked} onClick={openParcels}>FINALIZAR ARMADO</AdminPrimaryButton>
          </div>
          : <div className="rounded-xl border border-emerald-500/35 bg-emerald-950 p-4">
            <p className="font-black text-white"><PackageCheck className="mr-1 inline size-5" /> Armado completo · {parcelCount} {parcelCount === 1 ? "bulto" : "bultos"}</p>
            <ul className="mt-2 space-y-1 text-sm text-white/80">{detail.parcels.map((parcel) => <li key={parcel.id}><span className="font-mono">{parcel.barcode} · Bulto {parcel.parcel_index}/{parcel.parcel_count}</span>{parcel.weight_kg != null ? <span className="block text-xs text-white/65">{formatMeasure(parcel.length_cm)} × {formatMeasure(parcel.width_cm)} × {formatMeasure(parcel.height_cm)} cm · {formatMeasure(parcel.weight_kg, 3)} kg</span> : <span className="block text-xs text-amber-200">Medidas no cargadas</span>}</li>)}</ul>
            <EstimateVsReal estimate={shippingInfo.estimate} parcels={detail.parcels} />
            <ParcelQuoteNotice shipping={shippingInfo} />
            <div className="mt-3 flex flex-wrap gap-2">
              <AdminPrimaryButton icon={<Printer className="size-4" />} disabled={!parcelLabels.length} onClick={() => setDialog("labels")}>Imprimir etiquetas de bultos</AdminPrimaryButton>
              {detail.stage === "parcels_ready" || detail.stage === "in_batch" ? <AdminButton disabled={busy} onClick={openParcels}>Cambiar bultos</AdminButton> : null}
              {onDone && <AdminButton onClick={onDone}>Listo</AdminButton>}
            </div>
          </div>}
          </>}

        {detail.preparedCode && <AdminCard className="dispatch-card flex items-center justify-between gap-3 p-3">
          <span className="min-w-0">
            <span className="block text-10px font-black uppercase tracking-widest text-white/55">Código del pedido preparado</span>
            <span className="block truncate font-mono text-base font-black text-white">{detail.preparedCode}</span>
          </span>
          <AdminButton size="sm" icon={<Printer className="size-4" />} onClick={() => setDialog("prepared-label")}>Imprimir</AdminButton>
        </AdminCard>}
      </div>
    </div>

    {detail.batch && <Link href={`/admin/despachos?batch=${detail.batch.id}`} className="inline-block text-sm font-bold text-beyonix-cyan underline">Abrir lote {detail.batch.code}</Link>}
    {pkg && !inBatch && !detail.order.andreani_handed_over_at && <details className="text-sm text-white/70"><summary className="cursor-pointer">Opciones</summary><AdminButton className="mt-2" size="sm" variant="ghost" onClick={() => { resetKey.current = null; setReason(""); setDialog("reset") }}>Reiniciar armado</AdminButton></details>}
    {footer}

    <AdminModal open={dialog === "parcels"} title="FINALIZAR ARMADO" description="¿Cuántos bultos tiene este pedido?" onClose={() => setDialog(null)} footer={<div className="flex flex-wrap items-center justify-end gap-2">{parcelsReading && "error" in parcelsReading ? <span className="mr-auto text-xs font-bold text-amber-200">{parcelsReading.error}</span> : null}<AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || !parcelsReading || "error" in parcelsReading} onClick={() => void run(async () => {
      if (!parcelsReading || "error" in parcelsReading) return
      parcelsKey.current ??= crypto.randomUUID()
      setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "parcels", parcels: parcelsReading.parcels, requestKey: parcelsKey.current }))
      parcelsKey.current = null
      setDialog("labels")
    })}>Confirmar bultos</AdminPrimaryButton></div>}>
      <AdminTextInput title="Cantidad de bultos" placeholder="Ej.: 2" inputMode="numeric" value={parcelInput} onChange={(value) => {
        const next = value.replace(/\D/g, "").slice(0, 2)
        setParcelInput(next)
        const count = Number(next)
        if (Number.isInteger(count) && count >= 1 && count <= 50) setParcelDrafts((current) => resizeParcelDrafts(current, count))
        parcelsKey.current = null
      }} className="h-14 text-2xl font-black" />
      <p className="mt-2 text-xs text-white/60">Contá las cajas o paquetes que salen. Cada bulto lleva su propia etiqueta {code} y necesita su peso y medidas reales.</p>
      {validParcels ? <ParcelMeasuresEditor drafts={parcelDrafts} disabled={busy} estimate={shippingInfo.estimate} onChange={(drafts) => { setParcelDrafts(drafts); parcelsKey.current = null }} /> : null}
    </AdminModal>
    <AdminModal open={dialog === "reset"} compact title="Reiniciar armado" description="Se vuelven a escanear todas las unidades. Las etiquetas de bultos anteriores quedan anuladas." onClose={() => setDialog(null)} footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setDialog(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || reason.trim().length < 10} onClick={() => void run(async () => {
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
    <LabelPrintDialog open={dialog === "labels"} title="Etiquetas de bultos" description={`${code} · ${parcelLabels.length} ${parcelLabels.length === 1 ? "bulto" : "bultos"}`} labels={parcelLabels} onClose={() => setDialog(null)} />
    <LabelPrintDialog open={dialog === "prepared-label"} title="Código del pedido preparado" description={`${code} · ${detail.preparedCode ?? ""}`} labels={preparedLabels} onClose={() => setDialog(null)} />
  </div>
}

/** Resultado del último escaneo, siempre visible junto al campo de lectura. */
function LastScan({ feedback }: { feedback: ScanFeedback | null }) {
  if (!feedback) return <p className="text-xs text-white/50">Último escaneo: —</p>
  const Icon = feedback.tone === "error" ? XCircle : feedback.tone === "warning" ? AlertTriangle : CheckCircle2
  return <p role="status" className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-bold ${feedback.tone === "success" ? "bg-emerald-950 text-emerald-200" : feedback.tone === "warning" ? "bg-amber-950 text-amber-200" : "bg-red-950 text-red-200"}`}>
    <Icon className="mt-0.5 size-5 shrink-0" /><span className="min-w-0"><span className="block text-10px font-black uppercase tracking-widest opacity-70">Último escaneo</span>{feedback.message}</span>
  </p>
}
