"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react"

import { adminControlClassName, AdminSecondaryButton } from "./admin-controls"

interface AdminDatePickerProps {
  title: string
  ariaLabel: string
  value: string
  minDate?: string
  placeholder?: string
  centered?: boolean
  compact?: boolean
  onChange: (value: string) => void
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
]

const WEEK_DAYS = ["L", "M", "X", "J", "V", "S", "D"]

function toInputDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")

  return `${year}-${month}-${day}`
}

function toDisplayDate(value: string) {
  if (!value) return ""

  const [year, month, day] = value.split("-")
  if (!year || !month || !day) return value

  return `${day}/${month}/${year}`
}

function parseManualDate(value: string) {
  const clean = value.trim()
  if (!clean) return ""

  const parts = clean.includes("/")
    ? clean.split("/")
    : clean.includes("-")
      ? clean.split("-").reverse()
      : []

  if (parts.length !== 3) return null

  const [day, month, year] = parts.map((part) => Number(part))
  if (!day || !month || !year) return null

  const date = new Date(year, month - 1, day)
  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day

  if (!valid) return null

  return toInputDate(date)
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function getCalendarDays(monthDate: Date) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()

  const firstDay = new Date(year, month, 1)
  const firstWeekDay = (firstDay.getDay() + 6) % 7
  const startDate = new Date(year, month, 1 - firstWeekDay)

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + index)
    return date
  })
}

