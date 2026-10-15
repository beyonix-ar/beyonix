"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp, ChevronRight, History, Info, ListChecks, Pencil, RotateCcw, Trash2 } from "lucide-react"

import {
  AdminButton,
  AdminDangerButton,
  AdminGhostButton,
  AdminModal,
  AdminRowMenu,
  AdminSection,
  AdminSelect,
  AdminTextInput,
} from "@/app/admin/components/admin-controls"
import { LABEL_CODE_SOURCE_LABELS, type LabelCatalogProduct } from "@/lib/labels/catalog"
import { autoShortName } from "@/lib/labels/drawing"
import type { LabelBatchSummary } from "@/lib/labels/history"
import {
  MAX_LABEL_NAME_LENGTH,
  changeQueueCode,
  findTarget,
  moveQueueItem,
  queueLabelCount,
  removeFromQueue,
  setQueueCopies,
  setQueueLabelName,
  type LabelQueueItem,
} from "@/lib/labels/queue"
import type { LabelPrintOrder } from "@/lib/labels/settings"

import { LabelQuantity } from "./label-quantity"
import { targetDetail, type QueueUpdate } from "./label-search-panel"
import { LabelSwatch } from "./label-swatch"

const ORDER_HINTS: Record<Exclude<LabelPrintOrder, "manual">, string> = {
  product: "Se imprime agrupado por producto: subir y bajar ordena los productos.",
  variant: "Se imprime ordenado alfabéticamente por producto y variante: el orden de la tanda no cambia la impresión.",
}

function QueueRow({ item, index, total, maxCopies, products, patternError, placement, reorderable, update }: {
  item: LabelQueueItem
  index: number
  total: number
  maxCopies: number
  products: ReadonlyMap<number, LabelCatalogProduct>
  patternError: string | null
  /** "Etiquetas 1–5 · fila 1–3": dónde cae el artículo en la tanda. */
  placement: string | null
  reorderable: boolean
  update: QueueUpdate
}) {
  const [editingName, setEditingName] = useState(Boolean(item.labelName))
  const product = products.get(item.productId)
  const target = product ? findTarget([product], item.productId, item.variantId) : null
  const label = [item.productName, item.variantLabel].filter(Boolean).join(" ")
  const problem = item.issue ?? patternError
  return (
    <li className="admin-label-row" data-problem={problem ? "true" : "false"}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <LabelSwatch colorHex={item.colorHex} colorHexSecondary={item.colorHexSecondary} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-white" title={item.productName}>{item.labelName ?? item.productName}</p>
          <p className="truncate text-xs text-white/62">{targetDetail(item.variantLabel, item.sku) || item.code}</p>
          {placement && !problem && <p className="truncate text-11px font-bold text-white/58" data-label-placement>{placement}</p>}
        </div>
        {item.issue ? (
          <AdminGhostButton size="icon" aria-label={`Quitar ${label} de la tanda`} onClick={() => update((queue) => removeFromQueue(queue, item.key))}>
            <Trash2 className="size-3.5" />
          </AdminGhostButton>
        ) : (
          <LabelQuantity
            value={item.copies}
            max={maxCopies}
            label={label}
            onChange={(copies) => update((queue) => setQueueCopies(queue, item.key, copies, maxCopies))}
            onRemove={() => update((queue) => removeFromQueue(queue, item.key))}
          />
        )}
        <AdminRowMenu
          ariaLabel={`Más acciones de ${label}`}
          items={[
            { key: "name", label: "Texto corto de la etiqueta", icon: <Pencil className="size-3.5" />, onSelect: () => setEditingName(true) },
            { key: "up", label: "Subir", icon: <ArrowUp className="size-3.5" />, disabled: !reorderable || index === 0, onSelect: () => update((queue) => moveQueueItem(queue, item.key, -1)) },
            { key: "down", label: "Bajar", icon: <ArrowDown className="size-3.5" />, disabled: !reorderable || index === total - 1, onSelect: () => update((queue) => moveQueueItem(queue, item.key, 1)) },
            { key: "divider", divider: true },
            { key: "remove", label: "Quitar de la tanda", icon: <Trash2 className="size-3.5" />, tone: "danger", onSelect: () => update((queue) => removeFromQueue(queue, item.key)) },
          ]}
        />
      </div>
      {editingName && (
        <div className="px-3 pb-2.5 pl-10">
          <AdminTextInput
            title="Texto corto de la etiqueta"
            ariaLabel={`Texto corto de la etiqueta de ${label}`}
            placeholder={autoShortName(item.productName)}
            maxLength={MAX_LABEL_NAME_LENGTH}
            value={item.labelName ?? ""}
            className="h-9"
            onChange={(value) => update((queue) => setQueueLabelName(queue, item.key, value))}
          />
          <p className="mt-1 text-11px text-white/58">Sólo cambia lo impreso. Vacío = nombre corto automático.</p>
        </div>
      )}
      {problem && (
        <div className="space-y-2 px-3 pb-2.5 pl-10">
          <p role="alert" className="text-xs font-bold text-red-300">{problem}</p>
          {item.issue && target && target.options.length > 0 && (
            <AdminSelect title="Elegir otro código" ariaLabel={`Elegir otro código para ${label}`} value="" compact wrapperClassName="w-60 max-w-full" onChange={(code) => code && update((queue) => changeQueueCode(queue, item.key, target, code, maxCopies))}>
              <option value="">Elegir otro código…</option>
              {target.options.map((option) => <option key={option.code} value={option.code}>{`${option.code} · ${LABEL_CODE_SOURCE_LABELS[option.source]}`}</option>)}
            </AdminSelect>
          )}
        </div>
      )}
    </li>
  )
}

