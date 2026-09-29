// Destino físico de las unidades de un reclamo, en texto claro para el Admin.
// Sólo describe hechos ya registrados (recepción/inspección o unidades del
// reclamo): nunca los deduce del estado del reclamo. Cancelar, rechazar o
// finalizar un reclamo no cambia ninguno de estos números.
//
// No existe un estado "perdida" separado: la inspección sólo distingue
// reincorporar a stock (vendible o con descuento) y dar de baja.

export interface ClaimProductOutcomeCounts {
  /** Reincorporadas a stock vendible. */
  restocked: number
  /** Reincorporadas a stock con descuento (sólo recepción canónica). */
  discounted?: number
  /** Dadas de baja en la inspección. */
  writtenOff: number
  /** Nunca volvieron a BEYONIX: quedaron en poder del cliente. */
  keptByCustomer?: number
}

const units = (count: number, singular: string, plural: string) =>
  `${count} ${count === 1 ? `unidad ${singular}` : `unidades ${plural}`}`

const positive = (value: number | undefined) => (Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : 0)

/** Una frase por destino, sin mezclar estados distintos. */
export function getClaimProductOutcomeLines(counts: ClaimProductOutcomeCounts): string[] {
  const restocked = positive(counts.restocked)
  const discounted = positive(counts.discounted)
  const writtenOff = positive(counts.writtenOff)
  const kept = positive(counts.keptByCustomer)
  return [
    restocked > 0 ? units(restocked, "reincorporada al stock", "reincorporadas al stock") : null,
    discounted > 0 ? units(discounted, "reincorporada al stock con descuento", "reincorporadas al stock con descuento") : null,
    writtenOff > 0 ? units(writtenOff, "dada de baja", "dadas de baja") : null,
    kept > 0 ? units(kept, "quedó en poder del cliente", "quedaron en poder del cliente") : null,
  ].filter((line): line is string => line !== null)
}

/** Título corto del destino: "Reincorporada al stock", "Dada de baja" o el detalle si hay varios. */
export function getClaimProductOutcomeTitle(counts: ClaimProductOutcomeCounts): string | null {
  const lines = getClaimProductOutcomeLines(counts)
  if (lines.length === 0) return null
  const total = positive(counts.restocked) + positive(counts.discounted) + positive(counts.writtenOff) + positive(counts.keptByCustomer)
  if (lines.length > 1 || total > 1) return lines.join(" · ")
  if (positive(counts.restocked)) return "Reincorporada al stock"
  if (positive(counts.discounted)) return "Reincorporada al stock con descuento"
  if (positive(counts.writtenOff)) return "Dada de baja"
  return "Quedó en poder del cliente"
}

/** Destino registrado por una recepción (metadata de return_inventory_processed). */
export function getReturnReceptionOutcomeLines(metadata: Record<string, unknown> | null | undefined): string[] {
  const read = (key: string) => positive(Number(metadata?.[key]))
  return getClaimProductOutcomeLines({
    restocked: read("sellableQuantity"),
    discounted: read("discountedQuantity"),
    writtenOff: read("nonSellableQuantity"),
  })
}

/**
 * Destino de las unidades reclamadas de un ítem. Con unidades por reclamo
 * (logística nueva) se usan esas; en reclamos históricos, la recepción del
 * ítem acotada a lo reclamado. Lo que nunca se recibió sigue con el cliente
 * sólo si el reclamo ya terminó (includeNotReturned).
 */
export function getClaimItemOutcomeCounts(input: {
  claimedQuantity: number
  restockedQuantity?: number | null
  writtenOffQuantity?: number | null
  units?: ReadonlyArray<{ role: string; location: string }> | null
  includeNotReturned: boolean
}): ClaimProductOutcomeCounts {
  const claimed = positive(input.claimedQuantity)
  const originals = (input.units ?? []).filter((unit) => unit.role === "original")
  if (originals.length > 0) {
    const count = (locations: string[]) => originals.filter((unit) => locations.includes(unit.location)).length
    return {
      restocked: count(["reincorporada_stock"]),
      writtenOff: count(["baja"]),
      keptByCustomer: input.includeNotReturned ? count(["conservada_cliente", "con_cliente"]) : 0,
    }
  }
  const restocked = Math.min(claimed, positive(input.restockedQuantity ?? 0))
  const writtenOff = Math.min(claimed - restocked, positive(input.writtenOffQuantity ?? 0))
  return {
    restocked,
    writtenOff,
    keptByCustomer: input.includeNotReturned ? claimed - restocked - writtenOff : 0,
  }
}
