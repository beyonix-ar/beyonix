import type { BatchDispatchDetail, DispatchStage, OrderDispatchDetail } from "./dispatch"
import { dispatchLocationHref, type DispatchLocation } from "./dispatch-location"

/**
 * Siguiente pantalla de Despachos después de una confirmación exitosa, según
 * el estado real que devolvió el servidor (nunca antes de esa respuesta):
 * - current: el paso siguiente está en la misma pantalla (pickeo, envío, etiqueta, QR).
 * - bundle_list: pedido listo para Bulto → tabla de pedidos confirmados, con él seleccionado.
 * - batch: detalle/control del Bulto (incluye sus incidencias a resolver).
 * - list: tabla de Despachos actualizada (Bulto entregado al transporte).
 */
export type DispatchNextStep =
  | { screen: "current" }
  | { screen: "bundle_list"; orderId: number }
  | { screen: "batch"; batchId: number }
  | { screen: "list" }

export type DispatchStepFacts =
  | { kind: "order"; orderId: number; stage: DispatchStage; blocked: boolean; batchId: number | null }
  | { kind: "batch"; batchId: number; status: string; blocked: boolean }

export function getNextDispatchStep(facts: DispatchStepFacts): DispatchNextStep {
  if (facts.kind === "batch") {
    // Con pedidos cancelados o incidencias no se avanza: el Bulto muestra cuáles retirar.
    if (facts.blocked) return { screen: "batch", batchId: facts.batchId }
    return facts.status === "handed_over" ? { screen: "list" } : { screen: "batch", batchId: facts.batchId }
  }
  if (facts.blocked) return { screen: "current" }
  if (facts.stage === "ready") return { screen: "bundle_list", orderId: facts.orderId }
  if ((facts.stage === "in_batch" || facts.stage === "batch_closed") && facts.batchId) return { screen: "batch", batchId: facts.batchId }
  if (facts.stage === "handed_over") return { screen: "list" }
  return { screen: "current" }
}

export function orderStepFacts(detail: Pick<OrderDispatchDetail, "order" | "stage" | "packingBlocked" | "hold" | "batch">): DispatchStepFacts {
  return { kind: "order", orderId: detail.order.id, stage: detail.stage, blocked: detail.packingBlocked || Boolean(detail.hold), batchId: detail.batch?.id ?? null }
}

export function batchStepFacts(detail: Pick<BatchDispatchDetail, "batch" | "items" | "blockedCount">): DispatchStepFacts {
  return { kind: "batch", batchId: detail.batch.id, status: detail.batch.status, blocked: detail.blockedCount > 0 || detail.items.some((item) => item.blocked) }
}

/** Ubicación (URL) de Despachos que representa el paso; null = quedarse. */
export function dispatchStepLocation(step: DispatchNextStep): DispatchLocation | null {
  if (step.screen === "current") return null
  return { orderId: null, batchId: step.screen === "batch" ? step.batchId : null }
}

export function dispatchStepHref(step: DispatchNextStep): string | null {
  const location = dispatchStepLocation(step)
  return location ? dispatchLocationHref(location) : null
}
