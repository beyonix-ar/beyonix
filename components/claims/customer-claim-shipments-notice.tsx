import { Download, Truck } from "lucide-react"

import {
  getCustomerClaimShipmentView,
  pickClaimShipment,
  type ClaimShipmentDirection,
} from "@/lib/orders/claim-shipment-view"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

/**
 * Envíos del cambio aceptado para el cliente: cómo devolver (con etiqueta si
 * corresponde), recepción en BEYONIX y envío del reemplazo hasta la entrega.
 * Sin datos internos (costos, contratos, ambiente, errores).
 */
export function CustomerClaimShipmentsNotice({ claim }: { claim: SupabaseOrderClaim }) {
  if (claim.resolution !== "cambio_producto" || claim.status === "rechazado") return null
  const shipments = (["devolucion", "reemplazo"] as ClaimShipmentDirection[])
    .map((direction) => getCustomerClaimShipmentView(pickClaimShipment(claim.order_claim_shipments ?? null, direction)))
    .filter((view): view is NonNullable<typeof view> => view !== null)
  if (!shipments.length) return null

  return (
    <div className="border-b border-[#77E6E2]/20 bg-[#071C20] px-3.5 py-3" data-customer-claim-shipments>
      <div className="grid gap-3">
        {shipments.map((view) => (
          <div key={view.direction} className="flex items-start gap-2.5" data-customer-claim-shipment={view.direction}>
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-[#77E6E2]/25 bg-[#77E6E2]/10">
              <Truck className="size-3.5 text-[#D7FFFD]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-black text-[#D7FFFD]">{view.title} · {view.statusLabel}</p>
              {view.modalityLabel && <p className="mt-1 text-xs font-bold text-white/85">{view.modalityLabel}</p>}
              {view.tracking && (
                <p className="mt-1 text-xs font-semibold text-white/80">
                  Seguimiento Andreani: <span className="font-black text-white">{view.tracking}</span>
                </p>
              )}
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs font-semibold leading-5 text-white/80">
                {view.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
              </ul>
              {view.label && (
                <a
                  href={`/api/orders/${claim.order_id}/claims/${claim.id}/return-label`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[#77E6E2]/35 px-2.5 py-1.5 text-xs font-black text-[#D7FFFD] hover:border-[#77E6E2]/70"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  Descargar etiqueta de devolución{view.label.required ? "" : " (opcional)"}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
