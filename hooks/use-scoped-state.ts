"use client"

import { useCallback, useState, type SetStateAction } from "react"

/**
 * Estado de edición local atado a una entidad (p. ej. `${orderId}:${claimId}`).
 *
 * - Los refrescos de datos del servidor (polling, realtime, refetch) no lo
 *   tocan: sólo depende de `scope`, nunca de los objetos remotos.
 * - Si cambia `scope` (otro pedido/reclamo), el valor vuelve al inicial en el
 *   mismo render (patrón de React para derivar estado de props), sin un
 *   efecto que pise lo escrito ni un frame con datos de la entidad anterior.
 * - Una escritura tardía de la entidad anterior (p. ej. al terminar un
 *   request después de cambiar de reclamo) se descarta: no mezcla borradores.
 *
 * `initialValue` debe ser un valor "vacío" estable (el inicial de un
 * borrador), no un dato remoto: lo remoto se lee directo de las props.
 */
export function useScopedState<T>(scope: string, initialValue: T) {
  const [state, setState] = useState(() => ({ scope, value: initialValue }))

  let current = state
  if (state.scope !== scope) {
    current = { scope, value: initialValue }
    setState(current)
  }

  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      setState((previous) => {
        if (previous.scope !== scope) return previous
        const value =
          typeof next === "function" ? (next as (value: T) => T)(previous.value) : next
        return { scope, value }
      })
    },
    [scope],
  )

  return [current.value, setValue] as const
}
