import * as React from "react"
import Link from "next/link"
import { User } from "lucide-react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { beyonixHoverBorder, beyonixInteractiveOutline, cn } from "@/lib/utils"

const beyonixButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl font-heading text-sm font-semibold leading-none outline-none transition-all duration-200 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          // text-white fijo (no un token): el fondo es el azul de marca,
          // que se mantiene oscuro en ambos temas.
          "border border-beyonix-blue-light/48 bg-beyonix-blue text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25 active:bg-beyonix-blue",
        secondary:
          "border border-beyonix-blue-light/24 bg-beyonix-blue/20 text-white hover:border-beyonix-blue-light/55 hover:bg-beyonix-blue/32 focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25",
        outline: cn(
          // Superficie propia (--beyonix-btn-secondary-bg), no
          // bg-beyonix-surface: ese token es blanco puro en Light y el
          // botón se perdía contra el resto de superficies claras del
          // sitio (Ver categorías, Ver todas, etc).
          "bg-[var(--beyonix-btn-secondary-bg)] text-[var(--beyonix-text-secondary)] hover:bg-[var(--beyonix-btn-secondary-bg-hover)] hover:text-[var(--beyonix-text-primary)] active:bg-[var(--beyonix-btn-secondary-bg-active)] focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25",
          beyonixInteractiveOutline
        ),
        ghost:
          "border border-transparent bg-transparent text-[var(--beyonix-text-secondary)] hover:bg-[var(--beyonix-surface-interactive)] hover:text-[var(--beyonix-text-primary)] focus-visible:border-beyonix-blue-light focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25",
        destructive:
          "border border-red-400/34 bg-red-500/12 text-red-200 hover:border-red-400/70 hover:bg-red-500/18 hover:text-red-100 focus-visible:ring-2 focus-visible:ring-red-400/25",
        success:
          "border border-emerald-400/34 bg-emerald-500/14 text-emerald-100 hover:border-emerald-300/60 hover:bg-emerald-500/22 focus-visible:ring-2 focus-visible:ring-emerald-300/25",
        icon: cn(
          "bg-beyonix-surface-2 text-[var(--beyonix-text-secondary)] hover:bg-beyonix-surface-3 hover:text-[var(--beyonix-text-primary)] focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25",
          beyonixInteractiveOutline
        ),
        link:
          "rounded-none border border-transparent bg-transparent p-0 text-beyonix-sky underline-offset-4 hover:text-white hover:underline focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25",
      },
      size: {
        sm: "h-9 px-3.5 text-xs",
        md: "h-11 px-5",
        lg: "h-12 px-6 text-[15px]",
        icon: "size-10 p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
)

export type BeyonixButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof beyonixButtonVariants> & {
    asChild?: boolean
  }

