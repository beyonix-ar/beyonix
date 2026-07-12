import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { Footer } from "@/components/footer"
import {
  BeyonixCard,
  BeyonixIconBox,
} from "@/components/beyonix-ui"
import { cn } from "@/lib/utils"

type CheckoutStatusTone = "success" | "pending" | "failure" | "info"

const statusToneStyles: Record<
  CheckoutStatusTone,
  {
    icon: "default" | "success" | "danger"
    iconClassName: string
  }
> = {
  success: {
    icon: "success",
    iconClassName: "text-emerald-100",
  },
  pending: {
    icon: "default",
    iconClassName: "text-amber-200",
  },
  failure: {
    icon: "danger",
    iconClassName: "text-red-100",
  },
  info: {
    icon: "default",
    iconClassName: "text-beyonix-sky",
  },
}

export function CheckoutStatusShell({
  children,
}: {
  children: ReactNode
}) {
  return (
    <>
      <main className="min-h-screen bg-[#05070A] px-4 py-6 font-heading text-white sm:py-8">
        <div className="mx-auto w-full max-w-[1075px]">{children}</div>
      </main>
      <Footer />
    </>
  )
}

export function CheckoutStatusCard({
  tone,
  icon: Icon,
  eyebrow,
  title,
  description,
  orderId,
  children,
  footer,
  className,
}: {
  tone: CheckoutStatusTone
  icon: LucideIcon
  eyebrow: ReactNode
  title: ReactNode
  description?: ReactNode
  orderId?: number
  children?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const styles = statusToneStyles[tone]

  return (
    <BeyonixCard
      variant="elevated"
      className={cn(
        "overflow-hidden rounded-2xl border-beyonix-blue-light/18 bg-[#0B1118] shadow-2xl shadow-black/45",
        className,
      )}
    >
      <div className="border-b border-beyonix-blue-light/14 px-4 py-6 text-center sm:px-6">
        <BeyonixIconBox
          variant={styles.icon}
          size="lg"
          className={cn("mx-auto", styles.iconClassName)}
        >
          <Icon className="size-6" />
        </BeyonixIconBox>

        <p className="mt-3 text-10px font-semibold uppercase tracking-[0.2em] text-beyonix-cyan/82">
          {eyebrow}
        </p>

        <h1 className="mx-auto mt-1.5 max-w-2xl text-2xl font-bold tracking-tight text-white sm:text-3xl">
          {title}
        </h1>

        {description && (
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-white/62">
            {description}
          </p>
        )}

        {Number.isFinite(orderId) && Number(orderId) > 0 && (
          <p className="mt-2 text-xs font-semibold text-white/46">
            Pedido #{orderId}
          </p>
        )}
      </div>

      {children && <div className="px-4 py-4 sm:px-5">{children}</div>}

      {footer && (
        <div className="border-t border-beyonix-blue-light/14 px-4 py-4 sm:px-5">
          {footer}
        </div>
      )}
    </BeyonixCard>
  )
}

export function CheckoutStatusPanel({
  id,
  title,
  children,
  className,
}: {
  id?: string
  title: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-xl border border-beyonix-blue-light/16 bg-[#10151C] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] sm:p-4",
        className,
      )}
    >
      <h2 className="border-l-4 border-beyonix-blue pl-3 text-lg font-bold text-white">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function CheckoutStatusNotice({
  children,
  tone = "info",
  className,
}: {
  children: ReactNode
  tone?: CheckoutStatusTone
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-3.5 py-2.5 text-sm leading-5",
        tone === "failure"
          ? "border-red-400/20 bg-red-500/10 text-red-200"
          : tone === "pending"
            ? "border-amber-300/22 bg-amber-300/[0.055] text-white/82"
            : tone === "success"
              ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
              : "border-beyonix-blue-light/18 bg-[#10151C] text-white/70",
        className,
      )}
    >
      {children}
    </div>
  )
}
