// Deriva sólo la presentación. Las validaciones siguen en los flujos existentes.
export type AdminClaimWizardStep = { key: "review" | "next" | "reception" | "replacement" | "execution" | "finish"; label: string }

export function getAdminClaimWizard(input: {
  status: string
  resolution?: string | null
  receivedUnits: number
  replacedUnits: number | null
}) {
  const closed = input.status === "cerrado" || input.status === "rechazado"
  const approved = Boolean(input.resolution && input.resolution !== "rechazado")
  const replacement = input.resolution === "cambio_producto" || input.resolution === "envio_unidad_faltante"
  const reception = input.resolution === "cambio_producto"
  const steps: AdminClaimWizardStep[] = [{ key: "review", label: "Revisión" }]
  if (!approved && !closed) steps.push({ key: "next", label: "Resolución" }, { key: "finish", label: "Finalización" })
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
