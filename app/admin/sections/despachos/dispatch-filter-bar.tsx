"use client"

import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import type { DispatchBoardFilters } from "@/lib/admin/dispatch-board-filters"

type Props = {
  filters: DispatchBoardFilters
  onChange: (patch: Partial<DispatchBoardFilters>) => void
  onClear: () => void
}

const inputClass = "admin-control-input admin-ds-control dispatch-filter-input"

export function DispatchFilterBar({ filters, onChange, onClear }: Props) {
  return <div role="search" aria-label="Filtros de despachos" className="dispatch-filters dispatch-filter-row">
    <input aria-label="NRO PEDIDO" type="search" className={inputClass} placeholder="NRO PEDIDO" value={filters.search} onChange={(event) => onChange({ search: event.target.value })} />
    <input aria-label="NRO BULTO" type="search" className={inputClass} placeholder="NRO BULTO" value={filters.batch} onChange={(event) => onChange({ batch: event.target.value })} />
    <div className="dispatch-filter-date"><AdminDatePicker title="Fecha de despacho" ariaLabel="FECHA" value={filters.dateFrom} onChange={(value) => onChange({ dateMode: value ? "day" : "all", dateFrom: value, dateTo: value })} /></div>
    <input aria-label="USUARIO" type="search" className={inputClass} placeholder="USUARIO" value={filters.operator} onChange={(event) => onChange({ operator: event.target.value })} />
    <button type="button" className="dispatch-filter-clear" onClick={onClear}>Limpiar</button>
  </div>
}
