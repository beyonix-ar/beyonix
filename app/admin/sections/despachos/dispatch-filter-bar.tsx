"use client"

import type { DispatchBoardFilters, DispatchBoardTab } from "@/lib/admin/dispatch-board-filters"
import { dispatchToday } from "@/lib/admin/dispatch-board-filters"

type Props = {
  tab: DispatchBoardTab
  filters: DispatchBoardFilters
  onChange: (patch: Partial<DispatchBoardFilters>) => void
  onClear: () => void
}

const states: Record<DispatchBoardTab, string[]> = {
  armado: ["Pendiente"], ready: ["Confirmado"],
  open: ["Pendiente", "Listo para entregar", "Cancelado", "Retirado"],
  delivered: ["Entregado", "Retirado"],
}

const inputClass = "admin-control-input admin-ds-control dispatch-filter-input"

export function DispatchFilterBar({ tab, filters, onChange, onClear }: Props) {
  const today = dispatchToday()
  const dateMode = filters.dateMode
  return <div role="search" aria-label="Filtros de despachos" className="dispatch-filters dispatch-filter-row">
    <input aria-label="Buscar" type="search" className={`${inputClass} dispatch-filter-search`} placeholder="Pedido, Bulto, tracking, SKU…" value={filters.search} onChange={(event) => onChange({ search: event.target.value })} />
    <details className="dispatch-filter-popover"><summary>Fecha{dateMode === "today" ? ": hoy" : dateMode === "all" ? "" : ": filtrada"}</summary>
      <div className="dispatch-filter-menu"><label>Período<select className={inputClass} aria-label="Período" value={dateMode} onChange={(event) => {
        const mode = event.target.value
        onChange(mode === "all" ? { dateMode: "all", dateFrom: "", dateTo: "" } : mode === "today" ? { dateMode: "today", dateFrom: today, dateTo: today } : { dateMode: mode as "day" | "range", dateFrom: filters.dateFrom || today, dateTo: mode === "day" ? filters.dateFrom || today : filters.dateTo || today })
      }}><option value="today">Hoy</option><option value="day">Fecha</option><option value="range">Rango</option><option value="all">Todas</option></select></label>
        {dateMode !== "all" && <label>Desde<input className={inputClass} aria-label="Desde" type="date" value={filters.dateFrom} onChange={(event) => onChange({ dateFrom: event.target.value, dateTo: dateMode === "day" ? event.target.value : filters.dateTo })} /></label>}
        {dateMode === "range" && <label>Hasta<input className={inputClass} aria-label="Hasta" type="date" min={filters.dateFrom} value={filters.dateTo} onChange={(event) => onChange({ dateTo: event.target.value })} /></label>}
      </div>
    </details>
    <input aria-label="Bulto" className={inputClass} placeholder="Bulto" value={filters.batch} onChange={(event) => onChange({ batch: event.target.value })} />
    <input aria-label="Operador" className={inputClass} placeholder="Operador" value={filters.operator} onChange={(event) => onChange({ operator: event.target.value })} />
    <select aria-label="Estado" className={inputClass} value={filters.state} onChange={(event) => onChange({ state: event.target.value })}><option value="">Estado</option>{states[tab].map((state) => <option key={state}>{state}</option>)}</select>
    <details className="dispatch-filter-popover"><summary>Cantidad{filters.quantityMin || filters.quantityMax ? ": filtrada" : ""}</summary>
      <div className="dispatch-filter-menu"><label>Medir<select className={inputClass} aria-label="Medir cantidad" value={filters.quantityKind} onChange={(event) => onChange({ quantityKind: event.target.value })}>
        {(tab === "armado" || tab === "ready") ? <option value="units">Unidades</option> : <><option value="orders">Pedidos</option><option value="parcels">Paquetes</option></>}
      </select></label><label>Igual a<input aria-label="Cantidad exacta" className={inputClass} type="number" min="0" value={filters.quantityMin === filters.quantityMax ? filters.quantityMin : ""} onChange={(event) => onChange({ quantityMin: event.target.value, quantityMax: event.target.value })} /></label>
        <label>Mínimo<input aria-label="Cantidad mínima" className={inputClass} type="number" min="0" value={filters.quantityMin} onChange={(event) => onChange({ quantityMin: event.target.value })} /></label>
        <label>Máximo<input aria-label="Cantidad máxima" className={inputClass} type="number" min="0" value={filters.quantityMax} onChange={(event) => onChange({ quantityMax: event.target.value })} /></label></div>
    </details>
    <details className="dispatch-filter-popover"><summary>Más filtros</summary><div className="dispatch-filter-menu">
      <label>SKU<input aria-label="SKU" className={inputClass} value={filters.sku} onChange={(event) => onChange({ sku: event.target.value })} /></label>
      <label>Tracking<input aria-label="Tracking" className={inputClass} value={filters.tracking} onChange={(event) => onChange({ tracking: event.target.value })} /></label>
      {(tab === "open" || tab === "delivered") && <><label>Cancelados<select aria-label="Con cancelados" className={inputClass} value={filters.hasCancelled} onChange={(event) => onChange({ hasCancelled: event.target.value })}><option value="">Todos</option><option value="true">Con cancelados</option><option value="false">Sin cancelados</option></select></label>
        <label>Retirados<select aria-label="Con retirados" className={inputClass} value={filters.hasRemoved} onChange={(event) => onChange({ hasRemoved: event.target.value })}><option value="">Todos</option><option value="true">Con retirados</option><option value="false">Sin retirados</option></select></label></>}
      <label>Factura<select aria-label="Facturado" className={inputClass} value={filters.invoiced} onChange={(event) => onChange({ invoiced: event.target.value })}><option value="">Todos</option><option value="true">Facturados</option><option value="false">Sin factura</option></select></label>
    </div></details>
    <button type="button" className="dispatch-filter-clear" onClick={onClear}>Limpiar</button>
  </div>
}
