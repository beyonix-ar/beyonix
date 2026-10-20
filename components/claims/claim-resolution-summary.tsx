"use client"

import { useState, type ReactNode } from "react"
import { Check, Circle, Download, ExternalLink, Package } from "lucide-react"

import { formatPrice } from "@/app/admin/sections/productos/helpers"
import { getCuentaItemImage } from "@/lib/account/account-utils"
import { ANDREANI_PUBLIC_TRACKING_PAGE_URL } from "@/lib/andreani/public-tracking"
import type { ClaimFinancialView } from "@/lib/orders/claim-policy"
import type { ClaimLogisticsProgressGroup } from "@/lib/orders/claim-shipment-view"
import type { SupabasePedidoItem } from "@/lib/supabase/types"
import { openClaimShipmentLabel } from "@/components/claims/claim-shipment-label"

/**
 * Resumen del reclamo para el Admin: problema, productos, solución (con si el
 * producto vuelve y el bloque financiero sólo si existe) y la logística por
 * tramo. Los números de Andreani y el historial quedan en "Ver detalles".
 */
export function ClaimResolutionSummary({
  claimId,
  problem,
  description,
  items,
  solution,
  returnSummary,
  financial,
  groups,
  details,
}: {
  claimId: number
  problem: string
  description?: string | null
  items: Array<{ item: SupabasePedidoItem; quantity: number }>
  /** null mientras el reclamo no tiene solución aprobada. */
  solution: string | null
  returnSummary: string | null
  financial: ClaimFinancialView | null
  groups: ClaimLogisticsProgressGroup[]
  /** Trazabilidad completa (envío original, tramos, historial, simulación QA). */
  details: ReactNode
}) {
  const [labelError, setLabelError] = useState("")
  const [labelBusy, setLabelBusy] = useState<number | null>(null)

  const openLabel = async (shipmentId: number) => {
    if (labelBusy !== null) return
    setLabelBusy(shipmentId)
    setLabelError((await openClaimShipmentLabel(claimId, shipmentId)) ?? "")
    setLabelBusy(null)
  }

  return (
    <div className="admin-claim-overview-grid border-b p-3 sm:p-4" data-claim-summary>
      <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3" data-claim-summary-problem>
        <p className="admin-claim-summary-eyebrow">Problema</p>
        <p className="mt-1 text-xs font-bold text-white">{problem}</p>
        {description && <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/60">{description}</p>}
        <ul className="mt-2 space-y-1.5" aria-label="Productos afectados" data-claim-summary-items>
          {items.length === 0 && <li className="text-xs font-semibold text-white/70">Pedido completo</li>}
          {items.map(({ item, quantity }) => {
            const image = getCuentaItemImage(item)
            const variant = item.conditioned_name || item.producto_variantes?.nombre
            return (
              <li key={item.id} className="flex items-center gap-2">
                <span className="admin-claim-summary-thumb flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10">
                  {image ? <img src={image} alt="" className="size-full object-contain" /> : <Package className="size-4 text-black/40" />}
                </span>
                <span className="min-w-0 text-xs">
                  <span className="block truncate font-bold text-white">{item.productos?.nombre ?? `Producto #${item.producto_id}`}</span>
                  <span className="block truncate text-10px text-white/55">{variant ? `${variant} · ` : ""}{quantity} de {item.cantidad}</span>
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3" data-claim-summary-solution>
        <p className="admin-claim-summary-eyebrow">Solución</p>
        {solution ? (
          <>
            <p className="mt-1 text-sm font-black text-white" data-claim-solution>{solution}</p>
            {returnSummary && <p className="mt-0.5 text-xs font-semibold text-white/70" data-claim-return>Producto: {returnSummary}</p>}
            {financial && (
              <dl className="admin-claim-financial mt-2" data-claim-financial={financial.action}>
                <div><dt>Estado</dt><dd className={`admin-claim-pill is-small ${financial.stage === "done" ? "is-success" : financial.stage === "processing" ? "is-brand" : "is-warning"}`}>{financial.stageLabel}</dd></div>
                <div><dt>Monto</dt><dd>{financial.amount != null ? formatPrice(financial.amount) : "A definir"}</dd></div>
                <div><dt>Destino</dt><dd>{financial.methodLabel}</dd></div>
              </dl>
            )}
          </>
        ) : (
          <p className="mt-1 text-xs font-semibold text-white/70">Pendiente de revisión</p>
        )}
      </section>

      <section className="admin-claim-card bx-surface bx-surface-section rounded-xl border p-3" data-claim-summary-logistics>
        <p className="admin-claim-summary-eyebrow">Logística</p>
        {groups.length === 0 && <p className="mt-1 text-xs font-semibold text-white/70">Sin movimientos</p>}
        {groups.map((group) => (
          <div key={group.key} className="admin-claim-progress-group" data-claim-progress={group.key}>
            <p className="admin-claim-progress-title">{group.title}</p>
            <ol className="admin-claim-progress-steps">
              {group.steps.map((step) => (
                <li key={step.key} data-state={step.state} className={`is-${step.state}`}>
                  {step.state === "done"
                    ? <Check className="size-3.5 shrink-0" strokeWidth={3} aria-hidden="true" />
                    : <Circle className={`size-3 shrink-0 ${step.state === "current" ? "fill-current" : ""}`} aria-hidden="true" />}
                  <span>{step.label}</span>
                  <span className="sr-only">{step.state === "done" ? " (listo)" : step.state === "current" ? " (en curso)" : " (pendiente)"}</span>
                </li>
              ))}
            </ol>
            {(group.tracking || group.labelAvailable) && group.shipmentId && (
              <div className="admin-claim-progress-actions">
                {group.tracking && (
                  <a href={ANDREANI_PUBLIC_TRACKING_PAGE_URL} target="_blank" rel="noreferrer" className="admin-claim-progress-link"
                    title={`Seguimiento Andreani ${group.tracking}`}>
                    <ExternalLink className="size-3.5" aria-hidden="true" />Tracking {group.tracking}
                  </a>
                )}
                {group.labelAvailable && (
                  <button type="button" className="admin-claim-progress-link" disabled={labelBusy !== null}
                    onClick={() => void openLabel(group.shipmentId!)}>
                    <Download className="size-3.5" aria-hidden="true" />{labelBusy === group.shipmentId ? "Abriendo..." : "Etiqueta"}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {labelError && <p role="alert" className="mt-1 text-xs font-semibold text-red-300">{labelError}</p>}
        <details className="admin-claim-details mt-2" data-claim-details>
          <summary>Ver detalles</summary>
          <div className="mt-2">{details}</div>
        </details>
      </section>
    </div>
  )
}
