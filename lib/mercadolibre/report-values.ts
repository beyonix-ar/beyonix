/**
 * Normalización de valores de reportes de Mercado Libre (Excel/CSV).
 * Cada parser devuelve un resultado explícito: nunca convierte un texto
 * inválido en 0 en silencio.
 */

export type ParsedValue<T> = { ok: true; value: T } | { ok: false; reason: string }

const ARGENTINA_OFFSET = "-03:00"

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
}

/** Quita caracteres invisibles/de control, unifica espacios y normaliza Unicode (NFC). */
export function cleanText(value: unknown): string {
  if (value == null) return ""
  return String(value)
    .normalize("NFC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\s  ]+/g, " ")
    .trim()
}

export function foldText(value: unknown): string {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

function ok<T>(value: T): ParsedValue<T> {
  return { ok: true, value }
}

function fail<T>(reason: string): ParsedValue<T> {
  return { ok: false, reason }
}

/**
 * Importe en formato argentino o exportado por Excel como texto.
 * Celda vacía = 0 (Mercado Libre deja vacíos los conceptos que no aplican).
 * "1.234" se interpreta como mil doscientos treinta y cuatro (miles AR).
 */
export function parseAmount(value: unknown): ParsedValue<number> {
  if (typeof value === "number") {
    return Number.isFinite(value) ? ok(value) : fail("no es un número válido")
  }
  if (typeof value === "boolean" || value instanceof Date) {
    return fail("no es un importe")
  }

  let source = cleanText(value)
    .replace(/\s/g, "")
    .replace(/[−‒–—]/g, "-")
  if (!source || source === "-") return ok(0)

  let negative = false
  if (/^\(.*\)$/.test(source)) {
    negative = true
    source = source.slice(1, -1)
  }
  source = source.replace(/^(ARS|AR\$|U\$S|\$)/i, "").replace(/(ARS|\$)$/i, "")
  if (source.startsWith("-")) {
    negative = !negative
    source = source.slice(1)
  } else if (source.startsWith("+")) {
    source = source.slice(1)
  }
  source = source.replace(/^(ARS|AR\$|\$)/i, "")

  let normalized: string
  if (/^\d+(\.\d+)?e[-+]?\d+$/i.test(source)) {
    normalized = source
  } else if (source.includes(".") && source.includes(",")) {
    const decimal = source.lastIndexOf(",") > source.lastIndexOf(".") ? "," : "."
    const thousands = decimal === "," ? "." : ","
    const [integerPart, decimalPart, ...rest] = source.split(decimal)
    if (rest.length || !new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})*$`).test(integerPart)) {
      return fail("tiene separadores de miles o decimales inconsistentes")
    }
    normalized = `${integerPart.split(thousands).join("")}.${decimalPart}`
  } else if (source.includes(",")) {
    const parts = source.split(",")
    if (parts.length === 2) {
      normalized = `${parts[0]}.${parts[1]}`
    } else if (/^\d{1,3}(,\d{3})+$/.test(source)) {
      normalized = parts.join("")
    } else {
      return fail("tiene separadores inconsistentes")
    }
  } else if (source.includes(".")) {
    const parts = source.split(".")
    if (parts.length > 2) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(source)) return fail("tiene separadores inconsistentes")
      normalized = parts.join("")
    } else if (/^\d{1,3}\.\d{3}$/.test(source)) {
      normalized = parts.join("")
    } else {
      normalized = source
    }
  } else {
    normalized = source
  }

  if (!/^\d+(\.\d+)?(e[-+]?\d+)?$/i.test(normalized)) {
    return fail("no es un número válido")
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return fail("no es un número válido")
  return ok(negative ? -parsed : parsed)
}

export function parseUnits(value: unknown): ParsedValue<number> {
  const parsed = parseAmount(value)
  if (!parsed.ok) return parsed
  if (!Number.isInteger(parsed.value)) return fail("no es una cantidad entera")
  if (parsed.value < 0) return fail("no puede ser negativa")
  return parsed
}

/** "# de venta": sólo dígitos. Detecta los IDs que Excel convirtió a notación científica. */
export function parseSaleNumber(value: unknown): ParsedValue<string> {
  if (typeof value === "number") {
    // Excel guarda 15 dígitos significativos: un ID numérico más largo ya
    // perdió sus últimos dígitos y colisionaría con otra venta.
    if (!Number.isSafeInteger(value) || value <= 0 || value >= 1e15) {
      return fail("Excel lo convirtió a un número aproximado; exportá la columna como texto")
    }
    return ok(String(value))
  }
  const source = cleanText(value).replace(/^#/, "").replace(/\s/g, "")
  if (!source) return fail("está vacío")
  if (/^\d+(?:[.,]\d+)?e\+?\d+$/i.test(source)) {
    return fail("Excel lo convirtió a notación científica; exportá la columna como texto")
  }
  if (!/^\d+$/.test(source)) return fail(`“${cleanText(value)}” no es un número de venta`)
  return ok(source)
}

export function normalizeListingId(value: unknown): string | null {
  const source = cleanText(value).replace(/\s/g, "").toUpperCase()
  return source || null
}

export function normalizeOptionalText(value: unknown): string | null {
  return cleanText(value) || null
}

function pad(value: number, length = 2) {
  return String(value).padStart(length, "0")
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function buildArgentinaDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): ParsedValue<string> {
  if (year < 2000 || year > 2100) return fail("tiene un año fuera de rango")
  if (month < 1 || month > 12) return fail("tiene un mes inválido")
  if (day < 1 || day > daysInMonth(year, month)) return fail("tiene un día inválido")
  if (hour > 23 || minute > 59 || second > 59) return fail("tiene una hora inválida")
  return ok(
    `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${ARGENTINA_OFFSET}`,
  )
}

function fromInstant(date: Date): ParsedValue<string> {
  if (Number.isNaN(date.getTime())) return fail("no es una fecha válida")
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  return buildArgentinaDate(
    part("year"),
    part("month"),
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  )
}

/** Fecha serial de Excel (sistema 1900) interpretada como hora de Argentina. */
export function excelSerialToArgentinaDate(serial: number): ParsedValue<string> {
  if (!Number.isFinite(serial) || serial < 20_000 || serial > 80_000) {
    return fail("no es una fecha de Excel válida")
  }
  const totalSeconds = Math.round(serial * 86_400)
  const days = Math.floor(totalSeconds / 86_400)
  const seconds = totalSeconds - days * 86_400
  const base = new Date(Date.UTC(1899, 11, 30 + days))
  return buildArgentinaDate(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    base.getUTCDate(),
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  )
}

/**
 * Fecha de venta en hora de Argentina (UTC-03:00, sin horario de verano).
 * Acepta el texto de Mercado Libre ("15 de marzo de 2026 14:35 hs."),
 * dd/mm/aaaa [hh:mm], ISO y fechas nativas de Excel. Rechaza años de dos
 * dígitos porque son ambiguos.
 */
export function parseArgentinaDateTime(value: unknown): ParsedValue<string> {
  if (value instanceof Date) return fromInstant(value)
  if (typeof value === "number") return excelSerialToArgentinaDate(value)

  const source = foldText(value)
  if (!source) return fail("está vacía")

  const long = source.match(
    /^(\d{1,2}) de ([a-z]+) de (\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(?:hs\.?|h|horas)?$/,
  )
  if (long) {
    const month = MONTHS[long[2]]
    if (!month) return fail(`tiene un mes desconocido (“${long[2]}”)`)
    return buildArgentinaDate(
      Number(long[3]),
      month,
      Number(long[1]),
      Number(long[4] ?? 0),
      Number(long[5] ?? 0),
      Number(long[6] ?? 0),
    )
  }

  const numeric = source.match(
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ t,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(?:hs\.?|h)?$/,
  )
  if (numeric) {
    return buildArgentinaDate(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
      Number(numeric[4] ?? 0),
      Number(numeric[5] ?? 0),
      Number(numeric[6] ?? 0),
    )
  }

  const iso = source.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(z|[+-]\d{2}:?\d{2})?$/,
  )
  if (iso) {
    if (iso[7]) return fromInstant(new Date(cleanText(value)))
    return buildArgentinaDate(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    )
  }

  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}\b/.test(source)) {
    return fail("usa un año de dos dígitos; no se puede saber el siglo")
  }
  return fail(`“${cleanText(value)}” no tiene un formato de fecha reconocido`)
}
