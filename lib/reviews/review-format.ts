const reviewDateFormatter = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "America/Argentina/Buenos_Aires",
})

export function formatReviewDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : reviewDateFormatter.format(date)
}
