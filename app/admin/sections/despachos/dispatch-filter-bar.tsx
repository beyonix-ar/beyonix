"use client"

import { AdminSelect } from "@/app/admin/components/admin-controls"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { DISPATCH_RECORD_STATES, type DispatchRecordFilters, type DispatchRecordState, type DispatchUser } from "@/lib/admin/dispatch-records"

type Props = {
  filters: DispatchRecordFilters
  users: readonly DispatchUser[]
  onChange: (patch: Partial<DispatchRecordFilters>) => void
  onClear: () => void
}

const inputClass = "admin-control-input admin-ds-control dispatch-filter-input"
const selectClass = "dispatch-filter-select"

/** Filtros combinables de la tabla única; la fecha arranca en hoy y, elegida a mano, filtra todo. */
export function DispatchFilterBar({ filters, users, onChange, onClear }: Props) {
  return <div role="search" aria-label="Filtros de despachos" className="dispatch-filters dispatch-filter-row">
    <div className="dispatch-filter-date"><AdminDatePicker title="Fecha de despacho" ariaLabel="FECHA" value={filters.date} onChange={(value) => onChange({ date: value, manualDate: true })} /></div>
    <input aria-label="N° PEDIDO" type="search" className={inputClass} placeholder="N° PEDIDO" value={filters.order} onChange={(event) => onChange({ order: event.target.value })} />
    <input aria-label="N° BULTO" type="search" className={inputClass} placeholder="N° BULTO" value={filters.batch} onChange={(event) => onChange({ batch: event.target.value })} />
    <AdminSelect title="USUARIO" value={filters.user} compact searchable={users.length > 8} searchPlaceholder="Buscar usuario..." wrapperClassName={selectClass} onChange={(user) => onChange({ user })}>
      <option value="" data-selected-label="USUARIO">Todos los usuarios</option>
      {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
    </AdminSelect>
    {/* BEYONIX todavía no registra el equipo/dispositivo de cada operación: no se inventa. */}
    <AdminSelect title="EQUIPO" value="" compact disabled wrapperClassName={selectClass} onChange={() => {}}>
      <option value="" data-selected-label="EQUIPO · sin registro">Sin registro de equipo</option>
    </AdminSelect>
    <AdminSelect title="ESTADO" value={filters.state} compact wrapperClassName={selectClass} onChange={(state) => onChange({ state })}>
      <option value="" data-selected-label="ESTADO">Todos los estados</option>
      {(Object.keys(DISPATCH_RECORD_STATES) as DispatchRecordState[]).map((state) => <option key={state} value={state}>{`[${state}] ${DISPATCH_RECORD_STATES[state].label}`}</option>)}
    </AdminSelect>
    <button type="button" className="dispatch-filter-clear" onClick={onClear}>Limpiar</button>
  </div>
}
