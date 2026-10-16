import type { ReactNode } from "react"
import { Check } from "lucide-react"

import type { DispatchStage } from "@/lib/admin/dispatch"

export type PreparationStepState = "done" | "current" | "pending"

export const PREPARATION_STEPS = ["Pickeo", "Identificar pedido", "Medidas del paquete", "Listo para Bulto general"] as const

// Paso alcanzado según la etapa server-side del pedido (dispatchStage).
const REACHED_STEP: Record<DispatchStage, number> = {
  pending: 0, packing: 0, identify: 1, measures: 2, parcels_ready: 3, in_batch: 4, batch_closed: 4, handed_over: 4,
}

/** Estado de cada paso: el último ("Listo para Bulto general") cuenta como completo al alcanzarse. */
export function preparationStepStates(stage: DispatchStage): PreparationStepState[] {
  const reached = REACHED_STEP[stage]
  return PREPARATION_STEPS.map((_, index) => index < reached || (index === 3 && reached === 3) ? "done" : index === reached ? "current" : "pending")
}

const STATE_TEXT: Record<PreparationStepState, string> = { done: "completo", current: "paso actual", pending: "pendiente" }

/** Un paso del flujo de preparación: número, título, ayuda corta y, si corresponde, su acción. */
export function PreparationStep({ index, state, hint, children }: {
  index: number
  state: PreparationStepState
  hint?: ReactNode
  children?: ReactNode
}) {
  return <li className="dispatch-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
    <span className="dispatch-step-marker" aria-hidden="true">{state === "done" ? <Check className="size-4" strokeWidth={3} /> : index + 1}</span>
    <div className="min-w-0 flex-1">
      <p className="dispatch-step-title">{PREPARATION_STEPS[index]}<span className="sr-only"> ({STATE_TEXT[state]})</span></p>
      {hint ? <div className="mt-0.5 text-xs text-white/60">{hint}</div> : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  </li>
}
