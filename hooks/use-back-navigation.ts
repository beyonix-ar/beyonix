"use client"

import { useMemo } from "react"
import { useRouter } from "next/navigation"

import { readHistoryStack } from "@/lib/navigation/history-stack-storage"
import { previousInternalUrl } from "@/lib/navigation/history-stack"

/**
 * "Volver" con el historial real de la tienda:
 * - back(fallback): vuelve a la pantalla anterior si es de BEYONIX; si el
 *   usuario entró directo (sin historial interno), va a `fallback` en vez de
 *   sacarlo del sitio.
 * - backTo(target): para botones "Volver a X": si la pantalla anterior es X,
 *   retrocede (no duplica entradas); si no, navega a X.
 */
export function useBackNavigation() {
  const router = useRouter()

  return useMemo(() => {
    const previous = () => previousInternalUrl(readHistoryStack(), window.history.length)

    return {
      back(fallback: string) {
        if (previous()) router.back()
        else router.push(fallback)
      },
      backTo(target: string, matches: (previousUrl: string) => boolean = (url) => url === target) {
        const url = previous()
        if (url && matches(url)) router.back()
        else router.push(target)
      },
    }
  }, [router])
}
