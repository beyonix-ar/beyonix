"use client"

import { AdminBadge, AdminRowMenu } from "@/app/admin/components/admin-controls"
import { DISPATCH_RECORD_STATES, dispatchRecordBatchLabel, dispatchRecordOrderLabel, type DispatchRecord, type DispatchRecordState } from "@/lib/admin/dispatch-records"

const dateTime = (value: string | null) => {
  if (!value) return "—"
  const parts = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ""
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`
}
const money = (value: number | null) => value !== null && Number.isFinite(value)
  ? new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }).format(value) : "—"

/** Badge con el texto del estado y la paleta de BEYONIX. */
export function DispatchStateBadge({ state }: { state: DispatchRecordState }) {
  const meta = DISPATCH_RECORD_STATES[state]
  return <AdminBadge tone={meta.tone} className="dispatch-state-badge" data-state={state}>{meta.label}</AdminBadge>
}

const recordName = (record: DispatchRecord) => record.kind === "order" ? dispatchRecordOrderLabel(record) : dispatchRecordBatchLabel(record)

/** Unidades del pedido; en un Bulto, la cantidad de pedidos que contiene. */
const recordQuantity = (record: DispatchRecord) => record.kind === "batch" ? record.orderCount : record.units

/**
 * Tabla de consulta: cada fila es un pedido sin Bulto o un Bulto completo. Las
 * acciones que modifican (retirar, cancelar, entregar) viven en el detalle.
 */
export function DispatchRecordsTable({ rows, selected, onToggle, onOpen }: {
  rows: readonly DispatchRecord[]
  selected: ReadonlySet<number>
  onToggle: (orderId: number) => void
  onOpen: (record: DispatchRecord) => void
}) {
  const selectable = rows.some((row) => row.selectable)
  return <div className="dispatch-records-scroll">
    <table className="dispatch-orders-table dispatch-records-table w-full" aria-label="Registros de despachos">
      <thead><tr>
        {selectable && <th scope="col" className="dispatch-order-check"><span className="sr-only">Seleccionar para Bulto</span></th>}
        <th scope="col" className="dispatch-col-date">Fecha y hora</th><th scope="col" className="dispatch-col-order">N° Pedido</th><th scope="col" className="dispatch-col-batch">N° Bulto</th>
        <th scope="col">Usuario</th><th scope="col" className="dispatch-col-state">Estado</th>
        <th scope="col" className="dispatch-col-units dispatch-center-cell">Unidades</th><th scope="col" className="dispatch-col-total dispatch-number-cell">Importe total</th><th scope="col" className="dispatch-actions-cell"><span className="sr-only">Acciones</span></th>
      </tr></thead>
      <tbody>{rows.map((row) => {
        const name = recordName(row)
        const open = () => onOpen(row)
        const quantity = recordQuantity(row)
        return <tr key={`${row.kind}:${row.id}`} className="dispatch-order-row dispatch-record-row" data-kind={row.kind} tabIndex={0} aria-label={`Ver ${name}`}
          onClick={open} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open() } }}>
          {selectable && <td className="dispatch-order-check" onClick={(event) => event.stopPropagation()}>{row.selectable && <input type="checkbox" className="size-5" aria-label={`Seleccionar ${name} para un Bulto`} checked={selected.has(row.id)} onChange={() => onToggle(row.id)} onKeyDown={(event) => event.stopPropagation()} />}</td>}
          <td className="dispatch-order-date" data-label="Fecha y hora">{dateTime(row.at)}</td>
          <td className={`dispatch-order-code dispatch-record-order ${row.kind === "order" ? "" : "is-empty"}`} data-label="N° Pedido">{dispatchRecordOrderLabel(row)}</td>
          <td className={`dispatch-order-code dispatch-record-batch ${row.kind === "batch" ? "" : "is-empty"}`} data-label="N° Bulto">{dispatchRecordBatchLabel(row)}</td>
          <td className="dispatch-record-user" data-label="Usuario" title={row.actorName ?? undefined}>{row.actorName ?? "—"}</td>
          <td className="dispatch-order-status" data-label="Estado"><DispatchStateBadge state={row.state} /></td>
          <td className="dispatch-order-units dispatch-center-cell" data-label="Unidades" title={row.kind === "batch" ? `${quantity} ${quantity === 1 ? "pedido" : "pedidos"} en el Bulto` : undefined}>
            {quantity}<span className="dispatch-mobile-only">{row.kind === "batch" ? ` ${quantity === 1 ? "pedido" : "pedidos"}` : " u."}</span>
          </td>
          <td className="dispatch-order-total dispatch-number-cell" data-label="Importe total">{money(row.total)}</td>
          <td className="dispatch-actions-cell" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <AdminRowMenu ariaLabel={`Acciones de ${name}`} items={[{ key: "view", label: row.kind === "order" ? "Ver pedido" : "Ver bulto", onSelect: open }]} />
          </td>
        </tr>
      })}</tbody>
    </table>
  </div>
}
