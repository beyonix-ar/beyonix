import type { ReactNode } from "react"
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { ChevronLeft } from "lucide-react"

import { cn } from "@/lib/utils"

export function AccountPageContainer({
  children,
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      className={cn(
        "mx-auto w-full max-w-[var(--beyonix-content-max)] px-4 sm:px-6 lg:px-8",
        className
      )}
      {...props}
    >
      {children}
    </Comp>
  )
}

export const beyonixButtonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border font-heading text-sm font-semibold leading-none outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-3 focus-visible:ring-[var(--account-focus-ring)]",
  {
    variants: {
      variant: {
        primary:
          "border-[var(--account-border-highlight)] bg-[var(--account-accent)] text-[var(--account-text-primary)] shadow-[0_0_14px_rgba(47,111,163,0.14)] hover:border-[var(--account-border-strong)] hover:bg-[var(--account-accent-hover)]",
        secondary:
          "border-[var(--account-border)] bg-[var(--account-surface-raised)] text-[var(--account-text-primary)] hover:border-[var(--account-border-strong)] hover:bg-[var(--account-surface-hover)]",
        outline:
          "border-[var(--account-border)] bg-[var(--account-surface)] text-[var(--account-text-secondary)] hover:border-[var(--account-border-strong)] hover:text-[var(--account-text-primary)]",
        ghost:
          "border-transparent bg-transparent text-[var(--account-text-secondary)] hover:bg-[var(--account-surface-raised)] hover:text-[var(--account-text-primary)]",
        danger:
          "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)] hover:border-[var(--account-danger)] hover:text-[var(--account-danger)]",
        icon:
          "border-[var(--account-border)] bg-[var(--account-surface-raised)] text-[var(--account-text-secondary)] hover:border-[var(--account-border-strong)] hover:text-[var(--account-text-primary)]",
      },
      size: {
        sm: "h-9 px-3 text-xs",
        md: "h-10 px-4",
        lg: "h-11 px-5",
        icon: "size-10 p-0",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      fullWidth: false,
    },
  },
)

export function BeyonixButton({
  className,
  variant,
  size,
  fullWidth,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof beyonixButtonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      type={asChild ? type : type ?? "button"}
      className={cn(beyonixButtonVariants({ variant, size, fullWidth }), className)}
      {...props}
    />
  )
}

export const accountCardVariants = cva(
  "rounded-2xl border transition-all duration-200",
  {
    variants: {
      variant: {
        default:
          "border-[var(--account-border)] bg-[var(--account-surface)] shadow-[0_18px_46px_rgba(0,0,0,0.24)]",
        secondary:
          "border-[var(--account-border-subtle)] bg-[var(--account-surface-raised)]",
        interactive:
          "border-[var(--account-border)] bg-[var(--account-surface)] text-left shadow-[0_18px_46px_rgba(0,0,0,0.22)] hover:border-[var(--account-border-strong)] hover:bg-[var(--account-surface-hover)] hover:shadow-[var(--account-glow-subtle)]",
        highlighted:
          "border-[var(--account-border-highlight)] bg-[var(--account-surface-highlight)] shadow-[var(--account-glow-subtle)]",
        form:
          "border-[var(--account-border)] bg-[var(--account-surface)] shadow-[0_18px_46px_rgba(0,0,0,0.24)]",
        emptyState:
          "border-[var(--account-border)] bg-[var(--account-surface)] text-center shadow-[0_18px_46px_rgba(0,0,0,0.24)]",
      },
      padding: {
        none: "",
        sm: "p-3",
        md: "p-4 sm:p-5",
        lg: "p-6 sm:p-7",
      },
    },
    defaultVariants: {
      variant: "default",
      padding: "md",
    },
  },
)

export function AccountCard({
  className,
  variant,
  padding,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof accountCardVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      className={cn(accountCardVariants({ variant, padding }), className)}
      {...props}
    />
  )
}

export function AccountBackButton({
  label = "Volver a mi cuenta",
  className,
  ...props
}: React.ComponentProps<"button"> & {
  label?: string
}) {
  return (
    <BeyonixButton
      variant="outline"
      size="sm"
      className={cn("w-fit", className)}
      {...props}
    >
      <ChevronLeft className="size-4" />
      {label}
    </BeyonixButton>
  )
}

export function AccountPageHeader({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <AccountCard className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-11px font-semibold uppercase tracking-widest text-[var(--account-accent-soft)]">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--account-text-primary)] sm:text-3xl">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--account-text-secondary)]">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </AccountCard>
  )
}

const iconContainerVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center border text-white transition-all duration-200",
  {
    variants: {
      tone: {
        default:
          "border-[var(--account-border-highlight)] bg-[linear-gradient(135deg,rgba(17,42,67,0.96),rgba(7,18,31,0.94))] shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_0_18px_rgba(30,140,255,0.13)]",
        subtle:
          "border-[var(--account-border)] bg-[var(--account-surface-raised)]",
        highlight:
          "border-[var(--account-border-strong)] bg-[var(--account-surface-highlight)] shadow-[var(--account-glow-subtle)]",
        success:
          "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
        danger:
          "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
      },
      size: {
        sm: "size-8 rounded-lg [&_svg]:size-4",
        md: "size-10 rounded-xl [&_svg]:size-5",
        lg: "size-14 rounded-2xl [&_svg]:size-6",
      },
    },
    defaultVariants: {
      tone: "default",
      size: "md",
    },
  },
)

export function IconContainer({
  children,
  className,
  tone,
  size,
  dollarBadge = false,
}: {
  children: ReactNode
  className?: string
  tone?: VariantProps<typeof iconContainerVariants>["tone"]
  size?: VariantProps<typeof iconContainerVariants>["size"]
  dollarBadge?: boolean
}) {
  return (
    <span className={cn(iconContainerVariants({ tone, size }), className)}>
      {children}
      {dollarBadge && (
        <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-white/24 bg-white text-[10px] font-black leading-none text-[#07121E]">
          $
        </span>
      )}
    </span>
  )
}

export function AccountEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  className?: string
}) {
  return (
    <AccountCard variant="emptyState" padding="lg" className={cn("flex min-h-64 flex-col items-center justify-center", className)}>
      <IconContainer size="lg" tone="highlight" className="mb-4">
        {icon}
      </IconContainer>
      <h2 className="text-xl font-bold text-[var(--account-text-primary)]">
        {title}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-[var(--account-text-secondary)]">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </AccountCard>
  )
}

export function AccountFormGrid({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "grid gap-3 md:grid-cols-2 xl:grid-cols-3",
        className
      )}
    >
      {children}
    </div>
  )
}
