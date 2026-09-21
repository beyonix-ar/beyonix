import type { OperationalStep } from "@/lib/admin/order-operational-progress"

export function OperationalProgress({ steps }: { steps: OperationalStep[] }) {
  if (!steps.length) return null
  const current = steps.findIndex((step) => !step.complete)
  return <ol aria-label="Progreso operativo" className="my-3 flex flex-wrap gap-2 text-xs">{steps.map((step, index) => <li key={`${index}:${step.label}`} aria-current={current === index ? "step" : undefined} className={`rounded-lg border px-3 py-2 ${step.complete ? "border-emerald-400/30 text-emerald-200" : index === current ? "border-blue-300/50 font-bold" : "border-white/15"}`}>Paso {index + 1} de {steps.length} — {step.label} · {step.complete ? "Completado" : index === current ? "Ahora" : "Pendiente"}</li>)}</ol>
}
