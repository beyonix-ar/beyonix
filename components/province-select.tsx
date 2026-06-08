"use client"

import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { Check, ChevronDown } from "lucide-react"

import { ARGENTINA_PROVINCES } from "@/lib/validation/account-fields"

export function ProvinceSelect({
  value,
  onChange,
  compact = false,
}: {
  value: string
  onChange: (value: string) => void
  compact?: boolean
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selectedProvince = ARGENTINA_PROVINCES.find(
    (province) =>
      province.toLocaleUpperCase("es-AR") ===
      value.toLocaleUpperCase("es-AR")
  )
  const selectedLabel = value
    ? value.toLocaleUpperCase("es-AR")
    : "Seleccioná una provincia"

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

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) => {
    if (
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault()
      setOpen(true)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        title="Seleccionar provincia"
        aria-label="Seleccionar provincia"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        className={`flex w-full cursor-pointer items-center justify-between gap-3 border bg-black text-left text-sm transition-colors focus-visible:border-beyonix-focus focus-visible:outline-none focus-visible:ring-0 ${
          compact ? "h-10 rounded-lg px-3" : "h-12 rounded-xl px-4"
        } ${
          open
            ? "border-beyonix-focus text-white"
            : "border-white/10 text-white hover:border-white/18"
        } ${value ? "" : "text-white/35"}`}
      >
        <span className="min-w-0 truncate">{selectedLabel}</span>
        <ChevronDown
          className={`size-4 shrink-0 text-white/45 transition-transform ${
            open ? "rotate-180 text-beyonix-focus" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Provincias"
          className={`absolute left-0 z-50 w-full overflow-hidden rounded-xl border border-beyonix-focus/70 bg-black p-1 shadow-2xl shadow-black/70 ${
            compact ? "top-11" : "top-14"
          }`}
        >
          <div className="custom-scrollbar max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
              className={`flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                !value
                  ? "bg-beyonix-blue text-white"
                  : "text-white/58 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className="truncate">Seleccioná una provincia</span>
              {!value && <Check className="size-3.5 text-beyonix-sky" />}
            </button>

            {ARGENTINA_PROVINCES.map((province) => {
              const selected = province === selectedProvince

              return (
                <button
                  key={province}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(province)
                    setOpen(false)
                  }}
                  className={`flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                    selected
                      ? "bg-beyonix-blue text-white"
                      : "text-white/82 hover:bg-beyonix-blue/65 hover:text-white"
                  }`}
                >
                  <span className="truncate">{province}</span>
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
