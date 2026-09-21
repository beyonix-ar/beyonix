export const DASHBOARD_TIME_ZONE = "America/Argentina/Buenos_Aires"

export interface ZonedDateParts {
  year: number
  month: number
  day: number
}

const argentinaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DASHBOARD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export function getArgentinaDateParts(value: Date | string): ZonedDateParts {
  const date = typeof value === "string" ? new Date(value) : value
  const parts = argentinaDateFormatter.formatToParts(date)
  const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)

  return {
    year: valueFor("year"),
    month: valueFor("month") - 1,
    day: valueFor("day"),
  }
}

export function argentinaDateKey(value: Date | string): string {
  const { year, month, day } = getArgentinaDateParts(value)
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function isSameArgentinaDay(a: Date | string, b: Date | string) {
  return argentinaDateKey(a) === argentinaDateKey(b)
}

export function matchesArgentinaMetricMonth(
  date: Date | string,
  selectedMonth: string,
  selectedYear: string,
  today: Date | string,
) {
  const current = getArgentinaDateParts(date)
  const reference = getArgentinaDateParts(today)
  const metricMonth = selectedMonth ? Number(selectedMonth) : reference.month
  const metricYear = selectedYear ? Number(selectedYear) : reference.year
  return current.month === metricMonth && current.year === metricYear
}

export function matchesArgentinaMetricYear(
  date: Date | string,
  selectedYear: string,
  today: Date | string,
) {
  const metricYear = selectedYear
    ? Number(selectedYear)
    : getArgentinaDateParts(today).year
  return getArgentinaDateParts(date).year === metricYear
}