export function BeyonixButton({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: BeyonixButtonProps) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      type={asChild ? type : type ?? "button"}
      className={cn(beyonixButtonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

const beyonixCardVariants = cva(
  "rounded-2xl border shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_18px_44px_rgba(0,0,0,0.22)]",
  {
    variants: {
      variant: {
        default: "border-beyonix-blue-light/18 bg-beyonix-surface text-[var(--beyonix-text-primary)]",
        elevated:
          "border-beyonix-blue-light/22 bg-beyonix-surface-2 text-[var(--beyonix-text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_24px_60px_rgba(0,0,0,0.32)]",
        interactive: cn(
          "bg-beyonix-surface text-[var(--beyonix-text-primary)] hover:bg-beyonix-surface-2 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_22px_52px_rgba(0,0,0,0.34)]",
          beyonixInteractiveOutline
        ),
        // selected/highlighted usan fondo de acento azul marino fijo (no
        // token) -- el texto blanco se mantiene fijo a propósito, el fondo
        // no se aclara en light.
        selected:
          "border-beyonix-blue-light/70 bg-beyonix-blue/28 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_0_1px_rgba(30,77,123,0.28),0_22px_52px_rgba(0,0,0,0.34)]",
        highlighted:
          // beyonix-card-highlighted: hook para el override de Light en
          // globals.css (gradiente gris claro en vez del navy casi negro
          // fijo de acá, que en Light quedaba ilegible).
          "beyonix-card-highlighted border-beyonix-blue-light/36 bg-[linear-gradient(145deg,rgba(17,42,67,0.48),rgba(10,10,10,0.98))] text-white",
        muted: "border-beyonix-blue-light/12 bg-beyonix-surface/72 text-[var(--beyonix-text-secondary)]",
        "empty-state": "border-beyonix-blue-light/18 bg-beyonix-surface-2 text-[var(--beyonix-text-primary)]",
        product: cn(
          "bg-beyonix-surface text-[var(--beyonix-text-primary)] transition-transform duration-200 hover:-translate-y-0.5 hover:bg-beyonix-surface-2",
          beyonixInteractiveOutline
        ),
        information: "border-beyonix-blue-light/16 bg-beyonix-surface text-[var(--beyonix-text-primary)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export type BeyonixCardProps = React.ComponentProps<"div"> &
  VariantProps<typeof beyonixCardVariants> & {
    asChild?: boolean
  }

export function BeyonixCard({
  className,
  variant,
  asChild = false,
  ...props
}: BeyonixCardProps) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      className={cn(beyonixCardVariants({ variant, className }))}
      {...props}
    />
  )
}

const beyonixIconBoxVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-xl border transition-colors duration-200",
  {
    variants: {
      variant: {
        // bg fijo de acento azul marino (no token) -- texto blanco a
        // propósito, no se aclara en light.
        default: "border-beyonix-blue-light/28 bg-beyonix-blue text-white",
        strong: "border-beyonix-blue-light/42 bg-beyonix-blue text-white",
        muted: "border-beyonix-blue-light/14 bg-beyonix-surface-2 text-[var(--beyonix-text-secondary)]",
        success: "border-emerald-400/30 bg-emerald-500/14 text-emerald-100",
        danger: "border-red-400/30 bg-red-500/12 text-red-100",
      },
      size: {
        sm: "size-8",
        md: "size-10",
        lg: "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
)

export type BeyonixIconBoxProps = React.ComponentProps<"span"> &
  VariantProps<typeof beyonixIconBoxVariants>

export function BeyonixIconBox({
  className,
  variant,
  size,
  ...props
}: BeyonixIconBoxProps) {
  return (
    <span
      className={cn(beyonixIconBoxVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export function BeyonixSectionHeader({
  eyebrow,
  title,
  description,
  action,
  align = "left",
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  align?: "left" | "center"
  className?: string
}) {
  return (
    <div
      className={cn(
        "mb-[clamp(2rem,3.5vw,3rem)] flex flex-col gap-4",
        align === "center"
          ? "items-center text-center"
          : "lg:flex-row lg:items-end lg:justify-between",
        className
      )}
    >
      <div className={cn(align === "center" && "mx-auto")}>
        {eyebrow && (
          <p className="beyonix-modal-action mb-2 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            {eyebrow}
          </p>
        )}
        <h2 className="beyonix-modal-title max-w-3xl text-[clamp(1.85rem,2.8vw,3rem)] font-bold tracking-tight text-white">
          {title}
        </h2>
        {description && (
          <p
            className={cn(
              "beyonix-modal-body mt-3 max-w-2xl text-sm leading-6 text-white/60",
              align === "center" && "mx-auto"
            )}
          >
            {description}
          </p>
        )}
      </div>

      {action && <div className="shrink-0 self-start lg:self-auto">{action}</div>}
    </div>
  )
}

export function BeyonixEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <BeyonixCard
      variant="empty-state"
      className={cn(
        "mx-auto flex min-h-220px max-w-2xl flex-col items-center justify-center p-8 text-center",
        className
      )}
    >
      {icon && (
        <BeyonixIconBox size="lg" className="mb-4 text-beyonix-sky">
          {icon}
        </BeyonixIconBox>
      )}
      <h3 className="beyonix-modal-title text-lg font-semibold text-white">{title}</h3>
      {description && (
        <p className="beyonix-modal-body mt-2 max-w-md text-sm leading-6 text-white/58">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </BeyonixCard>
  )
}

// CTAs canónicos de "Iniciar sesión"/"Registrarse" para el header y
// cualquier mini-header equivalente (ej. Checkout) -- fuente única para que
// ambos lugares muestren exactamente el mismo componente en vez de cada
// uno reimplementando las clases a mano (causa real de que "Registrarse"
// se viera distinto entre Home y Checkout). No se usa en el menú mobile:
// ahí el botón es un bloque full-width dentro de una lista apilada, una
// forma distinta por motivos de layout, no el mismo componente visual.
export function BeyonixHeaderLoginLink({
  href,
  className,
}: {
  href: string
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "beyonix-modal-body flex h-11 cursor-pointer items-center gap-2 rounded-full px-3.5 text-sm font-medium text-white/78 hover:text-white",
        beyonixHoverBorder,
        className
      )}
    >
      <User className="size-3.5" />
      Iniciar sesión
    </Link>
  )
}

export function BeyonixHeaderRegisterLink({
  href,
  className,
}: {
  href: string
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-11 cursor-pointer items-center rounded-full border border-beyonix-blue-light/45 bg-beyonix-blue px-4 text-sm font-semibold text-white transition-all hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover",
        className
      )}
    >
      Registrarse
    </Link>
  )
}

