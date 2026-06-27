export function formatCuentaPrice(price: number) {
  return price.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  })
}

export function formatCuentaOrderDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

export function formatPublicOrderId(id: number) {
  return `BX-${1000 + id}`
}

export function formatCuentaInvoiceNumber(
  point?: number | null,
  number?: number | null,
) {
  return `${String(point ?? 0).padStart(4, "0")}-${String(number ?? 0).padStart(8, "0")}`
}

export function formatOrderCardDate(value: string) {
  const parts = new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ""

  return `${part("day")}/${part("month")}/${part("year")} · ${part("hour")}:${part("minute")}`
}
