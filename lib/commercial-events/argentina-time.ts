import { DASHBOARD_TIME_ZONE } from "../business/dashboard-timezone.ts"

/**
 * Fecha y hora de Argentina (America/Argentina/Buenos_Aires) para eventos
 * programados: el Admin carga y ve "01/10/2026 03:00" en hora local; el
 * backend guarda y compara instantes UTC exactos. Nunca se muestra UTC.
 */

export const ARGENTINA_TIME_ZONE = DASHBOARD_TIME_ZONE

const PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ARGENTINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

function argentinaParts(instant: number) {
  const parts = PARTS_FORMATTER.formatToParts(new Date(instant))
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""
  return {
    date: `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`,
    time: `${valueFor("hour")}:${valueFor("minute")}`,
  }
}

/** Partes locales de Argentina de un instante: `{ date: "2026-10-01", time: "03:00" }`. */
export function toArgentinaLocalParts(value: string | Date) {
  return argentinaParts(new Date(value).getTime())
}

/**
 * Instante UTC (ISO) de una fecha y hora LOCAL de Argentina, o `null` si no
 * es válida o no existe. Se calcula con la zona horaria real (no un -03:00
 * fijo), así un eventual cambio de horario no corre los eventos.
 */
export function argentinaLocalToUtcIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time)
  if (!dateMatch || !timeMatch) return null
  const [year, month, day] = dateMatch.slice(1).map(Number)
  const [hour, minute] = timeMatch.slice(1).map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null

  const wallClock = Date.UTC(year, month - 1, day, hour, minute)
  let instant = wallClock
  // Dos pasadas: ajusta por el desfasaje real de la zona en ese instante.
  for (let pass = 0; pass < 2; pass++) {
    const local = argentinaParts(instant)
    const [localYear, localMonth, localDay] = local.date.split("-").map(Number)
    const [localHour, localMinute] = local.time.split(":").map(Number)
    instant += wallClock - Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute)
  }
  const check = argentinaParts(instant)
  return check.date === date && check.time === time ? new Date(instant).toISOString() : null
}

const DISPLAY_FORMATTER = new Intl.DateTimeFormat("es-AR", {
  timeZone: ARGENTINA_TIME_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** "vie 03/10/2026 18:00" en hora de Argentina. */
export function formatArgentinaDateTime(value: string | null | undefined) {
  if (!value) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return DISPLAY_FORMATTER.format(date).replace(/,/g, "").replace(/\s+/g, " ")
}
