import type { ElementType, InputHTMLAttributes, ReactNode } from "react"

import { cn } from "@/lib/utils"

export function InputField({
  label,
  type,
  value,
  onChange,
  placeholder,
  icon: Icon,
  rightElement,
  error,
  maxLength,
  inputMode,
  className,
}: {
  label: string
  type: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: ElementType
  rightElement?: ReactNode
  error?: string
  maxLength?: number
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"]
  className?: string
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
        {label}
      </label>
      <div
        className={`relative flex h-11 items-center rounded-xl border bg-[var(--account-input)] transition-colors focus-within:border-[var(--account-border-strong)] focus-within:ring-3 focus-within:ring-[var(--account-focus-ring)] ${
          error
            ? "border-[var(--account-danger-border)]"
            : "border-[var(--account-border)] hover:border-[var(--account-border-strong)]"
        }`}
      >
        <Icon className="pointer-events-none absolute left-3.5 size-4 text-[var(--account-text-muted)]" />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          className="h-full w-full bg-transparent pl-10 pr-10 text-sm font-medium text-[var(--account-text-primary)] outline-none placeholder:text-[var(--account-text-muted)]"
        />
        {rightElement && <div className="absolute right-3">{rightElement}</div>}
      </div>
      {error && <p className="text-xs text-[var(--account-danger-text)]">{error}</p>}
    </div>
  )
}

export function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  icon: Icon,
  maxLength,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: ElementType
  maxLength?: number
  className?: string
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
        {label}
      </label>
      <div className="relative rounded-xl border border-[var(--account-border)] bg-[var(--account-input)] transition-colors hover:border-[var(--account-border-strong)] focus-within:border-[var(--account-border-strong)] focus-within:ring-3 focus-within:ring-[var(--account-focus-ring)]">
        <Icon className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-[var(--account-text-muted)]" />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={2}
          className="min-h-16 w-full resize-none bg-transparent py-2.5 pl-10 pr-4 text-sm font-medium text-[var(--account-text-primary)] outline-none placeholder:text-[var(--account-text-muted)]"
        />
      </div>
    </div>
  )
}

export function ReadOnlyField({
  label,
  value,
  icon: Icon,
  help,
  className,
}: {
  label: string
  value: string
  icon: ElementType
  help?: string
  className?: string
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <label className="block text-11px font-semibold uppercase tracking-widest text-[var(--account-text-muted)]">
        {label}
      </label>
      <div className="flex h-11 items-center gap-2 rounded-xl border border-[var(--account-border-subtle)] bg-[var(--account-surface-raised)] px-3.5">
        <Icon className="size-4 shrink-0 text-[var(--account-text-muted)]" />
        <span className="truncate text-sm font-medium text-[var(--account-text-secondary)]">{value}</span>
      </div>
      {help && <p className="text-11px text-[var(--account-text-muted)]">{help}</p>}
    </div>
  )
}
