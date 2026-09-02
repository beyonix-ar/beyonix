import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { Footer } from "@/components/footer"
import {
  BeyonixIconBox,
} from "@/components/beyonix-ui"
import { cn } from "@/lib/utils"

type CheckoutStatusTone = "success" | "pending" | "failure" | "info"

// --account-* (ver app/globals.css): mismo sistema de tokens que el resto
// del storefront (Checkout, Login, Cuenta) -- ya trae su propia variante
// oscura (:root) y clara (html[data-account-theme="light"]), a diferencia
// del sistema beyonix-gray-*/beyonix-blue-900 que usaba esta pantalla antes
// (colores fijos pensados sólo para Dark, sin variante clara real). Al
// consumir estos tokens en vez de esa paleta paralela, toda la pantalla de
// estado (Éxito/Falla/Pendiente) queda theme-aware de raíz, sin necesitar
// overrides puntuales por página.
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
      "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success)]",
  },
  pending: {
    icon: "default",
    iconClassName:
      "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning)]",
  },
  failure: {
    icon: "danger",
    iconClassName:
      "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger)]",
  },
  info: {
    icon: "default",
    iconClassName:
      "border-[var(--account-info-border)] bg-[var(--account-info-bg)] text-[var(--account-info)]",
  },
}

export function CheckoutStatusShell({
  children,
}: {
  children: ReactNode
}) {
  return (
    <>
      <main className="min-h-screen bg-[var(--account-background)] px-4 py-6 font-heading text-[var(--account-text-primary)] sm:py-8">
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
        "w-full min-w-0 overflow-hidden rounded-2xl border border-[var(--account-border-subtle)] bg-[var(--account-surface)] shadow-lg shadow-black/10",
        className,
      )}
    >
      {/* Header: navy BEYONIX fijo (#112A43) en cualquier tema -- mismo
          criterio que cualquier CTA/superficie navy del sitio, foreground
          siempre blanco. */}
      <div
        className={cn(
          "bg-[var(--account-accent)] px-5 py-5 text-center sm:px-8 sm:py-6",
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

        <p className="mt-2.5 text-10px font-semibold uppercase tracking-widest text-white/60">
          {eyebrow}
        </p>

        <h1
          className={cn(
            "mx-auto mt-1.5 max-w-2xl font-bold tracking-tight text-white",
            compact ? "text-2xl sm:text-[28px]" : "text-2xl sm:text-3xl",
          )}
        >
          {title}
        </h1>

        {description && (
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-white/72">
            {description}
          </p>
        )}

        {Number.isFinite(orderId) && Number(orderId) > 0 && (
          <p className="mt-2 text-xs font-medium text-white/48">
            Pedido #{orderId}
          </p>
        )}
      </div>

      {children && (
        <div
          className={cn(
            "bg-[var(--account-background)] px-4 py-4 sm:px-6 sm:py-5",
            bodyClassName,
          )}
        >
          {children}
        </div>
      )}

      {footer && (
        <div
          className={cn(
            "border-t border-[var(--account-border-subtle)] bg-[var(--account-surface)] px-4 py-3.5 sm:px-6",
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
        "min-w-0 rounded-xl border border-[var(--account-border-subtle)] bg-[var(--account-surface)] p-4 sm:p-5",
        className,
      )}
    >
      <h2
        className={cn(
          "text-base font-bold text-[var(--account-text-primary)]",
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
          ? "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger)]"
          : tone === "pending"
            ? "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-text-primary)]"
            : tone === "success"
              ? "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success)]"
              : "border-[var(--account-border)] bg-[var(--account-surface-raised)] text-[var(--account-text-secondary)]",
        className,
      )}
    >
      {children}
    </div>
  )
}
