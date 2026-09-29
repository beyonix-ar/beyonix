// Deriva sólo la presentación. Las validaciones siguen en los flujos existentes.
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
  plan: "cambio_directo" | "retiro" | "retiro_y_reenvio" | null
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
}) {
  const closed = input.status === "cerrado" || input.status === "rechazado"
  const approved = Boolean(input.resolution && input.resolution !== "rechazado")
  const replacement = input.resolution === "cambio_producto" || input.resolution === "envio_unidad_faltante"
  const reception = input.resolution === "cambio_producto"
  const refundLabel = input.resolution === "reintegro_total" || input.resolution === "reintegro_parcial" ? "Reintegro" : "Aplicación"
  const steps: AdminClaimWizardStep[] = [{ key: "review", label: "Revisión" }]
  if (!approved && !closed) steps.push({ key: "next", label: "Resolución" }, { key: "finish", label: "Finalización" })

  // Con logística por sucursal cada paso es una sola cosa, en el orden real del
  // método: Método -> operación Andreani -> lo que vuelve a BEYONIX -> reenvío
  // o reintegro -> Finalización. En el cambio directo el reemplazo viaja en la
  // misma operación que retira el original, por eso la recepción va después.
  if (approved && input.logistics) {
    const { plan } = input.logistics
    steps.push({ key: "method", label: "Método" })
    if (plan === "cambio_directo") {
      steps.push({ key: "logistics", label: "Cambio en sucursal" }, { key: "reception", label: "Recepción" })
    } else if (plan === "retiro_y_reenvio") {
      steps.push({ key: "logistics", label: "Retiro" }, { key: "reception", label: "Recepción" }, { key: "replacement", label: "Reenvío" })
    } else if (plan === "retiro") {
      steps.push({ key: "logistics", label: "Retiro" }, { key: "reception", label: "Recepción" }, { key: "execution", label: refundLabel })
    }
    steps.push({ key: "finish", label: "Finalización" })
    const current = closed || input.status === "reemplazo_enviado" ? "finish" : plan === null ? "method" : input.logistics.step
    const index = steps.findIndex((step) => step.key === current)
    return { steps, current: index >= 0 ? current : "finish", currentIndex: index >= 0 ? index : steps.length - 1 }
  }

  if (approved && reception) steps.push({ key: "reception", label: "Recepción" })
  if (approved && replacement) steps.push({ key: "replacement", label: reception ? "Reemplazo" : "Unidad faltante" })
  if (approved) steps.push({ key: "execution", label: replacement ? "Entrega" : refundLabel })
  if (approved || closed) steps.push({ key: "finish", label: "Finalización" })
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
