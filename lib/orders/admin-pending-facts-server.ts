import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import {
  arcaAutoInvoicingView,
  isOrderInAutoInvoicingQueue,
  type ArcaAutoInvoicingControl,
  type ArcaAutoInvoicingOrder,
} from "@/lib/arca/auto-invoicing-control"
import { getArcaConfigurationStatus } from "@/lib/arca/configuration"
import { loadFinancialResolution } from "./financial-resolution-server"
import type { AdminPendingFacts } from "./admin-pending-actions"

type Admin = ReturnType<typeof createAdminClient>
type FactsOrder = ArcaAutoInvoicingOrder & { id: number; financial_status?: string | null; cancelled_at?: string | null }

const FINANCIAL_CONCURRENCY = 5

/**
 * Hechos para las acciones pendientes que no viven en `ordenes`: el modo y
 * estado del orquestador financiero (Etapa 5, mismo cálculo que el wizard) y
 * la situación de despacho (bulto, tanda y bloqueo vigente). Sólo lectura.
 */
export async function loadAdminPendingFacts(admin: Admin, orders: FactsOrder[], includeFinancial: boolean) {
  const ids = orders.map((order) => order.id)
  const facts = new Map<number, AdminPendingFacts>()
  if (!ids.length) return facts

  const [packagesResult, membershipsResult, blocksResult, resolutionsResult, controlResult] = await Promise.all([
    admin.from("order_packages").select("order_id,status").in("order_id", ids),
    admin.from("dispatch_batch_items").select("order_id,batch_id,dispatch_batches(status)").in("order_id", ids).is("removed_at", null),
    admin.from("dispatch_blocks").select("order_id").in("order_id", ids).is("resolved_at", null),
    includeFinancial
      ? admin.from("order_financial_resolutions").select("order_id,status").in("order_id", ids)
      : Promise.resolve({ data: [], error: null }),
    // Misma fuente que el cron y Admin > Facturación para saber si la cola se procesa sola.
    admin.from("arca_auto_invoicing_control").select("enabled, cutoff_at, updated_at").eq("id", true).maybeSingle(),
  ])
  const failure = [packagesResult, membershipsResult, blocksResult, resolutionsResult].find((result) => result.error)
  if (failure?.error) throw new Error(failure.error.message)
  // Sin control legible no se asume automático: la factura queda como tarea humana.
  const autoInvoicing = !controlResult.error && controlResult.data
    ? arcaAutoInvoicingView(controlResult.data as ArcaAutoInvoicingControl, getArcaConfigurationStatus())
    : null

  const packages = new Map((packagesResult.data ?? []).map((row) => [row.order_id as number, row.status as "preparing" | "prepared"]))
  const memberships = new Map((membershipsResult.data ?? []).map((row) => {
    const batch = row.dispatch_batches as unknown as { status: "open" | "closed" | "handed_over" } | null
    return [row.order_id as number, { batchId: row.batch_id as number, batchStatus: batch?.status ?? null }]
  }))
  const blocked = new Set((blocksResult.data ?? []).map((row) => row.order_id as number))
  const resolutions = new Map((resolutionsResult.data ?? []).map((row) => [row.order_id as number, row.status as string]))

  for (const order of orders) {
    const membership = memberships.get(order.id)
    facts.set(order.id, {
      financial: null,
      dispatch: {
        batchId: membership?.batchId ?? null,
        batchStatus: membership?.batchStatus ?? null,
        packageStatus: packages.get(order.id) ?? null,
        // Igual que el tablero de Despachos: un pedido cancelado dentro de una tanda queda bloqueado.
        blocked: blocked.has(order.id) || (!!membership && order.cancelled_at != null),
      },
      invoiceAutomatic: autoInvoicing ? isOrderInAutoInvoicingQueue(autoInvoicing, order) : false,
    })
  }

  if (!includeFinancial) return facts

  // Sólo los pedidos con dinero por resolver pasan por el orquestador.
  const financialOrders = orders.filter((order) => order.financial_status === "refund_pending" || resolutions.has(order.id))
  for (let index = 0; index < financialOrders.length; index += FINANCIAL_CONCURRENCY) {
    await Promise.all(financialOrders.slice(index, index + FINANCIAL_CONCURRENCY).map(async (order) => {
      const current = facts.get(order.id)
      if (!current) return
      try {
        // Sin verificación remota: el listado nunca consulta Mercado Pago.
        const result = await loadFinancialResolution(admin, order.id, false)
        if (!result) return
        current.financial = {
          mode: result.mode,
          resolutionStatus: result.resolution?.status ?? null,
          hasOptions: result.options.length > 0,
        }
      } catch {
        // Sin hechos financieros se usa la máquina de cancelación existente.
      }
    }))
  }
  return facts
}
