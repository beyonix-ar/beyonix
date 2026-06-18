"use client"

import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { Check, ChevronDown } from "lucide-react"

import { ARGENTINA_PROVINCES } from "@/lib/validation/account-fields"

const PROVINCE_SELECT_OPTIONS = ["", ...ARGENTINA_PROVINCES]

function normalizeProvinceSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleUpperCase("es-AR")
}

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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const options = PROVINCE_SELECT_OPTIONS
  const selectedProvince = ARGENTINA_PROVINCES.find(
    (province) =>
      province.toLocaleUpperCase("es-AR") ===
      value.toLocaleUpperCase("es-AR")
  )
  const selectedLabel = value
    ? value.toLocaleUpperCase("es-AR")
    : "Seleccioná una provincia"

  useEffect(() => {
    const selectedIndex = options.findIndex(
      (province) =>
        province.toLocaleUpperCase("es-AR") ===
        value.toLocaleUpperCase("es-AR")
    )

    setActiveIndex(Math.max(0, selectedIndex))
  }, [options, value])

  useEffect(() => {
    if (!open) return

    optionRefs.current[activeIndex]?.scrollIntoView({
      block: "nearest",
    })
  }, [activeIndex, open])

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

  const selectProvince = (province: string) => {
    onChange(province)
    setOpen(false)
  }

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) => {
    if (event.key.length === 1 && /\p{L}/u.test(event.key)) {
      event.preventDefault()
      setOpen(true)

      const searchLetter = normalizeProvinceSearch(event.key)
      const matchIndex = options.findIndex(
        (province) =>
          province &&
          normalizeProvinceSearch(province).startsWith(searchLetter)
      )

      if (matchIndex >= 0) {
        setActiveIndex(matchIndex)
      }

      return
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => {
        const offset = event.key === "ArrowDown" ? 1 : -1
        return (current + offset + options.length) % options.length
      })
      return
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()

      if (open) {
        selectProvince(options[activeIndex] ?? "")
      } else {
        setOpen(true)
      }
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
            {options.map((province, index) => {
              const selected = province
                ? province === selectedProvince
                : !value
              const active = index === activeIndex
              const label = province || "Seleccioná una provincia"

              return (
                <button
                  key={province || "empty"}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectProvince(province)}
                  className={`flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
                    selected
                      ? "bg-beyonix-blue text-white"
                      : active
                        ? "bg-beyonix-blue/45 text-white"
                        : "text-white/82 hover:bg-beyonix-blue/65 hover:text-white"
                  }`}
                >
                  <span className="truncate">{label}</span>
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

