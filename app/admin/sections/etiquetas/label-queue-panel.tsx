"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp, History, ListOrdered, Minus, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react"

import {
  AdminBadge,
  AdminButton,
  AdminDangerButton,
  AdminGhostButton,
  AdminModal,
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
  parseCopies,
  queueLabelCount,
  removeFromQueue,
  setQueueCopies,
  setQueueLabelName,
  stepQueueCopies,
  type LabelQueueItem,
} from "@/lib/labels/queue"
import { classifyBarcode } from "@/lib/labels/symbology"

import { LabelSwatch } from "./label-swatch"

type QueueUpdate = (change: (queue: LabelQueueItem[]) => LabelQueueItem[]) => void

function CopiesInput({ item, maxCopies, update }: { item: LabelQueueItem; maxCopies: number; update: QueueUpdate }) {
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = draft !== null && !parseCopies(draft, maxCopies)
  return (
    <div className="flex items-center gap-1">
      <AdminGhostButton size="icon" aria-label={`Restar una etiqueta de ${item.productName}`} disabled={item.copies <= 1} onClick={() => update((queue) => stepQueueCopies(queue, item.key, -1, maxCopies))}>
        <Minus className="size-3.5" />
      </AdminGhostButton>
      <div className="w-14" onBlur={() => setDraft(null)}>
        <AdminTextInput
          title="Cantidad"
          placeholder="1"
          ariaLabel={`Cantidad de etiquetas de ${[item.productName, item.variantLabel].filter(Boolean).join(" ")}`}
          inputMode="numeric"
          value={draft ?? String(item.copies)}
          className={`h-9 px-1 text-center font-black ${invalid ? "text-red-300" : ""}`}
          onChange={(value) => {
            const clean = value.replace(/\D/g, "").slice(0, 3)
            setDraft(clean)
            if (parseCopies(clean, maxCopies)) update((queue) => setQueueCopies(queue, item.key, clean, maxCopies))
          }}
        />
      </div>
      <AdminGhostButton size="icon" aria-label={`Sumar una etiqueta de ${item.productName}`} disabled={item.copies >= maxCopies} onClick={() => update((queue) => stepQueueCopies(queue, item.key, 1, maxCopies))}>
        <Plus className="size-3.5" />
      </AdminGhostButton>
    </div>
  )
}

