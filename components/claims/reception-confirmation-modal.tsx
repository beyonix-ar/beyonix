"use client"

import { createPortal } from "react-dom"
import { PackageCheck } from "lucide-react"

export interface ReceptionConfirmationModalProps {
  productName: string
  restocked: number
  writtenOff: number
  productStock: number
  stockDelta: number
  variant: { name: string; stock: number } | null
  saving: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Confirmación de recepción de inventario ("Confirmar movimiento").
 *
 * Se monta con un Portal en document.body: así no queda dentro de
 * .admin-order-detail-scope ni de ningún contenedor del admin, y ninguna
 * regla CSS contextual de esas zonas (fondos por [class*="bg-"], cajas por
 * [rounded][border], remapeos de texto del tema) puede alcanzarlo. Todos sus
 * estilos son propios (admin-reception-modal__*, globals.css), con variantes
 * Dark y Light según html[data-admin-theme].
 *
 * SSR: sólo se renderiza cuando el operador abre la confirmación (interacción
 * en el cliente); igual se protege el acceso a `document`.
 */
export function ReceptionConfirmationModal({
  productName,
  restocked,
  writtenOff,
  productStock,
  stockDelta,
  variant,
  saving,
  onCancel,
  onConfirm,
}: ReceptionConfirmationModalProps) {
  if (typeof document === "undefined") return null

  return createPortal(
    <div className="admin-reception-modal__backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-inventory-confirmation-title"
        aria-describedby="return-inventory-confirmation-description"
        className="admin-reception-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="admin-reception-modal__header">
          <span className="admin-reception-modal__icon" aria-hidden="true">
            <PackageCheck className="admin-reception-modal__icon-svg" />
          </span>
          <div className="admin-reception-modal__heading">
            <p className="admin-reception-modal__eyebrow">Confirmar movimiento</p>
            <h4 id="return-inventory-confirmation-title" className="admin-reception-modal__title">
              Recepción de {productName}
            </h4>
            <p id="return-inventory-confirmation-description" className="admin-reception-modal__subtitle">
              Revisá el destino de las unidades antes de modificar el inventario.
            </p>
          </div>
        </header>

        <div className="admin-reception-modal__metrics">
          <div className="admin-reception-modal__metric is-restock">
            <p className="admin-reception-modal__metric-label">Vuelven al stock</p>
            <p className="admin-reception-modal__metric-value">{restocked}</p>
          </div>
          <div className="admin-reception-modal__metric is-writeoff">
            <p className="admin-reception-modal__metric-label">Baja o pérdida</p>
            <p className="admin-reception-modal__metric-value">{writtenOff}</p>
          </div>
        </div>

        <div className="admin-reception-modal__stock">
          <p className="admin-reception-modal__stock-label">Stock resultante</p>
          <div className="admin-reception-modal__stock-lines">
            <p>
              Stock general del producto: {productStock} → {productStock + stockDelta}
            </p>
            {variant && (
              <p>
                Variante {variant.name}: {variant.stock} → {variant.stock + stockDelta}
              </p>
            )}
          </div>
        </div>

        <p className="admin-reception-modal__warning">
          Al confirmar se registra la recepción y su impacto de stock. Si queda remanente reclamado, podrás registrar una nueva recepción. No se borra el historial anterior.
        </p>

        <div className="admin-reception-modal__actions">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="admin-reception-modal__button is-secondary"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onConfirm}
            className="admin-reception-modal__button is-primary"
          >
            <PackageCheck className="admin-reception-modal__button-icon" aria-hidden="true" />
            Confirmar recepción
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
