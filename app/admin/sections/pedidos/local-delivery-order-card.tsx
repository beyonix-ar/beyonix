"use client"

import Link from "next/link"
import { Bike } from "lucide-react"

import type { SupabasePedido } from "@/lib/supabase/types"
import { getLocalDeliveryStage, LOCAL_DELIVERY_STAGE_LABELS } from "@/lib/orders/local-delivery-status"
import { LOCAL_DELIVERY_NAME } from "@/lib/shipping/local-delivery"
import { getAdminLocalDeliveryExecutiveStatus } from "@/lib/orders/admin-order-status-presentation"

const formatPrice = (value: number) =>
  new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(value)

/**
 * Pestaña Envío de un pedido con Envío BEYONIX: reemplaza las acciones de
 * Andreani (etiqueta, guía, seguimiento externo), que no aplican. La entrega
 * se opera desde Despachos → Entregas locales.
 */
export function LocalDeliveryOrderCard({ pedido }: { pedido: SupabasePedido }) {
  const stage = getLocalDeliveryStage(pedido)
  // Resultado del cadete (Regresando/Devuelto a BEYONIX…) antes que "En camino".
  const outcomeLabel = getAdminLocalDeliveryExecutiveStatus(pedido)?.label
  const charged = pedido.shipping_cost_charged
  // El costo interno no llega a operadores (ver /api/admin/pedidos).
  const internalCost = pedido.shipping_cost_real

  return (
    <section className="admin-order-shipping-card admin-order-shipping-operation-card rounded-lg border p-3" data-local-delivery-order-card="">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-500/50 bg-beyonix-blue-900 text-[var(--beyonix-text-primary)]">
          <Bike className="size-3.5" />
        </span>
        <div>
          <p className="text-9px font-bold uppercase tracking-widest text-[var(--beyonix-text-muted)]">Entrega local</p>
          <h3 className="mt-0.5 text-sm font-black text-[var(--beyonix-text-primary)]">{LOCAL_DELIVERY_NAME}</h3>
        </div>
      </div>
      <dl className="admin-order-shipping-facts mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg border p-2.5 lg:grid-cols-3">
        <div>
          <dt className="text-9px font-bold uppercase tracking-widest text-[var(--beyonix-text-muted)]">Estado</dt>
          <dd className="mt-0.5 text-sm font-black text-[var(--beyonix-text-primary)]" data-local-delivery-stage={stage}>{outcomeLabel ?? LOCAL_DELIVERY_STAGE_LABELS[stage]}</dd>
        </div>
        <div>
          <dt className="text-9px font-bold uppercase tracking-widest text-[var(--beyonix-text-muted)]">Cobrado al cliente</dt>
          <dd className="mt-0.5 text-sm font-black text-[var(--beyonix-text-primary)]">
            {typeof charged === "number" ? (charged === 0 ? "Gratis" : formatPrice(charged)) : "No informado"}
          </dd>
        </div>
        {typeof internalCost === "number" && (
          <div>
            <dt className="text-9px font-bold uppercase tracking-widest text-[var(--beyonix-text-muted)]">Costo de la entrega</dt>
            <dd className="mt-0.5 text-sm font-black text-[var(--beyonix-text-primary)]">{formatPrice(internalCost)}</dd>
          </div>
        )}
      </dl>
      <p className="mt-2.5 text-xs text-[var(--beyonix-text-muted)]">
        Sin etiqueta ni seguimiento externo. Marcá &quot;En camino&quot; y &quot;Entregado&quot; desde{" "}
        <Link href="/admin/despachos" className="font-bold text-beyonix-sky underline-offset-4 hover:underline">
          Despachos → Entregas locales
        </Link>
        .
      </p>
    </section>
  )
}
