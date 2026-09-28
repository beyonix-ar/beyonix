// Deriva sólo la presentación. Las validaciones siguen en los flujos existentes.
export type AdminClaimWizardStep = { key: "review" | "next" | "method" | "reception" | "replacement" | "execution" | "finish"; label: string }

export interface AdminClaimWizardLogistics {
  /** null: el Admin todavía tiene que elegir el método logístico. */
  plan: "cambio_directo" | "retiro" | "retiro_y_reenvio" | null
  /** Paso actual según el paradero de las unidades (getAdminClaimLogisticsView). */
  step: "replacement" | "execution" | "reception"
}

export function getAdminClaimWizard(input: {
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
  const steps: AdminClaimWizardStep[] = [{ key: "review", label: "Revisión" }]
  if (!approved && !closed) steps.push({ key: "next", label: "Resolución" }, { key: "finish", label: "Finalización" })

  // Con logística de unidades el orden sigue al método elegido por el Admin:
  // en el cambio directo se reserva el reemplazo ANTES de que vuelva el
  // original; en retiro + revisión, recién después de inspeccionarlo. El paso
  // "Método" queda siempre accesible para revisar (o corregir, si no hubo
  // efectos reales) la decisión logística.
  if (approved && input.logistics) {
    const { plan } = input.logistics
    steps.push({ key: "method", label: "Método" })
    if (plan === null) {
      steps.push({ key: "finish", label: "Finalización" })
      const current = closed ? "finish" : "method"
      return { steps, current, currentIndex: steps.findIndex((step) => step.key === current) }
    }
    if (plan === "cambio_directo") {
      steps.push({ key: "replacement", label: "Reserva" }, { key: "execution", label: "Cambio en sucursal" }, { key: "reception", label: "Recepción e inspección" })
    } else if (plan === "retiro_y_reenvio") {
      steps.push({ key: "reception", label: "Retiro e inspección" }, { key: "replacement", label: "Reemplazo autorizado" }, { key: "execution", label: "Envío a sucursal" })
    } else {
      steps.push({ key: "reception", label: "Retiro e inspección" }, { key: "execution", label:
        input.resolution === "reintegro_total" || input.resolution === "reintegro_parcial" ? "Reintegro" : "Aplicación" })
    }
    steps.push({ key: "finish", label: "Finalización" })
    const current = closed || input.status === "reemplazo_enviado" ? "finish" : input.logistics.step
    return { steps, current, currentIndex: steps.findIndex((step) => step.key === current) }
  }

  if (approved && reception) steps.push({ key: "reception", label: "Recepción" })
  if (approved && replacement) steps.push({ key: "replacement", label: reception ? "Reemplazo" : "Unidad faltante" })
  if (approved) steps.push({ key: "execution", label: replacement ? "Entrega" :
    input.resolution === "reintegro_total" || input.resolution === "reintegro_parcial" ? "Reintegro" : "Aplicación" })
  if (approved || closed) steps.push({ key: "finish", label: "Finalización" })
  const current = closed || input.status === "reemplazo_enviado" ? "finish" : !approved ? "review" : reception && input.receivedUnits === 0
    ? "reception" : replacement && !(input.replacedUnits !== null && input.replacedUnits > 0)
      ? "replacement" : "execution"
  return { steps, current, currentIndex: steps.findIndex((step) => step.key === current) }
}
