"use client"

import { useEffect, useRef } from "react"

type VantaEffect = {
  destroy: () => void
}

export function ElectricBackground() {
  const backgroundRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let effect: VantaEffect | null = null
    let cancelled = false

    const initVanta = async () => {
      const [THREE, vantaModule] = await Promise.all([
        import("three"),
        import("vanta/dist/vanta.net.min"),
      ])
      const VANTA_NET = vantaModule.default

      if (cancelled || !backgroundRef.current) return

      effect = VANTA_NET({
        el: backgroundRef.current,
        THREE,
        mouseControls: true,
        touchControls: true,
        gyroControls: false,
        minHeight: 200.0,
        minWidth: 200.0,
        scale: 1.0,
        scaleMobile: 1.0,
        color: 1914774,
        backgroundColor: 0x000000,
        backgroundAlpha: 1,
        points: 14.0,
        maxDistance: 20.0,
        spacing: 13.0,
        showDots: false,
      })
    }

    initVanta()

    return () => {
      cancelled = true
      effect?.destroy()
    }
  }, [])

  return (
    <div
      ref={backgroundRef}
      aria-hidden="true"
      className="beyonix-electric-background"
    />
  )
}
