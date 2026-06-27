import type { ElementType, InputHTMLAttributes, ReactNode } from "react"

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
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div
        className={`relative flex items-center rounded-xl border bg-white/5 transition-colors focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40 ${
          error ? "border-red-500/50" : "border-white/8 hover:border-white/14"
        }`}
      >
        <Icon className="absolute left-3.5 size-4 text-white/40 pointer-events-none" />
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          inputMode={inputMode}
          className="w-full bg-transparent py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-white/25 outline-none"
        />
        {rightElement && <div className="absolute right-3">{rightElement}</div>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
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
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  icon: ElementType
  maxLength?: number
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div className="relative rounded-xl border border-white/8 bg-white/5 transition-colors hover:border-white/14 focus-within:border-beyonix-blue-light focus-within:ring-2 focus-within:ring-beyonix-blue/40">
        <Icon className="pointer-events-none absolute left-3.5 top-3.5 size-4 text-white/40" />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={2}
          className="min-h-20 w-full resize-none bg-transparent py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-white/25 outline-none"
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
}: {
  label: string
  value: string
  icon: ElementType
  help?: string
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold uppercase tracking-widest text-white/60">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-white/5 bg-white/1 px-3.5 py-3">
        <Icon className="size-4 shrink-0 text-white/20" />
        <span className="truncate text-sm text-white/50">{value}</span>
      </div>
      {help && <p className="text-11px text-white/25">{help}</p>}
    </div>
  )
}
