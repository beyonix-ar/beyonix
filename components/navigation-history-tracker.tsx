"use client"

import { useEffect, useRef } from "react"
import { usePathname, useSearchParams } from "next/navigation"

import {
  createHistoryStack,
  recordNavigation,
  restoreHistoryStack,
} from "@/lib/navigation/history-stack"
import { readHistoryStack, writeHistoryStack } from "@/lib/navigation/history-stack-storage"

/**
 * Observa la navegación interna (sin tocar window.history ni bloquear el
 * botón Atrás) y mantiene la pila de URLs de BEYONIX de esta pestaña. La usa
 * useBackNavigation para decidir entre router.back() y una ruta de respaldo.
 */
export function NavigationHistoryTracker() {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const initializedRef = useRef(false)
  // URL en la que ocurrió el último popstate: sólo cuenta como "Atrás" si la
  // navegación que sigue llega a esa misma URL (los cambios de #hash también
  // disparan popstate y no deben confundirse con un Atrás).
  const popUrlRef = useRef<string | null>(null)

  useEffect(() => {
    const handlePop = () => {
      popUrlRef.current = `${window.location.pathname}${window.location.search}`
    }
    window.addEventListener("popstate", handlePop)
    return () => window.removeEventListener("popstate", handlePop)
  }, [])

  useEffect(() => {
    const url = `${pathname}${search ? `?${search}` : ""}`
    const saved = readHistoryStack()
    const historyLength = window.history.length

    if (!initializedRef.current) {
      initializedRef.current = true
      writeHistoryStack(restoreHistoryStack(saved, url, historyLength))
      return
    }

    const cause = popUrlRef.current === url ? "pop" : "change"
    popUrlRef.current = null
    writeHistoryStack(recordNavigation(saved ?? createHistoryStack(url, historyLength), url, historyLength, cause))
  }, [pathname, search])

  return null
}
