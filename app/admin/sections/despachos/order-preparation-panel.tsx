"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import Link from "next/link"
import { CheckCircle2, PackageCheck, Printer, ScanLine, XCircle } from "lucide-react"

import { AdminBadge, AdminButton, AdminCard, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import { LabelPrintDialog } from "@/app/admin/components/label-print-dialog"
import { ADMIN_DISPATCH_CHANGED_EVENT } from "@/hooks/use-admin-notifications"
import { DISPATCH_STAGE_LABELS, orderCode, type DispatchShippingInfo, type OrderDispatchDetail } from "@/lib/admin/dispatch"
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

type ScanFeedback = { tone: "success" | "error"; message: string }
type OrderResponse = OrderDispatchDetail & { scan?: { orderItemId: number; scanned: number; expected: number; duplicate: boolean } | null }

const STAGE_TONE = { pending: "neutral", packing: "info", packed: "warning", parcels_ready: "success", in_batch: "info", batch_closed: "success", handed_over: "success" } as const

// Motor único de armado: Despachos y la solapa "ARMAR PEDIDO" del pedido usan
// este mismo panel contra las mismas RPC (scan_order_preparation_code y
// set_order_package_parcels). El escaneo sólo valida identidad: no mueve stock.
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
  const [dialog, setDialog] = useState<"parcels" | "reset" | "labels" | null>(null)
  const [parcelInput, setParcelInput] = useState("")
  const [parcelDrafts, setParcelDrafts] = useState<ParcelDraft[]>([])
  const [reason, setReason] = useState("")
  const scanKey = useRef<string | null>(null)
  const parcelsKey = useRef<string | null>(null)
  const resetKey = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
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

  function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = scan.trim()
    if (!code || busyRef.current) return
    scanKey.current ??= crypto.randomUUID()
    const requestKey = scanKey.current
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        const updated = await dispatchRequest<OrderResponse>(`/orders/${orderId}`, { action: "scan", code, requestKey })
        setDetail(updated)
        const line = updated.lines.find((item) => item.order_item_id === updated.scan?.orderItemId)
        setFeedback({ tone: "success", message: line ? `✓ ${line.name} · ${line.scanned_quantity} de ${line.expected_quantity}` : "✓ Producto verificado" })
        setScan(""); scanKey.current = null
      } catch (cause) {
        const retryable = cause instanceof DispatchRequestError && cause.retryable
        if (!retryable) { scanKey.current = null; setScan("") }
        setFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "No se pudo verificar el código." })
      } finally {
        busyRef.current = false
        setBusy(false)
        inputRef.current?.focus()
      }
    })()
  }

  if (loading && !detail) return <p role="status" className="text-sm text-white/70">Cargando armado…</p>
  if (!detail) return <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error || "No se pudo cargar el pedido."}</div>

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

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <AdminBadge tone={STAGE_TONE[detail.stage]}>{DISPATCH_STAGE_LABELS[detail.stage]}</AdminBadge>
      <span className="text-sm text-white/70">{detail.itemCount} productos · {units} de {detail.expectedUnits} unidades{parcelCount ? ` · ${parcelCount} ${parcelCount === 1 ? "bulto" : "bultos"}` : ""}</span>
    </div>
    {detail.blocked && <div role="alert" className="rounded-xl border border-red-500/50 bg-red-950 p-3 text-sm text-white">
      <p className="font-black">{inBatch ? "RETIRAR DEL DESPACHO" : "Pedido bloqueado"} · {detail.blockReason ?? "Revisión requerida"}</p>
      {inBatch && detail.parcels.length > 0 && <p className="mt-1 text-xs">Separá {detail.parcels.length === 1 ? "el bulto" : `los ${detail.parcels.length} bultos`}: {detail.parcels.map((parcel) => parcel.barcode).join(", ")}. No se entrega a Andreani ni se reintegra automáticamente.</p>}
    </div>}
    {error && <div role="alert" className="rounded-xl border border-red-500/35 bg-red-950 p-3 text-sm text-white">{error}</div>}

    <div className="space-y-2">{detail.lines.map((line) => {
      const complete = line.scanned_quantity === line.expected_quantity
      return <AdminCard key={line.order_item_id} className={`dispatch-card flex items-center justify-between gap-3 p-3 ${complete ? "border-emerald-500/40" : ""}`}>
        <span className="min-w-0 text-sm font-bold text-white">{line.name}<span className="block text-xs font-normal text-white/60">{line.random ? "Escaneá cualquier variante del grupo con stock" : [line.expected_sku, line.expected_barcode].filter(Boolean).join(" · ")}</span></span>
        <span className={`shrink-0 text-right text-2xl font-black tabular-nums ${complete ? "text-emerald-300" : "text-white"}`} aria-label={`${line.scanned_quantity} escaneados de ${line.expected_quantity} requeridos`}>{line.scanned_quantity}<span className="text-base text-white/50"> / {line.expected_quantity}</span></span>
      </AdminCard>
    })}</div>

    {!pkg ? <AdminPrimaryButton className="h-12 w-full text-base sm:w-auto" disabled={busy || detail.blocked} onClick={() => void run(async () => { setDetail(await dispatchRequest<OrderDispatchDetail>(`/orders/${orderId}`, { action: "start" })) })}>INICIAR ARMADO</AdminPrimaryButton>
      : !prepared ? <form onSubmit={submitScan} className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <ScanLine className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-beyonix-sky" />
          <input ref={inputRef} aria-label="Escanear o ingresar código / SKU" autoFocus autoComplete="off" value={scan} onChange={(event) => { setScan(event.target.value); scanKey.current = null }} placeholder="Escaneá el producto" disabled={detail.blocked} className="admin-control-input admin-ds-control h-14 w-full min-w-0 pl-12 pr-4 text-lg text-white outline-none" />
        </label>
        <AdminPrimaryButton type="submit" className="h-14 px-6 text-base" disabled={busy || !scan.trim() || detail.blocked}>Verificar</AdminPrimaryButton>
      </form>
      : !parcelCount ? <div className="rounded-xl border border-emerald-500/35 bg-emerald-950 p-4"><p className="font-black text-white">✓ Todas las unidades verificadas</p><p className="mt-1 text-sm text-white/70">{code} · {detail.expectedUnits} unidades</p><AdminPrimaryButton className="mt-3 h-12 text-base" disabled={busy || detail.blocked} onClick={openParcels}>FINALIZAR ARMADO</AdminPrimaryButton></div>
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

    {feedback && <p role="status" className={`flex items-center gap-2 text-base font-bold ${feedback.tone === "success" ? "text-emerald-300" : "text-red-300"}`}>{feedback.tone === "success" ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />}{feedback.message}</p>}
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
    <LabelPrintDialog open={dialog === "labels"} title="Etiquetas de bultos" description={`${code} · ${parcelLabels.length} ${parcelLabels.length === 1 ? "bulto" : "bultos"}`} labels={parcelLabels} onClose={() => setDialog(null)} />
  </div>
}
