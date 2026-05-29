"use client"

import { ChevronDown } from "lucide-react"

interface AdminSelectProps {
  title: string
  value: string
  children: React.ReactNode
  ariaLabel?: string
  onChange: (value: string) => void
}

interface AdminTextInputProps {
  title: string
  value: string
  placeholder: string
  ariaLabel?: string
  icon?: React.ReactNode
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]
  onChange: (value: string) => void
}

export function AdminSelect({
  title,
  value,
  children,
  ariaLabel,
  onChange,
}: AdminSelectProps) {
  return (
    <label className="relative block" title={title}>
      <select
        title={title}
        aria-label={ariaLabel ?? title}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full appearance-none rounded-2xl border border-white/10 bg-black px-4 pr-11 text-sm font-medium text-white/82 outline-none transition-colors hover:border-white/18 focus:border-beyonix-blue-light"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-white/62" />
    </label>
  )
}

export function AdminTextInput({
  title,
  value,
  placeholder,
  ariaLabel,
  icon,
  inputMode,
  onChange,
}: AdminTextInputProps) {
  return (
    <label className="relative block" title={title}>
      {icon && (
        <span className="pointer-events-none absolute left-4 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center text-white/38">
          {icon}
        </span>
      )}
      <input
        type="text"
        title={title}
        aria-label={ariaLabel ?? title}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        className={`h-11 w-full rounded-2xl border border-white/10 bg-black px-4 text-sm font-medium text-white/82 outline-none transition-colors placeholder:text-white/32 hover:border-white/18 focus:border-beyonix-blue-light ${
          icon ? "pl-11" : ""
        }`}
      />
    </label>
  )
}
