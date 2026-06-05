"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"

import { ARGENTINA_PROVINCES } from "@/lib/validation/account-fields"

export function ProvinceSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selectedLabel = value || "Seleccioná una provincia"

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
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        title="Seleccionar provincia"
        aria-label="Seleccionar provincia"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-12 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border bg-black px-4 text-left text-sm outline-none transition-colors ${
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
          className="absolute left-0 top-14 z-50 w-full overflow-hidden rounded-xl border border-beyonix-focus/70 bg-black p-1 shadow-2xl shadow-black/70"
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
              const selected = province === value

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
