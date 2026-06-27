"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react"

interface AdminDatePickerProps {
  title: string
  ariaLabel: string
  value: string
  placeholder?: string
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
  placeholder = "dd/mm/aaaa",
  onChange,
}: AdminDatePickerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const selectedDate = value ? new Date(`${value}T00:00:00`) : null
  const today = new Date()

  const [open, setOpen] = useState(false)
  const [textValue, setTextValue] = useState(toDisplayDate(value))
  const [visibleMonth, setVisibleMonth] = useState(selectedDate || today)

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
    function handleClickOutside(event: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
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
      onChange(parsed)
    }
  }

  const handleSelectDate = (date: Date) => {
    onChange(toInputDate(date))
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
          title={title}
          aria-label={ariaLabel}
          value={textValue}
          placeholder={placeholder}
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(event) => handleManualChange(event.target.value)}
          className="h-11 w-full rounded-18px border border-white/12 bg-black px-4 pr-11 text-sm font-medium text-white/86 outline-none placeholder:text-white/32 hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
        />

        <button
          type="button"
          title="Abrir calendario"
          aria-label="Abrir calendario"
          onClick={() => setOpen((current) => !current)}
          className="absolute right-3 top-1/2 cursor-pointer rounded-full p-1 text-white/56 transition -translate-y-1/2 hover:bg-white/6 hover:text-beyonix-sky"
        >
          <CalendarDays className="size-4" />
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-14 z-50 w-80 overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-black/60">
          <div
            className="border-b border-white/8 px-4 py-4"
            style={{
              background:
                "linear-gradient(135deg, rgba(17, 42, 67, 0.72), rgba(0, 0, 0, 0.95))",
            }}
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
                  title="Mes anterior"
                  aria-label="Mes anterior"
                  onClick={() => changeMonth(-1)}
                  className="grid size-9 cursor-pointer place-items-center rounded-2xl border border-white/10 bg-black/60 text-white/70 transition hover:border-beyonix-blue-light hover:text-beyonix-sky"
                >
                  <ChevronLeft className="size-4" />
                </button>

                <button
                  type="button"
                  title="Mes siguiente"
                  aria-label="Mes siguiente"
                  onClick={() => changeMonth(1)}
                  className="grid size-9 cursor-pointer place-items-center rounded-2xl border border-white/10 bg-black/60 text-white/70 transition hover:border-beyonix-blue-light hover:text-beyonix-sky"
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

                return (
                  <button
                    key={date.toISOString()}
                    type="button"
                    title={toDisplayDate(toInputDate(date))}
                    aria-label={toDisplayDate(toInputDate(date))}
                    onClick={() => handleSelectDate(date)}
                    className={`grid h-9 cursor-pointer place-items-center rounded-xl border text-sm font-bold transition ${
                      selected
                        ? "border-beyonix-blue-light bg-beyonix-blue text-white shadow-lg shadow-black/40"
                        : currentToday
                          ? "border-beyonix-blue-light/45 bg-white/6 text-white"
                          : currentMonth
                            ? "border-transparent text-white/88 hover:border-beyonix-blue-light/50 hover:bg-beyonix-blue hover:text-white"
                            : "border-transparent text-white/28 hover:bg-white/5 hover:text-white/48"
                    }`}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-white/8 pt-4">
              <button
                type="button"
                title="Limpiar fecha"
                aria-label="Limpiar fecha"
                onClick={handleClear}
                className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-white/10 bg-black px-3 py-2 text-xs font-bold text-white/60 transition hover:border-beyonix-blue-light/35 hover:text-beyonix-sky"
              >
                <X className="size-3.5" />
                Limpiar
              </button>

              <button
                type="button"
                title="Ir a hoy"
                aria-label="Ir a hoy"
                onClick={() => setVisibleMonth(today)}
                className="cursor-pointer rounded-2xl border border-beyonix-blue-light/30 bg-beyonix-blue px-3 py-2 text-xs font-black text-beyonix-sky transition hover:border-beyonix-blue-light hover:text-white"
              >
                Hoy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