export function AdminDatePicker({
  title,
  ariaLabel,
  value,
  minDate,
  placeholder = "dd/mm/aaaa",
  centered = false,
  compact = false,
  onChange,
}: AdminDatePickerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const selectedDate = value ? new Date(`${value}T00:00:00`) : null
  const today = new Date()

  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [textValue, setTextValue] = useState(toDisplayDate(value))
  const [visibleMonth, setVisibleMonth] = useState(selectedDate || today)
  const [popoverPosition, setPopoverPosition] = useState({
    left: 0,
    top: 0,
  })

  const calendarDays = useMemo(
    () => getCalendarDays(visibleMonth),
    [visibleMonth]
  )

  useEffect(() => {
    setTextValue(toDisplayDate(value))

    if (value) {
      setVisibleMonth(new Date(`${value}T00:00:00`))
    }
  }, [value])

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        !wrapperRef.current?.contains(event.target as Node) &&
        !popoverRef.current?.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    document.addEventListener("keydown", handleEscape)

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [])

  useEffect(() => {
    if (!open) return

    function updatePopoverPosition() {
      const rect = wrapperRef.current?.getBoundingClientRect()
      if (!rect) return

      const width = 320
      const estimatedHeight = 408
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < estimatedHeight && rect.top > estimatedHeight

      setPopoverPosition({
        left: Math.min(
          Math.max(8, rect.left),
          Math.max(8, window.innerWidth - width - 8),
        ),
        top: openAbove
          ? Math.max(8, rect.top - estimatedHeight - 4)
          : Math.min(
              Math.max(8, window.innerHeight - estimatedHeight - 8),
              rect.bottom + 4,
            ),
      })
    }

    updatePopoverPosition()
    window.addEventListener("resize", updatePopoverPosition)
    window.addEventListener("scroll", updatePopoverPosition, true)

    return () => {
      window.removeEventListener("resize", updatePopoverPosition)
      window.removeEventListener("scroll", updatePopoverPosition, true)
    }
  }, [open])

  const changeMonth = (direction: number) => {
    setVisibleMonth((current) => {
      const next = new Date(current)
      next.setMonth(current.getMonth() + direction)
      return next
    })
  }

  const handleManualChange = (manualValue: string) => {
    setTextValue(manualValue)

    const parsed = parseManualDate(manualValue)

    if (parsed === "") {
      onChange("")
    }

    if (parsed) {
      if (minDate && parsed < minDate) {
        setTextValue(toDisplayDate(value))
        return
      }

      onChange(parsed)
    }
  }

  const handleSelectDate = (date: Date) => {
    const nextValue = toInputDate(date)

    if (minDate && nextValue < minDate) return

    onChange(nextValue)
    setOpen(false)
  }

  const handleClear = () => {
    onChange("")
    setTextValue("")
    setOpen(false)
  }

  const inputName = `beyonix-admin-date-${title
    .replaceAll(" ", "-")
    .toLowerCase()}`

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <input
          type="text"
          name={inputName}
          aria-label={ariaLabel}
          value={textValue}
          placeholder={placeholder}
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(event) => handleManualChange(event.target.value)}
          className={`${adminControlClassName} ${
            compact ? "!h-10 !px-9 !text-xs font-bold" : "pr-11"
          } ${centered ? `${compact ? "" : "pl-11"} text-center` : ""}`}
        />

        <button
          type="button"
          title="Abrir calendario"
          aria-label="Abrir calendario"
          aria-expanded={open}
          tabIndex={compact ? -1 : undefined}
          onClick={() => setOpen((current) => !current)}
          className={`absolute top-1/2 flex -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg bg-beyonix-blue/18 text-beyonix-sky transition hover:bg-beyonix-blue/45 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-beyonix-sky/60 ${
            compact ? "right-1 size-7" : "right-1.5 size-8"
          }`}
        >
          <CalendarDays className={compact ? "size-3" : "size-3.5"} />
        </button>
      </div>

      {mounted &&
        open &&
        createPortal(
        <div
          ref={popoverRef}
          className="admin-ds-datepicker-popover fixed z-100 w-80 overflow-hidden"
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
          }}
        >
          <div
            className="admin-ds-datepicker-header border-b px-4 py-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-11px font-bold uppercase tracking-widest text-beyonix-sky">
                  Seleccionar fecha
                </p>

                <p className="mt-1 text-sm font-black capitalize text-white/92">
                  {MONTHS[visibleMonth.getMonth()]}{" "}
                  {visibleMonth.getFullYear()}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Mes anterior"
                  onClick={() => changeMonth(-1)}
                  className="admin-ds-datepicker-nav grid size-9 cursor-pointer place-items-center rounded-xl border transition"
                >
                  <ChevronLeft className="size-4" />
                </button>

                <button
                  type="button"
                  aria-label="Mes siguiente"
                  onClick={() => changeMonth(1)}
                  className="admin-ds-datepicker-nav grid size-9 cursor-pointer place-items-center rounded-xl border transition"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="p-4">
            <div className="mb-2 grid grid-cols-7 gap-1">
              {WEEK_DAYS.map((day) => (
                <div
                  key={day}
                  className="grid h-8 place-items-center text-11px font-black text-beyonix-sky"
                >
                  {day}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map((date) => {
                const currentMonth =
                  date.getMonth() === visibleMonth.getMonth()
                const selected = selectedDate
                  ? isSameDay(date, selectedDate)
                  : false
                const currentToday = isSameDay(date, today)
                const dateValue = toInputDate(date)
                const disabled = Boolean(minDate && dateValue < minDate)

                return (
                  <button
                    key={date.toISOString()}
                    type="button"
                    aria-label={toDisplayDate(dateValue)}
                    disabled={disabled}
                    onClick={() => handleSelectDate(date)}
                    className={`admin-ds-datepicker-day grid h-9 place-items-center rounded-xl border text-sm font-bold transition ${
                      selected
                        ? "admin-ds-datepicker-day-selected"
                        : disabled
                          ? "cursor-not-allowed opacity-25"
                          : currentToday
                            ? "admin-ds-datepicker-day-today cursor-pointer"
                            : currentMonth
                              ? "admin-ds-datepicker-day-current cursor-pointer"
                              : "admin-ds-datepicker-day-muted cursor-pointer"
                    }`}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-white/8 pt-4">
              <AdminSecondaryButton
                title="Limpiar fecha"
                aria-label="Limpiar fecha"
                size="sm"
                onClick={handleClear}
              >
                <X className="size-3.5" />
                Limpiar
              </AdminSecondaryButton>

              <AdminSecondaryButton
                title="Ir a hoy"
                aria-label="Ir a hoy"
                size="sm"
                onClick={() => setVisibleMonth(today)}
              >
                Hoy
              </AdminSecondaryButton>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
