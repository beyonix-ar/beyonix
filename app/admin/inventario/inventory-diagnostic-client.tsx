"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Wrench } from "lucide-react"

import { supabase } from "@/lib/supabase/client"

interface VariantDiagnostic {
  product_id: number
  product_name: string
  variant_id: number
  variant_name: string
  variant_sku: string | null
  actual_stock: number
  calculated_stock: number
  expected_stock: number
  difference: number
  duplicated_allocation: number
  possible_cause_movement_id: string | null
  possible_cause_at: string | null
  possible_cause: string | null
}

interface DiagnosticPayload {
  integrity: Record<string, unknown> | null
  variants: VariantDiagnostic[]
  movements: Array<Record<string, unknown>>
  repairs: Array<Record<string, unknown>>
  generatedAt: string
}

async function accessToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function date(value: unknown) {
  const parsed = new Date(String(value ?? ""))
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("es-AR")
}

export function InventoryDiagnosticClient({ productId }: { productId: number | null }) {
  const [data, setData] = useState<DiagnosticPayload | null>(null)
  const [loading, setLoading] = useState(Boolean(productId))
  const [repairing, setRepairing] = useState(false)
  const [error, setError] = useState("")
  const [confirmation, setConfirmation] = useState("")

  const load = useCallback(async () => {
    if (!productId) return
    setLoading(true)
    setError("")
    try {
      const token = await accessToken()
      if (!token) throw new Error("La sesión administrativa venció.")
      const response = await fetch(
        `/api/admin/inventory/diagnostics?productId=${productId}`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || "No se pudo cargar el diagnóstico.")
      setData(payload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el diagnóstico.")
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void load()
  }, [load])

  const repairable = data?.variants.find(
    (variant) => variant.duplicated_allocation > 0 && variant.possible_cause_movement_id,
  )

  const repair = async () => {
    if (!productId || !repairable || repairing || confirmation !== "RECONCILIAR") return
    setRepairing(true)
    setError("")
    try {
      const token = await accessToken()
      if (!token) throw new Error("La sesión administrativa venció.")
      const response = await fetch("/api/admin/inventory/diagnostics", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          productId,
          variantId: repairable.variant_id,
          confirmed: true,
          confirmationText: confirmation,
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || "No se pudo reparar el inventario.")
      setConfirmation("")
      await load()
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : "No se pudo reparar el inventario.")
    } finally {
      setRepairing(false)
    }
  }

  if (!productId) {
    return <main className="p-6 text-white">Indicá un producto desde una alerta de integridad.</main>
  }

  return (
    <main className="space-y-5 p-4 text-white md:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-beyonix-cyan">Inventario</p>
          <h1 className="mt-1 text-2xl font-black">Diagnóstico y reparación</h1>
        </div>
        <Link href="/admin/productos" className="flex items-center gap-2 rounded-xl border border-white/12 px-3 py-2 text-sm font-bold">
          <ArrowLeft className="size-4" /> Productos
        </Link>
      </div>

      {loading ? <div className="flex items-center gap-2 text-white/65"><Loader2 className="size-4 animate-spin" /> Analizando movimientos…</div> : null}
      {error ? <div className="rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</div> : null}

      {data?.variants.map((variant) => {
        const consistent = variant.difference === 0 && variant.duplicated_allocation === 0
        return (
          <section key={variant.variant_id} className="rounded-2xl border border-white/10 bg-[#09131d] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-black">{variant.product_name} · {variant.variant_name}</h2>
                <p className="mt-1 text-xs text-white/48">SKU {variant.variant_sku || "sin SKU"} · variante #{variant.variant_id}</p>
              </div>
              <span className={consistent ? "text-emerald-300" : "text-amber-200"}>
                {consistent ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
              {[
                ["Stock actual", variant.actual_stock],
                ["Libro calculado", variant.calculated_stock],
                ["Stock esperado", variant.expected_stock],
                ["Diferencia", variant.difference],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-xl bg-black/25 p-3">
                  <p className="text-xs text-white/45">{label}</p>
                  <p className="mt-1 text-lg font-black tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            {variant.possible_cause ? (
              <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/8 p-3 text-sm">
                <p className="font-bold text-amber-100">Posible movimiento causante</p>
                <p className="mt-1 text-white/70">{variant.possible_cause}</p>
                <p className="mt-1 text-xs text-white/45">{variant.possible_cause_movement_id} · {date(variant.possible_cause_at)}</p>
              </div>
            ) : null}
          </section>
        )
      })}

      {repairable ? (
        <section className="rounded-2xl border border-red-400/20 bg-red-400/7 p-4">
          <h2 className="flex items-center gap-2 font-black"><Wrench className="size-4" /> Reparación controlada</h2>
          <p className="mt-2 text-sm text-white/65">Sólo se reducirá la asignación duplicada. El movimiento y su historial permanecerán intactos. Escribí RECONCILIAR para confirmar.</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} className="h-11 rounded-xl border border-white/15 bg-black/30 px-3 text-sm outline-none" />
            <button type="button" disabled={repairing || confirmation !== "RECONCILIAR"} onClick={() => void repair()} className="h-11 rounded-xl bg-red-500/80 px-4 text-sm font-black disabled:opacity-40">
              {repairing ? "Reconciliando…" : "Confirmar reparación"}
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-white/10 bg-[#09131d] p-4">
        <h2 className="font-black">Movimientos trazables</h2>
        <div className="mt-3 space-y-2">
          {(data?.movements ?? []).map((movement) => (
            <div key={String(movement.movement_id)} className="grid gap-1 rounded-xl bg-black/25 p-3 text-xs md:grid-cols-4">
              <span className="font-bold">{String(movement.movement_type)}</span>
              <span>{number(movement.quantity_delta) > 0 ? "+" : ""}{number(movement.quantity_delta)}</span>
              <span>{String(movement.document_reference ?? "—")}</span>
              <span className="text-white/45">{date(movement.effective_at)}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
