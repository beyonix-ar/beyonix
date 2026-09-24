"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useAuth } from "@/context/auth-context"
import { getAdminCapabilities } from "@/lib/admin/admin-capabilities"
import { AdminRequestError } from "@/lib/admin/request-error"
import { supabase } from "@/lib/supabase/client"
import type { RegisteredReplacement, ReplacementLoadState } from "@/lib/orders/claim-replacement-flow"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminModal, AdminPrimaryButton, AdminSecondaryButton } from "../../components/admin-controls"

type Variant = { id: number; nombre: string; sku: string | null; stock: number; productos: { nombre: string } | { nombre: string }[] }
type Replacement = RegisteredReplacement & { id: number; original_order_id: number; claim_id: number | null; replacement_variant_id: number; reason: string; unit_cost: number | null; created_at: string; notes: string | null }
type ReplacementData = { replacements: Replacement[]; variants: Variant[] }

async function requestReplacements(orderId: number, search: string, body?: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error("Tu sesión venció. Volvé a iniciar sesión.")
  const response = await fetch(`/api/admin/pedidos/${orderId}/replacements?search=${encodeURIComponent(search)}`, {
    method: body ? "POST" : "GET", signal: AbortSignal.timeout(25_000), cache: "no-store",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) throw new AdminRequestError(response.status, data.error || "No se pudo completar la operación. Recargá los datos.")
  if (!body && (!Array.isArray(data.replacements) || !Array.isArray(data.variants))) throw new Error("No se pudieron verificar los reemplazos. Reintentá.")
  return data as ReplacementData
}

interface OrderReplacementsProps {
  pedido: SupabasePedido
  onUpdated: () => Promise<void>
  /** Informa los reemplazos ya cargados (null si no se pudieron cargar) para mostrar el progreso del reclamo sin otro fetch. */
  onReplacementsChange?: (replacements: RegisteredReplacement[] | null, state: ReplacementLoadState) => void
}

export function OrderReplacements(props: OrderReplacementsProps) {
  const { user } = useAuth()
  const allowed = getAdminCapabilities(user?.rol).canManageReplacements
  return allowed ? <OrderReplacementManager {...props} /> : null
}

export function OrderReplacementManager({ pedido, onUpdated, onReplacementsChange }: OrderReplacementsProps) {
  const [data, setData] = useState<ReplacementData | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [search, setSearch] = useState("")
  const [itemId, setItemId] = useState("")
  const [variantId, setVariantId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [warranty, setWarranty] = useState(false)
  const [reason, setReason] = useState("")
  const attempt = useRef<{ key: string; payload: Record<string, unknown> } | null>(null)
  const inFlight = useRef(false)
  const loadVersion = useRef({ value: 0 })
  const onReplacementsChangeRef = useRef(onReplacementsChange)
  useEffect(() => { onReplacementsChangeRef.current = onReplacementsChange })
  const load = useCallback(async () => {
    const version = ++loadVersion.current.value
    setLoading(true); setError("")
    onReplacementsChangeRef.current?.(null, "loading")
    try {
      const next = await requestReplacements(pedido.id, search)
      if (version === loadVersion.current.value) {
        setData(next)
        onReplacementsChangeRef.current?.(next.replacements, "ready")
      }
    }
    catch (cause) { if (version === loadVersion.current.value) {
      setData(null); setError(cause instanceof Error ? cause.message : "No se pudieron cargar los reemplazos.")
      onReplacementsChangeRef.current?.(null, "error")
    } }
    finally { if (version === loadVersion.current.value) setLoading(false) }
  }, [pedido.id, search])
  useEffect(() => {
    const generation = loadVersion.current
    onReplacementsChangeRef.current?.(null, "loading")
    const timer = setTimeout(() => void load(), 300)
    return () => { clearTimeout(timer); generation.value++; onReplacementsChangeRef.current?.(null, "loading") }
  }, [load])
  const item = pedido.orden_items?.find((candidate) => candidate.id === Number(itemId))
  const matchingClaims = (pedido.order_claims ?? []).filter((claim) =>
    claim.resolution === "cambio_producto" && !["cerrado", "rechazado"].includes(claim.status) &&
    claim.affected_items?.some((affected) => affected.order_item_id === item?.id && affected.quantity > 0))
  const variant = data?.variants.find((candidate) => candidate.id === Number(variantId))
  const used = data?.replacements.filter((row) => row.original_order_item_id === item?.id).reduce((sum, row) => sum + row.quantity, 0) || 0
  const received = Number(item?.return_restocked_quantity || 0) + Number(item?.return_written_off_quantity || 0)
  const availableOriginal = Math.max(0, Math.min(Number(item?.cantidad || 0), warranty ? Number(item?.cantidad || 0) : received) - used)
  const count = Number(quantity)
  const valid = Boolean(item && variant && matchingClaims.length <= 1 && Number.isInteger(count) && count > 0 && count <= availableOriginal && count <= variant.stock && reason.trim().length >= 10 && !loading)
  const submit = async () => {
    if (inFlight.current || (!attempt.current && !valid)) return
    if (!attempt.current && item && variant) attempt.current = { key: crypto.randomUUID(), payload: {
      orderItemId: item.id, replacementVariantId: variant.id, quantity: count,
      ...(matchingClaims.length === 1 ? { claimId: matchingClaims[0].id } : {}),
      reason: warranty ? "garantia" : item.variante_id === variant.id ? "mismo_producto" : "otro_producto", notes: reason.trim(),
    } }
    if (!attempt.current) return
    inFlight.current = true; setSaving(true); setError("")
    try {
      await requestReplacements(pedido.id, "", { ...attempt.current.payload, idempotencyKey: attempt.current.key })
      attempt.current = null; setOpen(false); setConfirm(false)
      await load(); await onUpdated()
    } catch (cause) {
      if (cause instanceof AdminRequestError && [400, 403, 409].includes(cause.status)) { attempt.current = null; setConfirm(false) }
      setError(cause instanceof Error ? cause.message : "No se pudo registrar. Reintentá la misma operación.")
    }
    finally { setSaving(false); inFlight.current = false }
  }
  return <section id={`order-replacements-${pedido.id}`} className="my-3 rounded-xl border border-white/15 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Reemplazos del pedido</h3><AdminSecondaryButton onClick={() => { setOpen(true); setConfirm(false) }}>Registrar reemplazo</AdminSecondaryButton></div>
    {loading && <p role="status">Cargando reemplazos…</p>}
    {error && <p role="alert" className="my-2 text-red-200">{error} <button type="button" onClick={() => void load()} className="underline">Recargar datos</button></p>}
    {!loading && !error && data?.replacements.length === 0 && <p className="mt-2 text-sm">Todavía no hay reemplazos registrados.</p>}
    <ul className="mt-3 space-y-2 text-sm">{data?.replacements.map((row) => <li key={row.id} className="rounded border border-white/10 p-2">{new Date(row.created_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })} · {row.quantity} unidades · {row.reason === "garantia" ? "Garantía" : "Cambio"} · Variante #{row.replacement_variant_id}<p>{row.notes}</p><p>Costo económico registrado: {row.unit_cost == null ? "No disponible" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(row.unit_cost * row.quantity)}</p><p>Salida de stock registrada. Coordiná la entrega del reemplazo; esto no crea un envío ni reutiliza la etiqueta del pedido original.</p></li>)}</ul>
    <AdminModal open={open} title={`Reemplazo del pedido #${pedido.id}`} onClose={() => { if (!saving) setOpen(false) }} footer={<div className="flex flex-wrap justify-end gap-2"><AdminSecondaryButton disabled={saving} onClick={() => setOpen(false)}>Cerrar</AdminSecondaryButton><AdminPrimaryButton disabled={saving || (!attempt.current && !valid)} onClick={() => { if (confirm || attempt.current) void submit(); else setConfirm(true) }}>{saving ? "Registrando…" : confirm || attempt.current ? "Confirmar retiro de stock" : "Revisar reemplazo"}</AdminPrimaryButton></div>}>
      <div className="space-y-3 text-sm">
        {error && <p role="alert" className="text-red-200">{error}</p>}
        <fieldset disabled={saving || confirm || Boolean(attempt.current)} className="grid gap-3">
          <label>Ítem original<select className="block w-full rounded bg-[#101820] p-2" value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">Elegir producto vendido</option>{pedido.orden_items?.map((row) => <option key={row.id} value={row.id}>{row.productos?.nombre} · {row.producto_variantes?.nombre} · Vendió {row.cantidad}</option>)}</select></label>
          <p>Recibimos {received} · Ya reemplazadas {used} · Disponibles para reemplazar {availableOriginal}</p>
          <label><input type="checkbox" checked={warranty} onChange={(event) => setWarranty(event.target.checked)} /> Garantía sin exigir recepción física previa</label>
          <label>Motivo (mínimo 10 caracteres)<textarea className="block w-full rounded bg-[#101820] p-2" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <label>Buscar variante por nombre<input className="block w-full rounded bg-[#101820] p-2" value={search} onChange={(event) => { setSearch(event.target.value); setVariantId("") }} /></label>
          <label>Producto / variante de reemplazo<select className="block w-full rounded bg-[#101820] p-2" value={variantId} onChange={(event) => setVariantId(event.target.value)}><option value="">Elegir variante (hasta 100 resultados)</option>{data?.variants.map((row) => <option key={row.id} value={row.id}>{(Array.isArray(row.productos) ? row.productos[0] : row.productos)?.nombre} · {row.nombre} · {row.sku} · Stock {row.stock}</option>)}</select></label>
          <label>Cantidad<input className="block w-full rounded bg-[#101820] p-2" type="number" min={1} max={Math.min(availableOriginal, variant?.stock || 0)} value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <p>Stock vendible normal: {variant?.stock ?? "Elegí una variante"} · Stock resultante: {variant && Number.isInteger(count) ? variant.stock - count : "—"}. El servidor valida el stock nuevamente y registra el costo histórico.</p>
        </fieldset>
        {confirm && <div role="status" className="rounded border border-amber-300/40 p-3">Vas a retirar {count} unidades de SKU {variant?.sku || variant?.nombre} para reemplazar {count} unidades del pedido #{pedido.id}. No se genera un cobro ni un envío automático.{!attempt.current && <button className="ml-2 underline" type="button" onClick={() => setConfirm(false)}>Corregir</button>}</div>}
        {attempt.current && <p>Hay un intento pendiente de confirmar. El reintento conserva la misma operación para no descontar stock dos veces.</p>}
      </div>
    </AdminModal>
  </section>
}
