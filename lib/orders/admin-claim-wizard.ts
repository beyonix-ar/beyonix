// Deriva sólo la presentación. Las validaciones siguen en los flujos existentes.
import { getClaimRequirements } from "./claim-policy.ts"

export type AdminClaimWizardStepKey =
  "review" | "next" | "method" | "logistics" | "reception" | "replacement" | "execution" | "finish"

/**
 * done: el paso ocurrió. skipped: el reclamo se canceló sin que ocurriera.
 * cancelled: cierre de un reclamo cancelado. open: actual o todavía no alcanzado.
 */
export type AdminClaimWizardStepStatus = "done" | "skipped" | "cancelled" | "open"

export type AdminClaimWizardStep = {
  key: AdminClaimWizardStepKey
  label: string
}

export type AdminClaimWizardStepView = AdminClaimWizardStep & { status: AdminClaimWizardStepStatus }

export interface AdminClaimWizardLogistics {
  /** null: el Admin todavía tiene que elegir el método logístico. */
  plan: "cambio_directo" | "retiro" | "retiro_y_reenvio" | "reenvio_sin_devolucion" | null
  /** Paso actual según el paradero de las unidades (getAdminClaimLogisticsView). */
  step: "logistics" | "reception" | "replacement" | "execution" | "finish"
}

export function getAdminClaimWizard(input: {
  status: string
  resolution?: string | null
  receivedUnits: number
  replacedUnits: number | null
  logistics?: AdminClaimWizardLogistics | null
  /** false mientras falten unidades por recibir (el paso sigue abierto aunque se avance). */
  receptionComplete?: boolean
  /** Reclamo cancelado (cerrado + cancelled_at). */
  cancelled?: boolean
  /** Nombre del paso de dinero cuando la solución no lo define sola (reclamo mixto). */
  executionLabel?: string
  /**
   * Sólo con cancelled: qué pasos ocurrieron realmente antes de cancelar.
   * Lo que no figure acá se muestra como no realizado, nunca como completado.
   */
  occurred?: Partial<Record<AdminClaimWizardStepKey, boolean>>
}) {
  const wizard = getAdminClaimWizardSteps(input)
  const cancelled = Boolean(input.cancelled) && input.status === "cerrado"
  const steps: AdminClaimWizardStepView[] = wizard.steps.map((step, index) => {
    if (cancelled && step.key === "finish") return { ...step, label: "Cancelado", status: "cancelled" }
    if (index >= wizard.currentIndex) return { ...step, status: "open" }
    if (cancelled) return { ...step, status: input.occurred?.[step.key] ? "done" : "skipped" }
    return { ...step, status: step.key === "reception" && input.receptionComplete === false ? "open" : "done" }
  })
  return { ...wizard, steps }
}

function getAdminClaimWizardSteps(input: {
  status: string
  resolution?: string | null
  receivedUnits: number
  replacedUnits: number | null
  logistics?: AdminClaimWizardLogistics | null
  executionLabel?: string
}) {
  const closed = input.status === "cerrado" || input.status === "rechazado"
  const requirements = getClaimRequirements(input.resolution)
  const approved = Boolean(requirements)
  const replacement = requirements?.solution === "replacement"
  const reception = input.resolution === "cambio_producto"
  const refundLabel = input.executionLabel ?? (requirements?.financialAction === "refund" ? "Reintegro"
    : requirements?.financialAction === "customer_credit" ? "Saldo a favor" : "Solución")
  const steps: AdminClaimWizardStep[] = [{ key: "review", label: "Revisar" }]
  if (!approved && !closed) steps.push({ key: "next", label: "Resolución" }, { key: "finish", label: "Finalizar" })

  // Con logística por sucursal cada paso es una sola cosa, en el orden real:
  // Logística (sólo mientras no se eligió) -> Devolución / Cambio -> Inspección
  // -> Envío o reintegro -> Finalizar. Elegido el método, su corrección vive en
  // el paso de la operación (no hay un paso "Método" aparte).
  if (approved && input.logistics) {
    const { plan } = input.logistics
    if (plan === null) {
      steps.push({ key: "method", label: "Logística" })
    } else if (plan === "cambio_directo") {
      steps.push({ key: "logistics", label: "Cambio en sucursal" }, { key: "reception", label: "Inspección" })
    } else if (plan === "retiro_y_reenvio") {
      steps.push({ key: "logistics", label: "Devolución" }, { key: "reception", label: "Inspección" }, { key: "replacement", label: "Envío" })
    } else if (plan === "retiro") {
      steps.push({ key: "logistics", label: "Devolución" }, { key: "reception", label: "Inspección" }, { key: "execution", label: refundLabel })
    } else {
      steps.push({ key: "replacement", label: "Envío" })
    }
    steps.push({ key: "finish", label: "Finalizar" })
    const current = closed || input.status === "reemplazo_enviado" ? "finish" : plan === null ? "method" : input.logistics.step
    const index = steps.findIndex((step) => step.key === current)
    return { steps, current: index >= 0 ? current : "finish", currentIndex: index >= 0 ? index : steps.length - 1 }
  }

  if (approved && reception) steps.push({ key: "reception", label: "Inspección" })
  if (approved && replacement) steps.push({ key: "replacement", label: reception ? "Reemplazo" : "Unidad faltante" })
  if (approved) steps.push({ key: "execution", label: replacement ? "Entrega" : refundLabel })
  if (approved || closed) steps.push({ key: "finish", label: "Finalizar" })
  const current = closed || input.status === "reemplazo_enviado" ? "finish" : !approved ? "review" : reception && input.receivedUnits === 0
    ? "reception" : replacement && !(input.replacedUnits !== null && input.replacedUnits > 0)
      ? "replacement" : "execution"
  return { steps, current, currentIndex: steps.findIndex((step) => step.key === current) }
}

/**
 * Pasos que ocurrieron realmente en un reclamo cancelado, según hechos
 * registrados (nunca según el estado final). Ejecución/entrega no puede haber
 * ocurrido: la base no deja cancelar con reemplazo entregado, nota de crédito
 * emitida ni reintegro en curso.
 */
export function getCancelledClaimOccurredSteps(input: {
  resolution?: string | null
  logisticsPlan?: string | null
  shipments?: ReadonlyArray<{ creation_status?: string | null; status?: string | null }> | null
  units?: ReadonlyArray<{ role: string; location: string }> | null
  receivedUnits: number
}): Partial<Record<AdminClaimWizardStepKey, boolean>> {
  const units = input.units ?? []
  return {
    review: Boolean(input.resolution && input.resolution !== "rechazado"),
    method: Boolean(input.logisticsPlan),
    logistics: (input.shipments ?? []).some((row) => row.creation_status === "created" && row.status !== "cancelada"),
    reception: input.receivedUnits > 0 ||
      units.some((unit) => unit.role === "original" && ["recibida_beyonix", "reincorporada_stock", "baja"].includes(unit.location)),
    replacement: units.some((unit) => unit.role === "reemplazo" && ["en_andreani", "entregada_cliente"].includes(unit.location)),
  }
}
