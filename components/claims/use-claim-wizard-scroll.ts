import { useEffect, useRef, type RefObject } from "react"

/** Desplaza sólo ante un cambio real de paso del mismo reclamo. */
export function useClaimWizardScroll(
  claimId: number | null,
  step: string | null,
  enabled: boolean,
  headerRef: RefObject<HTMLElement | null>,
) {
  const previous = useRef<{ claimId: number | null; step: string | null } | null>(null)

  useEffect(() => {
    const last = previous.current
    previous.current = { claimId, step }
    if (!enabled || !last || last.claimId !== claimId || !step || last.step === step) return

    const frame = requestAnimationFrame(() => {
      headerRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [claimId, step, enabled, headerRef])
}
