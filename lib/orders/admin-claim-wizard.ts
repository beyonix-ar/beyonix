// Deriva sólo la presentación. Las validaciones siguen en los flujos existentes.
export type AdminClaimWizardStep = {
  key: "review" | "next" | "method" | "logistics" | "reception" | "replacement" | "execution" | "finish"
  label: string
}

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
