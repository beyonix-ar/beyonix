import { useEffect, useRef, type RefObject } from "react"

/**
 * Lleva `targetRef` al inicio del viewport sólo cuando `step` cambia de
 * verdad (avanzar o volver). No desplaza al montar ni ante re-renders o
 * refetch del mismo paso. El offset del header sticky lo define el propio
 * destino con `scroll-margin-top`.
 */
export function useScrollOnStepChange(
  step: number,
  targetRef: RefObject<HTMLElement | null>,
) {
  const previousStep = useRef(step)

  useEffect(() => {
    if (previousStep.current === step) return
    previousStep.current = step

    const frame = requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [step, targetRef])
}
