import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { Footer } from "@/components/footer"
import {
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
    iconClassName:
      "border-beyonix-status-success/30 bg-beyonix-status-success/10 text-beyonix-status-success",
  },
  pending: {
    icon: "default",
    iconClassName:
      "border-beyonix-status-pending/30 bg-beyonix-status-pending/10 text-beyonix-status-pending",
  },
  failure: {
    icon: "danger",
    iconClassName:
      "border-beyonix-status-danger/30 bg-beyonix-status-danger/10 text-beyonix-status-danger",
  },
  info: {
    icon: "default",
    iconClassName:
      "border-beyonix-blue-500/50 bg-beyonix-blue-900 text-beyonix-blue-300",
  },
}

export function CheckoutStatusShell({
  children,
}: {
  children: ReactNode
}) {
  return (
    <>
      <main className="min-h-screen bg-beyonix-page px-4 py-3 font-heading text-white sm:py-4">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
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
  headerClassName,
  bodyClassName,
  footerClassName,
  compact = false,
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
  headerClassName?: string
  bodyClassName?: string
  footerClassName?: string
  compact?: boolean
}) {
  const styles = statusToneStyles[tone]

  return (
    <div
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-2xl border border-beyonix-gray-700 bg-beyonix-gray-900 shadow-2xl shadow-black/45",
        className,
      )}
    >
      <div
        className={cn(
          "border-b border-beyonix-blue-500/35 px-4 py-4 text-center sm:px-6",
          headerClassName,
        )}
      >
        <BeyonixIconBox
          variant={styles.icon}
          size={compact ? "md" : "lg"}
          className={cn("mx-auto", styles.iconClassName)}
        >
          <Icon className="size-6" />
        </BeyonixIconBox>

        <p
          className={cn(
            "text-10px font-semibold uppercase tracking-widest text-beyonix-blue-300",
            compact ? "mt-2" : "mt-2.5",
          )}
        >
          {eyebrow}
        </p>

        <h1
          className={cn(
            "mx-auto mt-1.5 max-w-2xl font-bold tracking-tight text-white",
            compact ? "text-xl sm:text-2xl" : "text-2xl sm:text-3xl",
          )}
        >
          {title}
        </h1>

        {description && (
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-beyonix-gray-300">
            {description}
          </p>
        )}

        {Number.isFinite(orderId) && Number(orderId) > 0 && (
          <p className="mt-1.5 text-xs font-semibold text-beyonix-gray-500">
            Pedido #{orderId}
          </p>
        )}
      </div>

      {children && (
        <div className={cn("px-4 py-3 sm:px-5", bodyClassName)}>
          {children}
        </div>
      )}

      {footer && (
        <div
          className={cn(
            "border-t border-beyonix-gray-700 px-4 py-3 sm:px-5",
            footerClassName,
          )}
        >
          {footer}
        </div>
      )}
    </div>
  )
}

export function CheckoutStatusPanel({
  id,
  title,
  children,
  className,
  titleClassName,
}: {
  id?: string
  title: ReactNode
  children: ReactNode
  className?: string
  titleClassName?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        "min-w-0 rounded-xl border border-beyonix-gray-700 bg-beyonix-gray-900 p-3.5 shadow-inner sm:p-4",
        className,
      )}
    >
      <h2
        className={cn(
          "border-l-4 border-beyonix-blue-700 pl-3 text-lg font-bold text-white",
          titleClassName,
        )}
      >
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
          ? "border-beyonix-status-danger/30 bg-beyonix-gray-900 text-beyonix-status-danger"
          : tone === "pending"
            ? "border-beyonix-gray-700 bg-beyonix-gray-900 text-beyonix-gray-300"
            : tone === "success"
              ? "border-beyonix-status-success/30 bg-beyonix-gray-900 text-white"
              : "border-beyonix-gray-700 bg-beyonix-gray-900 text-beyonix-gray-300",
        className,
      )}
    >
      {children}
    </div>
  )
}
