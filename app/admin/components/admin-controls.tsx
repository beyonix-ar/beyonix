"use client"

import { Children, isValidElement, useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"

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
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = child.props as {
        value?: string | number
        children?: React.ReactNode
      }

      return {
        value: String(props.value ?? ""),
        label: props.children,
      }
    })

  const selectedOption = options.find((option) => option.value === value)

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)

    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [])

  return (
    <div ref={wrapperRef} className="relative block" title={title}>
      <button
        type="button"
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="admin-control-select flex h-11 w-full items-center justify-between gap-3 rounded-[18px] border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none transition-colors hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
      >
        <span className="min-w-0 truncate">{selectedOption?.label}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-beyonix-sky/75 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel ?? title}
          className="absolute left-0 top-12 z-50 max-h-64 min-w-full overflow-hidden rounded-[18px] border border-beyonix-blue-light/45 bg-black p-1 shadow-2xl shadow-black/70"
        >
          <div className="max-h-60 overflow-y-auto py-1">
            {options.map((option) => {
              const selected = option.value === value

              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className={`flex h-9 w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-sm font-medium transition-colors ${
                    selected
                      ? "bg-beyonix-blue text-white"
                      : "text-white/78 hover:bg-beyonix-blue/70 hover:text-white"
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  {selected && <Check className="size-3.5 text-beyonix-sky" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
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
        className={`h-11 w-full rounded-[18px] border border-white/12 bg-black px-4 text-sm font-medium text-white/86 outline-none transition-colors placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light ${
          icon ? "pl-11" : ""
        }`}
      />
    </label>
  )
}
