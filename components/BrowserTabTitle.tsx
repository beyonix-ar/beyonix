"use client"

import { useEffect, useRef } from "react"

const DEFAULT_TITLE = "BEYONIX | Tecnología para tu comodidad"
const AWAY_TITLE = "💙 Seguimos conectados..."
const TITLE_INTERVAL_MS = 1500

export function BrowserTabTitle() {
  const intervalRef = useRef<number | null>(null)

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
      document.title = DEFAULT_TITLE
    }

    const startTitleInterval = () => {
      clearTitleInterval()
      document.title = AWAY_TITLE
      intervalRef.current = window.setInterval(() => {
        document.title = document.title === AWAY_TITLE ? DEFAULT_TITLE : AWAY_TITLE
      }, TITLE_INTERVAL_MS)
    }

    const handleVisibilityChange = () => {
      if (document.hidden || document.visibilityState === "hidden") {
        startTitleInterval()
        return
      }

      restoreTitle()
    }

    restoreTitle()
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      restoreTitle()
    }
  }, [])

  return null
}
