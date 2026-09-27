"use client"

import { useEffect, useState } from "react"
import { Clock3 } from "lucide-react"

import { getProductStockReservations } from "@/lib/supabase/queries/productos"
import {
  STOCK_RESERVATION_STATUS_LABEL,
  type StockReservationDetail,
} from "@/lib/inventory/stock-reservation-details"

/** "Físico · Reservado · Disponible" compacto, sólo cuando hay reservas activas. */
export function StockReservationBreakdown({
  reserved,
  available,
}: {
  reserved: number
  available: number
}) {
  if (reserved <= 0) return null

  return (
    <span
      data-stock-reservation-breakdown
      className="admin-stock-reservation-breakdown mt-1 block whitespace-nowrap text-9px font-bold leading-3 text-amber-200/85"
    >
      {reserved} reserv. · {available} disp.
    </span>
  )
}

function formatExpiry(value: string | null) {
  if (!value) return "Sin vencimiento mientras se procesa el pago"
  return `Vence ${new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))}`
}

/**
 * Qué compone "Reservado": reservas temporales de checkout (no son ventas).
 * Se carga sólo al desplegar un producto que tiene reservas activas.
 */
export function ProductStockReservations({
  productId,
  reservedTotal,
  targetLabel,
}: {
  productId: number
  reservedTotal: number
  targetLabel: (reservation: StockReservationDetail) => string
}) {
  const [reservations, setReservations] = useState<StockReservationDetail[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    getProductStockReservations(productId)
      .then((rows) => {
        if (!cancelled) setReservations(rows)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setError(
          loadError instanceof Error
            ? loadError.message
            : "No se pudieron cargar las reservas activas.",
        )
      })
    return () => {
      cancelled = true
    }
  }, [productId, reservedTotal])

  return (
    <section
      aria-label="Reservas activas"
      data-product-stock-reservations
      className="admin-stock-reservations mx-4 mt-3 rounded-lg border border-amber-300/18 bg-amber-300/[0.035] px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-9px font-black uppercase tracking-widest text-amber-200/85">
        <Clock3 className="size-3" aria-hidden="true" />
        Reservado ({reservedTotal}) · reservas temporales de checkout, no son ventas
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>
      ) : reservations === null ? (
        <p className="mt-2 text-xs text-white/50">Cargando reservas…</p>
      ) : reservations.length === 0 ? (
        <p className="mt-2 text-xs text-white/50">Las reservas ya vencieron o se cerraron.</p>
      ) : (
        <ul className="mt-2 grid gap-1">
          {reservations.map((reservation, index) => (
            <li
              key={`${reservation.orderId ?? "checkout"}-${reservation.variantId ?? ""}-${reservation.conditionedStockId ?? ""}-${index}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-white/75"
            >
              <span className="font-black tabular-nums text-white">{reservation.quantity} u.</span>
              <span className="min-w-0 truncate">{targetLabel(reservation)}</span>
              <span className="text-white/55">{STOCK_RESERVATION_STATUS_LABEL[reservation.status]}</span>
              {reservation.orderId !== null && (
                <span className="font-bold text-white/70">Pedido #{reservation.orderId}</span>
              )}
              <span className="text-white/50">{formatExpiry(reservation.expiresAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