const dateFormatter = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
const OUTPUT_LABELS: Record<LabelBatchSummary["output"], string> = { print: "Impresa", pdf: "PDF", zpl: "ZPL" }

export function LabelQueuePanel({ queue, products, maxCopies, order, patternErrors, placements, batches, historyAvailable, onRepeat, onContinue, update, className }: {
  queue: LabelQueueItem[]
  products: ReadonlyMap<number, LabelCatalogProduct>
  maxCopies: number
  order: LabelPrintOrder
  patternErrors: Readonly<Record<string, string>>
  placements: ReadonlyMap<string, string>
  batches: LabelBatchSummary[]
  historyAvailable: boolean
  onRepeat: (batch: LabelBatchSummary) => void
  onContinue: () => void
  update: QueueUpdate
  className?: string
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  const total = queueLabelCount(queue)
  const withIssues = queue.filter((item) => item.issue).length
  return (
    <AdminSection
      compact
      icon={<ListChecks className="size-4" />}
      title="Tanda"
      description={queue.length ? `${queue.length} ${queue.length === 1 ? "artículo" : "artículos"}` : "Todavía no agregaste productos."}
      actions={queue.length > 0 ? <AdminGhostButton size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmClear(true)}>Vaciar</AdminGhostButton> : undefined}
      className={className}
    >
      {withIssues > 0 && <p role="alert" className="mb-2 text-xs font-bold text-amber-300">{withIssues === 1 ? "1 artículo no se va a imprimir" : `${withIssues} artículos no se van a imprimir`} hasta resolver el aviso.</p>}
      {queue.length === 0 ? (
        <p className="admin-label-empty px-4 py-8 text-center text-sm text-white/62">Buscá un producto y tocá <strong className="text-white">Agregar</strong>. Con − y + elegís cuántas etiquetas de cada uno.</p>
      ) : (
        <ul className="admin-label-results">
          {queue.map((item, index) => (
            <QueueRow
              key={item.key}
              item={item}
              index={index}
              total={queue.length}
              maxCopies={maxCopies}
              products={products}
              patternError={patternErrors[item.code] ?? null}
              placement={placements.get(item.key) ?? null}
              reorderable={order !== "variant" && queue.length > 1}
              update={update}
            />
          ))}
        </ul>
      )}
      {order !== "manual" && queue.length > 1 && (
        <p className="mt-2 flex gap-1.5 text-xs text-white/62"><Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />{ORDER_HINTS[order]}</p>
      )}

      <div className="admin-label-total mt-3 flex items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-sm font-bold text-white/72">Total a imprimir</span>
        <span className="text-lg font-black text-white" data-label-total>{total} {total === 1 ? "etiqueta" : "etiquetas"}</span>
      </div>
      <AdminButton variant="primary" className="mt-3 w-full" disabled={!total} onClick={onContinue}>
        Continuar: elegir formato
        <ChevronRight className="size-4" />
      </AdminButton>

      {historyAvailable && (
        <details className="admin-label-details mt-4 text-sm">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-bold text-white/72">
            <History className="size-3.5" aria-hidden="true" />
            Tandas recientes{batches.length ? ` (${batches.length})` : ""}
          </summary>
          {batches.length ? (
            <ul className="mt-2 divide-y divide-white/8">
              {batches.map((batch) => (
                <li key={batch.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-white" title={batch.name}>{batch.name}</p>
                    <p className="text-xs text-white/58">{batch.labelCount} {batch.labelCount === 1 ? "etiqueta" : "etiquetas"} · {OUTPUT_LABELS[batch.output]} · {dateFormatter.format(new Date(batch.createdAt))}</p>
                  </div>
                  <AdminButton size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => onRepeat(batch)}>Repetir</AdminButton>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-xs text-white/58">Todavía no imprimiste ninguna tanda.</p>}
        </details>
      )}

      <AdminModal
        open={confirmClear}
        compact
        title="Vaciar la tanda"
        description={`Se quitan ${queue.length} ${queue.length === 1 ? "artículo" : "artículos"} (${total} ${total === 1 ? "etiqueta" : "etiquetas"}). No afecta productos ni stock.`}
        onClose={() => setConfirmClear(false)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setConfirmClear(false)}>Cancelar</AdminButton><AdminDangerButton onClick={() => { update(() => []); setConfirmClear(false) }}>Vaciar tanda</AdminDangerButton></div>}
      >
        <span />
      </AdminModal>
    </AdminSection>
  )
}
