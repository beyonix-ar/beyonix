import { andreaniShipmentCreated, orderCode, type DispatchBatch, type DispatchOrder, type DispatchPackage } from "./dispatch"

export const DISPATCH_PAGE_SIZE = 20

export type QueueOrder = DispatchOrder & { package: DispatchPackage | null; membership: { id: number } | null }

export function dispatchQueueStatus(order: QueueOrder): "pending" | "confirmed" | "in_batch" {
  if (order.membership) return "in_batch"
  return order.package?.status === "prepared" && andreaniShipmentCreated(order) && Boolean(order.andreani_tracking?.trim()) ? "confirmed" : "pending"
}

export function dispatchBatchName(batch: Pick<DispatchBatch, "id" | "display_number">) {
  const number = batch.display_number ?? batch.id
  return `Bulto - ${String(number).padStart(4, "0")}`
}

export function filterDispatchOrders<T extends QueueOrder>(orders: T[], search: string, date: string) {
  const term = search.trim().toUpperCase()
  return orders.filter((order) => {
    const code = orderCode(order.id).toUpperCase()
    const matchesCode = !term || code.includes(term) || (term.replace(/^BX-?/, "") === String(1000 + order.id))
    const matchesDate = !date || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(order.created_at)) === date
    return matchesCode && matchesDate
  })
}

export function dispatchPage<T>(items: T[], page: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / DISPATCH_PAGE_SIZE))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  return { items: items.slice((currentPage - 1) * DISPATCH_PAGE_SIZE, currentPage * DISPATCH_PAGE_SIZE), currentPage, totalPages }
}

export function selectVisibleOrders(selected: Set<number>, visibleIds: number[], checked: boolean) {
  const next = new Set(selected)
  for (const id of visibleIds) if (checked) next.add(id); else next.delete(id)
  return next
}
