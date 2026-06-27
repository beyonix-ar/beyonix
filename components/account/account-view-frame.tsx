import type { ReactNode } from "react"
import { ChevronLeft } from "lucide-react"

export function AccountViewFrame({
  onBack,
  kicker,
  title,
  children,
  maxWidth = "max-w-4xl",
  hideHeading = false,
}: {
  onBack: () => void
  kicker: string
  title: string
  children: ReactNode
  maxWidth?: string
  hideHeading?: boolean
}) {
  return (
    <div className={`mx-auto ${maxWidth} space-y-5`}>
      <button
        type="button"
        aria-label="Volver a mi cuenta"
        title="Volver a mi cuenta"
        onClick={onBack}
        className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-white/6 px-4 text-sm font-semibold text-white/82 shadow-lg shadow-black/20 transition-all hover:border-beyonix-blue-light/45 hover:bg-beyonix-blue/35 hover:text-white"
      >
        <ChevronLeft className="size-4" />
        Volver a mi cuenta
      </button>

      {!hideHeading && (
        <div className="rounded-2xl border border-white/8 bg-beyonix-surface px-5 py-5 shadow-2xl shadow-black/25 sm:px-6">
          <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            {kicker}
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">
            {title}
          </h2>
        </div>
      )}

      {children}
    </div>
  )
}
