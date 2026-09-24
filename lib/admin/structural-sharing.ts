// Structural sharing para datos remotos del admin.
//
// Un refetch (polling, realtime, recarga silenciosa) devuelve objetos nuevos
// aunque el contenido sea idéntico. Eso cambia la identidad de arrays como
// `orden_items` o `claim.affected_items` y re-dispara cualquier effect/memo
// que dependa de ellos. `shareUnchanged` conserva la referencia anterior de
// cada subárbol cuyo contenido no cambió y sólo crea objetos nuevos donde
// realmente hubo cambios.
//
// Los arrays de entidades (objetos con `id` único) se emparejan por `id`, de
// modo que reordenar o insertar una fila no invalida las demás.

type PlainObject = Record<string, unknown>

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function getEntityId(value: unknown): string | number | null {
  if (!isPlainObject(value)) return null
  const id = value.id
  return typeof id === "string" || typeof id === "number" ? id : null
}

function indexById(values: unknown[]): Map<string | number, unknown> | null {
  const byId = new Map<string | number, unknown>()
  for (const value of values) {
    const id = getEntityId(value)
    if (id === null || byId.has(id)) return null
    byId.set(id, value)
  }
  return byId
}

function shareValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous

  if (Array.isArray(previous) && Array.isArray(next)) {
    const previousById = next.length > 0 && indexById(next) !== null ? indexById(previous) : null
    let unchanged = previous.length === next.length
    const shared = next.map((item, index) => {
      const candidate = previousById ? previousById.get(getEntityId(item) ?? "") : previous[index]
      const value = shareValue(candidate, item)
      if (value !== previous[index]) unchanged = false
      return value
    })
    return unchanged ? previous : shared
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const nextKeys = Object.keys(next)
    let unchanged = nextKeys.length === Object.keys(previous).length
    const shared: PlainObject = {}
    for (const key of nextKeys) {
      const value = shareValue(previous[key], next[key])
      shared[key] = value
      if (!Object.prototype.hasOwnProperty.call(previous, key) || value !== previous[key]) {
        unchanged = false
      }
    }
    return unchanged ? previous : shared
  }

  return next
}

/**
 * Devuelve `next` reutilizando las referencias de `previous` donde el
 * contenido es igual. Si todo es igual, devuelve `previous` tal cual.
 * Sólo reutiliza valores estructuralmente iguales, así que el resultado
 * siempre tiene exactamente el contenido de `next`.
 */
export function shareUnchanged<T>(previous: T | null | undefined, next: T): T {
  // shareValue devuelve siempre un valor con la forma de `next` (o una
  // referencia previa de contenido idéntico), por eso el tipo se conserva.
  return shareValue(previous, next) as T
}
