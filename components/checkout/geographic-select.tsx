"use client"

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown, Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { normalizeArgentineLocationKey } from "@/lib/validation/account-fields"

export interface GeographicSelectOption {
  value: string
  label: string
}

interface DropdownPosition {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
}

export function GeographicSelect({
  id,
  value,
  options,
  onChange,
  placeholder,
  loading = false,
  loadingLabel = "Cargando…",
  disabled = false,
  locked = false,
  searchable = false,
  compact = false,
  invalid = false,
  emptyLabel = "No hay opciones disponibles.",
  errorMessage = "",
  ariaLabel,
}: {
  id: string
  value: string
  options: GeographicSelectOption[]
  onChange: (value: string) => void
  placeholder: string
  loading?: boolean
  loadingLabel?: string
  disabled?: boolean
  locked?: boolean
  searchable?: boolean
  compact?: boolean
  invalid?: boolean
  emptyLabel?: string
  errorMessage?: string
  ariaLabel: string
}) {
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<DropdownPosition | null>(null)

  const selectedOption = options.find((option) => option.value === value)
  const normalizedQuery = normalizeArgentineLocationKey(query)
  const visibleOptions = useMemo(
    () =>
      normalizedQuery
        ? options.filter((option) =>
            normalizeArgentineLocationKey(option.label).includes(normalizedQuery),
          )
        : options,
    [normalizedQuery, options],
  )
  const unavailable = disabled || loading || locked

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportPadding = 8
    const gap = 6
    const optionHeight = 40
    const chromeHeight = searchable ? 48 : 8
    const desiredHeight =
      Math.min(compact ? 8 : 20, Math.max(1, options.length + 1)) *
        optionHeight +
      chromeHeight
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap
    const availableAbove = rect.top - viewportPadding - gap
    const openAbove = availableBelow < Math.min(320, desiredHeight) &&
      availableAbove > availableBelow
    const availableHeight = Math.min(
      desiredHeight,
      Math.max(0, openAbove ? availableAbove : availableBelow),
    )
    const width = Math.min(rect.width, window.innerWidth - viewportPadding * 2)
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - viewportPadding - width,
    )

    setPosition({
      left,
      width,
      maxHeight: availableHeight,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    })
  }, [compact, options.length, searchable])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()

    const handleViewportChange = () => updatePosition()
    window.addEventListener("resize", handleViewportChange)
    window.addEventListener("scroll", handleViewportChange, true)

    return () => {
      window.removeEventListener("resize", handleViewportChange)
      window.removeEventListener("scroll", handleViewportChange, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return

    const selectedIndex = visibleOptions.findIndex(
      (option) => option.value === value,
    )
    setActiveIndex(Math.max(0, selectedIndex))

    const focusTimer = window.setTimeout(() => {
      if (searchable) searchRef.current?.focus()
      else optionRefs.current[Math.max(0, selectedIndex)]?.focus()
    }, 0)

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !triggerRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open, searchable, value, visibleOptions])

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const selectOption = (option: GeographicSelectOption) => {
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (unavailable) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      setOpen((current) => !current)
    }
  }

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!visibleOptions.length) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const offset = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((current) => {
        const next =
          (current + offset + visibleOptions.length) % visibleOptions.length
        optionRefs.current[next]?.focus()
        return next
      })
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const option = visibleOptions[activeIndex]
      if (option) selectOption(option)
    }
  }

  const dropdown = open && position && (
    <div
      ref={dropdownRef}
      className="beyonix-select-portal fixed z-[120] overflow-hidden rounded-lg border border-[rgba(148,197,255,0.24)] bg-[#080D14] font-heading shadow-[0_22px_60px_rgba(0,0,0,0.72)]"
      style={{
        left: position.left,
        top: position.top,
        bottom: position.bottom,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
      onKeyDown={handleListKeyDown}
    >
      {searchable && (
        <div className="sticky top-0 z-10 border-b border-beyonix-blue-light/14 bg-[#080D14] p-1">
          <div className="flex h-10 items-center gap-2 rounded-md px-2.5 text-white/72 transition-colors focus-within:bg-[#101923] focus-within:text-[#D7ECFF]">
            <Search aria-hidden="true" className="size-3.5 shrink-0 text-white/42" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              placeholder="Buscar localidad…"
              aria-label="Buscar localidad"
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/36"
            />
            {query && (
              <button
                type="button"
                aria-label="Limpiar búsqueda"
                title="Limpiar búsqueda"
                onClick={() => {
                  setQuery("")
                  setActiveIndex(0)
                  searchRef.current?.focus()
                }}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-white/42 transition-colors hover:bg-white/[0.06] hover:text-[#D7ECFF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/35"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel}
        className="custom-scrollbar overflow-y-auto overscroll-contain p-1"
        style={{
          maxHeight: Math.max(
            72,
            position.maxHeight - (searchable ? 48 : 0),
          ),
        }}
      >
        {visibleOptions.length === 0 ? (
          <p
            className={cn(
              "px-3 py-4 text-center text-sm",
              errorMessage ? "text-red-300" : "text-white/48",
            )}
          >
            {errorMessage ||
              (normalizedQuery
                ? "No encontramos coincidencias."
                : emptyLabel)}
          </p>
        ) : (
          visibleOptions.map((option, index) => {
            const selected = option.value === value
            const active = index === activeIndex
            return (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element
                }}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
                className={cn(
                  "flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-beyonix-blue-light/35",
                  selected
                    ? "bg-[#112A43] text-[#F8FAFC] shadow-[inset_0_0_0_1px_rgba(148,197,255,0.22)]"
                    : active
                      ? "bg-[#101923] text-[#D7ECFF]"
                      : "text-white/72 hover:bg-[#101923] hover:text-[#D7ECFF]",
                )}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {selected && <Check className="size-3.5 shrink-0 text-beyonix-sky" />}
              </button>
            )
          })
        )}
      </div>
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-disabled={unavailable}
        disabled={disabled || loading}
        onClick={() => {
          if (!unavailable) setOpen((current) => !current)
        }}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "beyonix-checkout-input flex h-10 w-full min-w-0 items-center justify-between gap-3 rounded-lg border bg-[#10151C] px-3 text-left font-heading text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2",
          open
            ? "border-beyonix-blue-light/65 text-[#D7ECFF] ring-2 ring-beyonix-blue-light/18"
            : "border-beyonix-blue-light/18 text-white hover:border-beyonix-blue-light/35",
          !selectedOption && "text-white/36",
          invalid &&
            "border-red-400/70 shadow-[0_0_0_2px_rgba(248,113,113,0.1)]",
          (disabled || loading) && "cursor-not-allowed opacity-60",
          locked && "cursor-default",
        )}
      >
        <span className="min-w-0 truncate">
          {loading ? loadingLabel : selectedOption?.label ?? placeholder}
        </span>
        {locked && selectedOption ? (
          <Check className="size-3.5 shrink-0 text-beyonix-sky" />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-white/45 transition-transform",
              open && "rotate-180 text-beyonix-focus",
            )}
          />
        )}
      </button>
      {typeof document !== "undefined" && dropdown
        ? createPortal(dropdown, document.body)
        : null}
    </>
  )
}
