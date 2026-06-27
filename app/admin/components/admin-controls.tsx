"use client"

import { Children, isValidElement, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"

interface AdminSelectProps {
  title: string
  value: string
  children: React.ReactNode
  ariaLabel?: string
  compact?: boolean
  centered?: boolean
  disabled?: boolean
  triggerClassName?: string
  leadingIcon?: React.ReactNode
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
  compact = false,
  centered = false,
  disabled = false,
  triggerClassName = "",
  leadingIcon,
  onChange,
}: AdminSelectProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [menuPosition, setMenuPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
  })
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
    setMounted(true)
  }, [])

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node

      if (
        !wrapperRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
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

  useEffect(() => {
    if (!open) return

    function updateMenuPosition() {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return

      const menuHeight = Math.min(options.length * 36 + 10, 256)
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < menuHeight && rect.top > menuHeight
      const width = Math.max(rect.width, compact ? 144 : rect.width)
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8)
      )

      setMenuPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - menuHeight - 4)
          : Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 4),
        width,
      })
    }

    updateMenuPosition()
    window.addEventListener("resize", updateMenuPosition)
    window.addEventListener("scroll", updateMenuPosition, true)

    return () => {
      window.removeEventListener("resize", updateMenuPosition)
      window.removeEventListener("scroll", updateMenuPosition, true)
    }
  }, [compact, open, options.length])

  return (
    <div
      ref={wrapperRef}
      className="relative block w-full"
      title={title}
    >
      <button
        type="button"
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`admin-control-select relative flex cursor-pointer items-center rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#0B111A] font-medium text-[#F8FAFC] outline-none shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-[rgba(191,228,255,0.28)] hover:bg-[rgba(17,42,67,0.45)] hover:text-[#D7ECFF] focus:border-[rgba(191,228,255,0.42)] focus:shadow-[0_0_18px_rgba(96,165,250,0.18)] disabled:cursor-not-allowed disabled:opacity-45 ${triggerClassName} ${
          centered ? "justify-center" : "justify-between"
        } ${
          compact
            ? "h-8 w-full min-w-0 gap-1 px-2 text-11px"
            : "h-11 w-full gap-3 px-4 text-sm"
        }`}
      >
        <span className={`flex min-w-0 items-center gap-2 truncate ${centered ? "px-4 text-center" : ""}`}>
          {leadingIcon && <span className="shrink-0">{leadingIcon}</span>}
          <span className="truncate">{selectedOption?.label}</span>
        </span>
        <ChevronDown
          className={`size-4 shrink-0 text-beyonix-sky/75 transition-transform ${
            centered ? "absolute right-2" : ""
          } ${centered ? "" : "mr-1"} ${open ? "rotate-180" : ""}`}
        />
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel ?? title}
          className="fixed z-100 max-h-64 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] p-1 shadow-[0_18px_45px_rgba(0,0,0,0.45)]"
            style={{
              left: menuPosition.left,
              top: menuPosition.top,
              width: menuPosition.width,
            }}
          >
            <div className="admin-select-scrollbar max-h-60 overflow-y-auto py-1 pr-1">
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
                    className={`flex h-9 w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3 text-left text-sm font-medium transition-colors ${
                      selected
                        ? "bg-[rgba(17,42,67,0.9)] text-[#D7ECFF] shadow-[inset_0_0_0_1px_rgba(191,228,255,0.16)]"
                        : "text-[#F8FAFC] hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF]"
                    }`}
                  >
                    <span className="truncate">{option.label}</span>
                    {selected && <Check className="size-3.5 text-beyonix-sky" />}
                  </button>
                )
              })}
            </div>
          </div>,
          document.body
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
        className={`h-11 w-full rounded-18px border border-white/12 bg-[#141414] px-4 text-sm font-medium text-white/86 outline-none transition-colors placeholder:text-white/32 hover:bg-[#181818] focus:border-beyonix-blue-light ${
          icon ? "pl-11" : ""
        }`}
      />
    </label>
  )
}
