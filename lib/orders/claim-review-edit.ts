// Paso "Revisión" del wizard Admin: si la decisión (Corresponde / No
// corresponde y la solución) todavía se puede corregir. Sólo presentación: la
// base vuelve a validar cada cambio (mutate_admin_order_claim, guardas de
// logística y NC, reopen_rejected_order_claim).

export type ClaimReviewDecision = "approve" | "reject"

export type ClaimReviewEditMode =
  /** Todavía sin decidir. */
  | "decide"
  /** Decidido y sin efectos reales: se puede corregir. */
  | "edit"
  /** Rechazado sin efectos reales: se puede reabrir con motivo (auditado). */
  | "reopen"
  /** Hubo efectos reales: la decisión no se cambia desde acá. */
  | "locked"
  /** Finalizado, circuito propio (consulta/cancelación) o sin permiso. */
  | "readonly"

export interface ClaimReviewEditability {
  mode: ClaimReviewEditMode
  current: ClaimReviewDecision | null
  /** Efectos reales que impiden la corrección directa. */
  effects: string[]
  /** "Cambiar solución" (seguir en Corresponde con otra resolución). */
  canChangeSolution: boolean
  /** Soluciones que no se pueden elegir al corregir desde el estado actual. */
  unavailableResolutions: string[]
}

const UNDECIDED = ["recibido", "en_revision", "falta_informacion"]
const APPROVED = ["aprobado", "reintegro_pendiente", "cambio_pendiente", "cupon_pendiente", "reemplazo_enviado"]
const ECONOMIC = ["reintegro_total", "reintegro_parcial", "saldo_a_favor", "cupon_descuento"]

export function getClaimReviewEditability(input: {
  status: string
  resolution?: string | null
  failureType?: string | null
  isAdmin: boolean
  /** Efectos reales ya detectados (logística, NC, reemplazo, recepción, reintegro). */
  effects: Array<string | null | false | undefined>
}): ClaimReviewEditability {
  const effects = [...new Set(input.effects.filter((effect): effect is string => Boolean(effect)))]
  const ownCircuit = ["consulta_pedido", "cancelar_compra"].includes(input.failureType ?? "")
  const base = { effects, canChangeSolution: false, unavailableResolutions: [] as string[] }

  if (UNDECIDED.includes(input.status)) return { ...base, mode: "decide", current: null }
  if (input.status === "cerrado" || ownCircuit || !input.isAdmin) {
    return { ...base, mode: "readonly", current: input.status === "rechazado" ? "reject" : APPROVED.includes(input.status) ? "approve" : null }
  }
  if (input.status === "rechazado") {
    return { ...base, mode: effects.length ? "locked" : "reopen", current: "reject" }
  }
  if (!APPROVED.includes(input.status)) return { ...base, mode: "readonly", current: null }
  if (effects.length) return { ...base, mode: "locked", current: "approve" }

  // Mismas reglas que mutate_admin_order_claim: desde "aprobado" se puede
  // cambiar la solución sin pasar a "reintegro pendiente"; una solución
  // económica ya en curso (reintegro/cupón pendiente) sólo se puede rechazar.
  const canChangeSolution = input.status === "aprobado" && !ECONOMIC.includes(input.resolution ?? "")
  return {
    ...base,
    mode: "edit",
    current: "approve",
    canChangeSolution,
    unavailableResolutions: canChangeSolution ? ["reintegro_total"] : [],
  }
}