function QueueRow({ item, index, total, maxCopies, products, patternError, update }: {
  item: LabelQueueItem
  index: number
  total: number
  maxCopies: number
  products: ReadonlyMap<number, LabelCatalogProduct>
  patternError: string | null
  update: QueueUpdate
}) {
  const [editingName, setEditingName] = useState(false)
  const product = products.get(item.productId)
  const target = product ? findTarget([product], item.productId, item.variantId) : null
  const classification = classifyBarcode(item.code)
  return (
    <li className={`py-2.5 ${item.issue ? "opacity-90" : ""}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-1"><LabelSwatch colorHex={item.colorHex} colorHexSecondary={item.colorHexSecondary} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-white" title={item.productName}>
            {item.productName}
            {item.variantLabel && <span className="font-bold text-white/70"> · {item.variantLabel}</span>}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/60">
            <span className="font-mono font-bold text-white/85">{item.code}</span>
            {classification && <AdminBadge tone={classification.kind === "code128" ? "neutral" : "info"}>{classification.label}</AdminBadge>}
            <span>{LABEL_CODE_SOURCE_LABELS[item.codeSource]}</span>
            {item.sku && <span>SKU {item.sku}</span>}
          </div>
          {item.labelName && !editingName && <p className="mt-0.5 text-xs text-white/60">Texto de etiqueta: <span className="font-bold text-white/85">{item.labelName}</span></p>}
        </div>
        <div className="flex shrink-0 items-center">
          <CopiesInput item={item} maxCopies={maxCopies} update={update} />
        </div>
      </div>
      {editingName && (
        <div className="mt-2 pl-6.5">
          <AdminTextInput
            title="Texto de etiqueta"
            ariaLabel={`Texto corto de etiqueta para ${item.productName}`}
            placeholder={autoShortName(item.productName)}
            maxLength={MAX_LABEL_NAME_LENGTH}
            value={item.labelName ?? ""}
            className="h-9"
            onChange={(value) => update((queue) => setQueueLabelName(queue, item.key, value))}
          />
          <p className="mt-1 text-11px text-white/50">Sólo cambia lo impreso; el nombre comercial del producto no se modifica. Vacío = nombre corto automático.</p>
        </div>
      )}
      {(item.issue || patternError) && (
        <div className="mt-2 space-y-2 pl-6.5">
          <p role="alert" className="text-xs font-bold text-red-300">{item.issue ?? patternError}</p>
          {item.issue && target && target.options.length > 0 && (
            <AdminSelect title="Elegir otro código" ariaLabel={`Elegir otro código para ${item.productName}`} value="" compact wrapperClassName="w-60 max-w-full" onChange={(code) => code && update((queue) => changeQueueCode(queue, item.key, target, code, maxCopies))}>
              <option value="">Elegir otro código…</option>
              {target.options.map((option) => <option key={option.code} value={option.code}>{`${option.code} · ${LABEL_CODE_SOURCE_LABELS[option.source]}`}</option>)}
            </AdminSelect>
          )}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-6.5">
        {!item.issue && target && target.options.length > 1 && (
          <AdminSelect title="Código a imprimir" ariaLabel={`Código a imprimir de ${item.productName}`} value={item.code} compact wrapperClassName="w-56 max-w-full" onChange={(code) => update((queue) => changeQueueCode(queue, item.key, target, code, maxCopies))}>
            {target.options.map((option) => <option key={option.code} value={option.code}>{`${option.code} · ${LABEL_CODE_SOURCE_LABELS[option.source]}`}</option>)}
          </AdminSelect>
        )}
        <AdminGhostButton size="icon" aria-label={`Editar texto de etiqueta de ${item.productName}`} aria-pressed={editingName} title="Texto corto de etiqueta" onClick={() => setEditingName((current) => !current)}>
          <Pencil className="size-3.5" />
        </AdminGhostButton>
        <AdminGhostButton size="icon" aria-label={`Subir ${item.productName}`} disabled={index === 0} onClick={() => update((queue) => moveQueueItem(queue, item.key, -1))}>
          <ArrowUp className="size-3.5" />
        </AdminGhostButton>
        <AdminGhostButton size="icon" aria-label={`Bajar ${item.productName}`} disabled={index === total - 1} onClick={() => update((queue) => moveQueueItem(queue, item.key, 1))}>
          <ArrowDown className="size-3.5" />
        </AdminGhostButton>
        <AdminGhostButton size="icon" aria-label={`Quitar ${item.productName} de la cola`} onClick={() => update((queue) => removeFromQueue(queue, item.key))}>
          <Trash2 className="size-3.5" />
        </AdminGhostButton>
      </div>
    </li>
  )
}

const dateFormatter = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
const OUTPUT_LABELS: Record<LabelBatchSummary["output"], string> = { print: "Impresa", pdf: "PDF", zpl: "ZPL" }

export function LabelQueuePanel({ queue, products, maxCopies, patternErrors, batches, historyAvailable, onRepeat, update, className }: {
  queue: LabelQueueItem[]
  products: ReadonlyMap<number, LabelCatalogProduct>
  maxCopies: number
  patternErrors: Readonly<Record<string, string>>
  batches: LabelBatchSummary[]
  historyAvailable: boolean
  onRepeat: (batch: LabelBatchSummary) => void
  update: QueueUpdate
  className?: string
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const total = queueLabelCount(queue)
  const withIssues = queue.filter((item) => item.issue).length
  return (
    <AdminSection
      compact
      icon={<ListOrdered className="size-4" />}
      title="Cola de impresión"
      description={queue.length ? `${queue.length} ${queue.length === 1 ? "artículo" : "artículos"} · ${total} ${total === 1 ? "etiqueta" : "etiquetas"}` : "Agregá artículos desde la búsqueda."}
      actions={queue.length > 0 ? <AdminButton size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmClear(true)}>Vaciar</AdminButton> : undefined}
      className={className}
    >
      {withIssues > 0 && <p role="alert" className="mb-2 text-xs font-bold text-amber-300">{withIssues === 1 ? "1 fila no se va a imprimir" : `${withIssues} filas no se van a imprimir`} hasta resolver el aviso.</p>}
      {queue.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/55">La cola está vacía. Buscá un producto, elegí la cantidad y tocá Agregar.</p>
      ) : (
        <ul className="divide-y divide-white/10">
          {queue.map((item, index) => (
            <QueueRow key={item.key} item={item} index={index} total={queue.length} maxCopies={maxCopies} products={products} patternError={patternErrors[item.code] ?? null} update={update} />
          ))}
        </ul>
      )}
      {historyAvailable && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <AdminGhostButton size="sm" icon={<History className="size-3.5" />} aria-expanded={showHistory} onClick={() => setShowHistory((current) => !current)}>
            Tandas recientes{batches.length ? ` (${batches.length})` : ""}
          </AdminGhostButton>
          {showHistory && (
            batches.length ? (
              <ul className="mt-2 divide-y divide-white/8">
                {batches.map((batch) => (
                  <li key={batch.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-white" title={batch.name}>{batch.name}</p>
                      <p className="text-xs text-white/55">{batch.labelCount} {batch.labelCount === 1 ? "etiqueta" : "etiquetas"} · {OUTPUT_LABELS[batch.output]} · {dateFormatter.format(new Date(batch.createdAt))}</p>
                    </div>
                    <AdminButton size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => onRepeat(batch)}>Repetir</AdminButton>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-xs text-white/55">Todavía no imprimiste ninguna tanda.</p>
          )}
        </div>
      )}
      <AdminModal
        open={confirmClear}
        compact
        title="Vaciar la cola"
        description={`Se quitan ${queue.length} ${queue.length === 1 ? "artículo" : "artículos"} (${total} etiquetas). No afecta productos ni stock.`}
        onClose={() => setConfirmClear(false)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setConfirmClear(false)}>Cancelar</AdminButton><AdminDangerButton onClick={() => { update(() => []); setConfirmClear(false) }}>Vaciar cola</AdminDangerButton></div>}
      >
        <span />
      </AdminModal>
    </AdminSection>
  )
}
