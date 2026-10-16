import { progressPercent } from "@/lib/admin/dispatch-scan"

/** Avance de unidades, bultos o pedidos: número grande, porcentaje y barra. */
export function DispatchProgress({ done, total, unit, compact = false, className = "" }: {
  done: number
  total: number
  /** "unidades", "bultos", "pedidos". */
  unit: string
  compact?: boolean
  className?: string
}) {
  const percent = progressPercent(done, total)
  const complete = total > 0 && done >= total
  return <div className={className}>
    <div className="flex items-baseline justify-between gap-3">
      <span className={compact ? "text-xs text-white/65" : "text-sm text-white/70"}>
        <span className={`${compact ? "text-sm" : "text-lg"} font-black tabular-nums ${complete ? "text-emerald-300" : "text-white"}`}>{done}</span> de <span className="font-bold tabular-nums text-white">{total}</span> {unit}
      </span>
      <span className="text-xs font-black tabular-nums text-white/60">{percent}%</span>
    </div>
    <div className={`dispatch-progress-track ${compact ? "mt-1.5" : "mt-2"}`} role="progressbar" aria-label={`${done} de ${total} ${unit}`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span className="dispatch-progress-bar" data-complete={complete ? "true" : undefined} style={{ width: `${percent}%` }} />
    </div>
  </div>
}
