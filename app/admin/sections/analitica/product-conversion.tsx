"use client"

import { formatRate, type ProductConversionReport } from "@/lib/analytics/commerce-report"
import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"

import { AdminHelpTip } from "../../components/admin-help-tip"
import { AdminSkeleton } from "../../components/admin-controls"
import { ProductThumbnail } from "../productos/product-thumbnail"
import { useAnalyticsReport, type AnalyticsReportState } from "./use-analytics-report"

const countFormatter = new Intl.NumberFormat("es-AR")

const PRODUCT_CONVERSION_HELP =
  "Por producto: sesiones que lo vieron y, de ellas, cuántas lo agregaron al carrito y cuántas lo compraron (pedido con pago confirmado). Sesiones únicas: agregar 5 veces el mismo producto cuenta una vez. Los agregados desde el listado sin abrir el producto no entran a la cohorte."

export function useProductConversionReport(range: AnalyticsDateRange | null, rangeKey: string | null) {
  return useAnalyticsReport<ProductConversionReport>(
    "/api/admin/analytics/product-conversion",
    "No se pudo cargar la conversión por producto.",
    range,
    rangeKey,
  )
}

const COLUMNS = [
  { key: "viewed", label: "Vieron" },
  { key: "added", label: "Agregaron" },
  { key: "cart", label: "Conv. carrito" },
  { key: "bought", label: "Compraron" },
  { key: "purchase", label: "Conv. compra" },
] as const

/** Top 10 productos por sesiones que los vieron, con conversión a carrito y a compra. */
export function ProductConversionSection({ report, loadError }: AnalyticsReportState<ProductConversionReport>) {
  const products = report?.products.slice(0, 10) ?? []

  return (
    <section
      className="admin-dashboard-filters admin-analytics-product-conversion-section min-w-0 rounded-2xl border p-4"
      aria-labelledby="analytics-product-conversion-title"
      aria-busy={!report && !loadError}
    >
      <h2 id="analytics-product-conversion-title" className="mb-3 flex items-center gap-1 text-sm font-black text-white">
        Conversión por producto
        <AdminHelpTip label="Conversión por producto" text={PRODUCT_CONVERSION_HELP} />
      </h2>
      {report ? (
        products.length > 0 ? (
          <div role="table" aria-labelledby="analytics-product-conversion-title" className="admin-analytics-conversion">
            <div role="row" className="admin-analytics-conversion-row admin-analytics-conversion-head">
              <span role="columnheader">Producto</span>
              {COLUMNS.map((column) => (
                <span key={column.key} role="columnheader" className="text-right">{column.label}</span>
              ))}
            </div>
            {products.map((entry) => {
              const values = {
                viewed: countFormatter.format(entry.viewedSessions),
                added: countFormatter.format(entry.addedSessions),
                cart: formatRate(entry.cartRate),
                bought: countFormatter.format(entry.purchasedSessions),
                purchase: formatRate(entry.purchaseRate),
              }
              return (
                <div role="row" key={entry.productId} className="admin-analytics-conversion-row">
                  <span role="cell" className="admin-analytics-conversion-product flex min-w-0 items-center gap-2.5">
                    <ProductThumbnail image={entry.image} alt={`Imagen de ${entry.name}`} size="sm" />
                    <span className="min-w-0" title={entry.name}>
                      <span className="block truncate text-sm font-bold text-white">{entry.name}</span>
                      {!entry.available && <span className="block text-11px text-white/45">No publicado</span>}
                    </span>
                  </span>
                  {COLUMNS.map((column) => (
                    <span
                      key={column.key}
                      role="cell"
                      data-label={column.label}
                      className={`admin-analytics-conversion-value text-right text-sm tabular-nums ${column.key === "cart" || column.key === "purchase" ? "font-black text-white" : "font-semibold text-white/75"}`}
                    >
                      {values[column.key]}
                    </span>
                  ))}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs font-semibold text-white/55">Sin productos vistos en este período</p>
        )
      ) : loadError ? (
        <p className="text-xs font-semibold text-white/55">{loadError}</p>
      ) : (
        <AdminSkeleton rows={3} />
      )}
    </section>
  )
}
