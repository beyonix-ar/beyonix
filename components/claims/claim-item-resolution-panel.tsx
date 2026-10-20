"use client"

import type { ReactNode } from "react"
import { Minus, Plus } from "lucide-react"

import {
  CLAIM_LINE_SOLUTIONS,
  CLAIM_LINE_SOLUTION_LABELS,
  CLAIM_PRODUCT_CHANGE_HINT,
  type ClaimItemResolutionView,
  type ClaimLineSolution,
  type ClaimLineStage,
  type ReplacementSwitchState,
} from "@/lib/orders/claim-policy"

export const claimLineKey = (orderItemId: number, solution: ClaimLineSolution) => `${orderItemId}:${solution}`

const STAGE_TONES: Record<ClaimLineStage, string> = {
  done: "is-success",
  processing: "is-brand",
  pending: "is-warning",
}

/**
 * Resolución por producto de un reclamo mixto: qué recibe cada unidad y qué
 * falta, en una tarjeta compacta por producto. Las acciones pendientes
 * (dinero, unidades sin definir) las arma el gestor del reclamo.
 */
export function ClaimItemResolutionPanel({
  items,
  itemLabel,
  switchState,
  onSwitch,
  disabled = false,
  actions,
}: {
  items: ClaimItemResolutionView[]
  itemLabel: (orderItemId: number) => string
  /** Reemplazo -> reintegro / saldo por falta de stock (getReplacementSwitchState). */
  switchState?: (orderItemId: number) => ReplacementSwitchState
  onSwitch?: (orderItemId: number, target: "refund" | "credit") => void
  disabled?: boolean
  actions?: ReactNode
}) {
  return (
    <section className="admin-claim-lines" data-claim-item-resolutions aria-label="Resolución por producto">
      <p className="admin-claim-summary-eyebrow">Resolución por producto</p>
      <ul className="admin-claim-lines-list">
        {items.map((item) => {
          const replacementSwitch = switchState?.(item.orderItemId)
          return (
            <li key={item.orderItemId} className="admin-claim-lines-item" data-claim-item={item.orderItemId}>
              <div className="admin-claim-lines-head">
                <span className="admin-claim-lines-name">{itemLabel(item.orderItemId)}</span>
                <span className="admin-claim-lines-count">
                  {item.claimed} {item.claimed === 1 ? "unidad reclamada" : "unidades reclamadas"}
                </span>
              </div>
              <ul className="admin-claim-lines-rows">
                {item.lines.map((line) => (
                  <li key={line.solution} data-claim-line={line.solution} data-stage={line.stage}>
                    <span className="admin-claim-lines-qty">{line.quantity}</span>
                    <span className="admin-claim-lines-arrow" aria-hidden="true">→</span>
                    <span className="admin-claim-lines-solution">{line.label}</span>
                    <span className={`admin-claim-pill is-small ${STAGE_TONES[line.stage]}`}>{line.stageLabel}</span>
                    {line.missing && <span className="admin-claim-lines-missing">{line.missing}</span>}
                  </li>
                ))}
                {item.unresolved > 0 && (
                  <li data-claim-line="unresolved" data-stage="pending">
                    <span className="admin-claim-lines-qty">{item.unresolved}</span>
                    <span className="admin-claim-lines-arrow" aria-hidden="true">→</span>
                    <span className="admin-claim-lines-solution">Sin definir</span>
                    <span className="admin-claim-pill is-small is-warning">Pendiente</span>
                  </li>
                )}
              </ul>
              {onSwitch && replacementSwitch?.available && (
                <div className="admin-claim-lines-switch" data-claim-line-switch={item.orderItemId}>
                  <span>¿Sin stock para reemplazar?</span>
                  <button type="button" className="admin-claim-progress-link" disabled={disabled}
                    onClick={() => onSwitch(item.orderItemId, "refund")}>Pasar a reintegro</button>
                  <button type="button" className="admin-claim-progress-link" disabled={disabled}
                    onClick={() => onSwitch(item.orderItemId, "credit")}>Pasar a saldo a favor</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {actions && <div className="admin-claim-lines-actions" data-claim-line-actions>{actions}</div>}
    </section>
  )
}

/**
 * Reparto de las unidades al aprobar: por producto, un contador por solución.
 * `minimum`: unidades ya asignadas que no se reducen (completar pendientes).
 */
export function ClaimLineEditor({
  items,
  values,
  onChange,
  minimum = {},
}: {
  items: Array<{ orderItemId: number; name: string; claimed: number }>
  values: Record<string, number>
  onChange: (next: Record<string, number>) => void
  minimum?: Record<string, number>
}) {
  return (
    <div className="admin-claim-lines is-editor" data-claim-line-editor>
      <ul className="admin-claim-lines-list">
        {items.map((item) => {
          const assigned = CLAIM_LINE_SOLUTIONS.reduce((sum, solution) => sum + (values[claimLineKey(item.orderItemId, solution)] ?? 0), 0)
          const unassigned = item.claimed - assigned
          return (
            <li key={item.orderItemId} className="admin-claim-lines-item" data-claim-item={item.orderItemId}>
              <div className="admin-claim-lines-head">
                <span className="admin-claim-lines-name">{item.name}</span>
                <span className="admin-claim-lines-count">
                  {item.claimed} {item.claimed === 1 ? "unidad reclamada" : "unidades reclamadas"}
                </span>
              </div>
              <ul className="admin-claim-lines-rows">
                {CLAIM_LINE_SOLUTIONS.map((solution) => {
                  const key = claimLineKey(item.orderItemId, solution)
                  const value = values[key] ?? 0
                  const label = CLAIM_LINE_SOLUTION_LABELS[solution].action
                  const set = (next: number) => onChange({ ...values, [key]: next })
                  return (
                    <li key={solution} className="admin-claim-lines-stepper-row" data-claim-line={solution}>
                      <span className="admin-claim-lines-solution">{label}</span>
                      <span className="admin-claim-lines-stepper">
                        <button type="button" aria-label={`Una unidad menos: ${label}`} disabled={value <= (minimum[key] ?? 0)}
                          onClick={() => set(value - 1)}><Minus className="size-3.5" aria-hidden="true" /></button>
                        <output aria-label={`${label}: unidades`}>{value}</output>
                        <button type="button" aria-label={`Una unidad más: ${label}`} disabled={unassigned <= 0}
                          onClick={() => set(value + 1)}><Plus className="size-3.5" aria-hidden="true" /></button>
                      </span>
                    </li>
                  )
                })}
              </ul>
              {unassigned > 0 && <p className="admin-claim-lines-missing" data-claim-line-unassigned>Sin definir: {unassigned}</p>}
            </li>
          )
        })}
      </ul>
      <p className="admin-claim-lines-hint">Saldo a favor también sirve para cambiar por otro producto. {CLAIM_PRODUCT_CHANGE_HINT}</p>
    </div>
  )
}
