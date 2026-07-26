"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"

const AWAY_TITLE = "💙 Seguimos conectados..."
const TITLE_INTERVAL_MS = 1500

export function BrowserTabTitle() {
  const pathname = usePathname()
  const intervalRef = useRef<number | null>(null)
  const visibleTitleRef = useRef("BEYONIX | Tecnología para tu comodidad")

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return
    }

    const clearTitleInterval = () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const restoreTitle = () => {
      clearTitleInterval()
      document.title = visibleTitleRef.current
    }

    const startTitleInterval = () => {
      clearTitleInterval()
      document.title = AWAY_TITLE
      intervalRef.current = window.setInterval(() => {
        document.title =
          document.title === AWAY_TITLE ? visibleTitleRef.current : AWAY_TITLE
      }, TITLE_INTERVAL_MS)
    }

    const handleVisibilityChange = () => {
      if (document.hidden || document.visibilityState === "hidden") {
        startTitleInterval()
        return
      }

      restoreTitle()
    }

    visibleTitleRef.current = document.title
    restoreTitle()
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      clearTitleInterval()
    }
  }, [pathname])

  return null
}
