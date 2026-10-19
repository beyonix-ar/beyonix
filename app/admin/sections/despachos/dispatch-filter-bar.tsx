"use client"

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
    <label className="dispatch-filter-date"><span>FECHA</span><input aria-label="FECHA" type="date" value={filters.dateFrom} onChange={(event) => onChange({ dateMode: event.target.value ? "day" : "all", dateFrom: event.target.value, dateTo: event.target.value })} /></label>
    <input aria-label="USUARIO" type="search" className={inputClass} placeholder="USUARIO" value={filters.operator} onChange={(event) => onChange({ operator: event.target.value })} />
    <button type="button" className="dispatch-filter-clear" onClick={onClear}>Limpiar</button>
  </div>
}
