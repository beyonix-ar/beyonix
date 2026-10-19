"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp, ChevronDown, History, Info, ListChecks, Pencil, RotateCcw, Trash2, TriangleAlert } from "lucide-react"

import {
  AdminBadge,
  AdminButton,
  AdminDangerButton,
  AdminGhostButton,
  AdminModal,
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
  setQueueLabelName,
  type LabelQueueItem,
} from "@/lib/labels/queue"
import type { LabelPrintOrder } from "@/lib/labels/settings"
import { classifyBarcode } from "@/lib/labels/symbology"
import { cn } from "@/lib/utils"

import { LabelSwatch } from "./label-swatch"
import { LABEL_STEP_IDS, LabelStepSection, plural } from "./label-ui"

type QueueUpdate = (change: (queue: LabelQueueItem[]) => LabelQueueItem[]) => void

const ORDER_HINTS: Record<Exclude<LabelPrintOrder, "manual">, string> = {
  product: "Se imprime agrupado por producto: las flechas ordenan los productos.",
  variant: "Se imprime ordenado alfabéticamente por producto y variante: el orden de la cola no cambia la impresión.",
}

function QueueRow({ item, index, total, maxCopies, products, patternError, placement, reorderable, update }: {
  item: LabelQueueItem
  index: number
  total: number
  maxCopies: number
  products: ReadonlyMap<number, LabelCatalogProduct>
  patternError: string | null
  placement: string | null
  reorderable: boolean
  update: QueueUpdate
}) {
  const [editingName, setEditingName] = useState(false)
  const product = products.get(item.productId)
  const target = product ? findTarget([product], item.productId, item.variantId) : null
  const classification = classifyBarcode(item.code)
  const fullName = [item.productName, item.variantLabel].filter(Boolean).join(" ")
  const problem = item.issue ?? patternError
  const codeSelect = target && target.options.length > (item.issue ? 0 : 1)
  return (
    <li className="rounded-xl border border-white/10 bg-white/3 p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-white/8 text-11px font-black tabular-nums text-white/70" aria-hidden="true">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex"><LabelSwatch colorHex={item.colorHex} colorHexSecondary={item.colorHexSecondary} /></span>
            <span className="min-w-0 line-clamp-2 text-sm font-black leading-5 text-white" title={fullName}>
              {item.productName}
              {item.variantLabel && <span className="font-bold text-white/70"> · {item.variantLabel}</span>}
            </span>
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-white/60">
            <span className="font-mono font-bold text-white/85">{item.code}</span>
            {classification && <AdminBadge tone={classification.kind === "code128" ? "neutral" : "info"} className="px-1.5 py-0.5">{classification.label}</AdminBadge>}
            <span>{LABEL_CODE_SOURCE_LABELS[item.codeSource]}</span>
            {item.sku && <span>SKU {item.sku}</span>}
          </div>
          {placement && !problem && <p className="mt-1 text-11px font-bold text-beyonix-cyan">{placement}</p>}
          {item.labelName && !editingName && (
            <p className="mt-1 text-xs text-white/60">Texto impreso: <span className="font-bold text-white/85">{item.labelName}</span></p>
          )}
        </div>
        <span className="shrink-0 text-xs font-bold text-emerald-300">×{item.copies}</span>
      </div>

      {editingName && (
        <div className="mt-3 pl-9">
          <AdminTextInput
            title="Texto de etiqueta"
            ariaLabel={`Texto corto de etiqueta para ${item.productName}`}
            placeholder={autoShortName(item.productName)}
            maxLength={MAX_LABEL_NAME_LENGTH}
            value={item.labelName ?? ""}
            className="h-9"
            onChange={(value) => update((queue) => setQueueLabelName(queue, item.key, value))}
          />
          <p className="mt-1 text-11px text-white/50">Sólo cambia lo impreso; el nombre del producto no se modifica. Vacío = nombre corto automático.</p>
        </div>
      )}

      {problem && (
        <p role="alert" className="mt-2.5 ml-9 flex items-start gap-1.5 text-xs font-bold text-red-300">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />{problem}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1 pl-9">
        {codeSelect && (
          <AdminSelect
            title={item.issue ? "Elegir otro código" : "Código a imprimir"}
            ariaLabel={`${item.issue ? "Elegir otro código para" : "Código a imprimir de"} ${item.productName}`}
            value={item.issue ? "" : item.code}
            compact
            wrapperClassName="mr-1 w-52 max-w-full"
            onChange={(code) => code && update((queue) => changeQueueCode(queue, item.key, target, code, maxCopies))}
          >
            {item.issue && <option value="">Elegir otro código…</option>}
            {target.options.map((option) => <option key={option.code} value={option.code}>{`${option.code} · ${LABEL_CODE_SOURCE_LABELS[option.source]}`}</option>)}
          </AdminSelect>
        )}
        <AdminGhostButton size="sm" icon={<Pencil className="size-3.5" />} aria-label={`Editar texto de etiqueta de ${item.productName}`} aria-pressed={editingName} title="Texto corto que se imprime" onClick={() => setEditingName((current) => !current)}>
          Texto
        </AdminGhostButton>
        {reorderable && (
          <>
            <AdminGhostButton size="icon" className="size-8" aria-label={`Subir ${item.productName}`} title="Subir" disabled={index === 0} onClick={() => update((queue) => moveQueueItem(queue, item.key, -1))}>
              <ArrowUp className="size-3.5" />
            </AdminGhostButton>
            <AdminGhostButton size="icon" className="size-8" aria-label={`Bajar ${item.productName}`} title="Bajar" disabled={index === total - 1} onClick={() => update((queue) => moveQueueItem(queue, item.key, 1))}>
              <ArrowDown className="size-3.5" />
            </AdminGhostButton>
          </>
        )}
        <AdminGhostButton size="sm" className="ml-auto text-red-300" icon={<Trash2 className="size-3.5" />} aria-label={`Quitar ${item.productName} de la cola`} onClick={() => update((queue) => removeFromQueue(queue, item.key))}>
          Quitar
        </AdminGhostButton>
      </div>
    </li>
  )
}

const dateFormatter = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
const OUTPUT_LABELS: Record<LabelBatchSummary["output"], string> = { print: "Impresa", pdf: "PDF", zpl: "ZPL" }

export function BatchHistory({ batches, onRepeat }: { batches: LabelBatchSummary[]; onRepeat: (batch: LabelBatchSummary) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-4 border-t border-white/10 pt-3">
      <button type="button" className="flex w-full items-center justify-between gap-2 rounded-lg py-1 text-left text-xs font-black text-white/75 hover:text-white" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="inline-flex items-center gap-2"><History className="size-3.5 text-beyonix-cyan" aria-hidden="true" />Tandas recientes{batches.length ? ` (${batches.length})` : ""}</span>
        <ChevronDown className={cn("size-4 transition", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        batches.length ? (
          <ul className="mt-2 divide-y divide-white/8">
            {batches.map((batch) => (
              <li key={batch.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-white" title={batch.name}>{batch.name}</p>
                  <p className="text-xs text-white/55">{plural(batch.labelCount, "etiqueta")} · {OUTPUT_LABELS[batch.output]} · {dateFormatter.format(new Date(batch.createdAt))}</p>
                </div>
                <AdminButton size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => onRepeat(batch)}>Repetir</AdminButton>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-xs text-white/55">Todavía no imprimiste ninguna tanda. Cada impresión o descarga queda acá para repetirla.</p>
      )}
    </div>
  )
}

export function LabelQueuePanel({ queue, products, maxCopies, order, patternErrors, placements, batches, historyAvailable, onRepeat, update, className }: {
  queue: LabelQueueItem[]
  products: ReadonlyMap<number, LabelCatalogProduct>
  maxCopies: number
  order: LabelPrintOrder
  patternErrors: Readonly<Record<string, string>>
  /** Dónde cae cada fila en la tanda (p. ej. "Etiquetas 1–5 · hoja 1"). */
  placements: ReadonlyMap<string, string>
  batches: LabelBatchSummary[]
  historyAvailable: boolean
  onRepeat: (batch: LabelBatchSummary) => void
  update: QueueUpdate
  className?: string
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  const total = queueLabelCount(queue)
  const withIssues = queue.filter((item) => item.issue || patternErrors[item.code]).length
  return (
    <LabelStepSection
      id={LABEL_STEP_IDS.queue}
      step={2}
      title="Cola de impresión"
      description={queue.length ? `${plural(queue.length, "artículo")} · ${plural(total, "etiqueta")}` : "Lo que agregues aparece acá, listo para revisar."}
      actions={queue.length > 0 ? <AdminGhostButton size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmClear(true)}>Vaciar cola</AdminGhostButton> : undefined}
      className={className}
    >
      {withIssues > 0 && (
        <p role="alert" className="mb-3 flex items-start gap-1.5 text-xs font-bold text-amber-300">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          {withIssues === 1 ? "1 artículo no se va a imprimir" : `${withIssues} artículos no se van a imprimir`} hasta resolver el aviso.
        </p>
      )}
      {order !== "manual" && queue.length > 1 && (
        <p className="mb-3 flex items-start gap-1.5 text-xs text-white/60">
          <Info className="mt-px size-3.5 shrink-0 text-beyonix-cyan" aria-hidden="true" />{ORDER_HINTS[order]}
        </p>
      )}
      {queue.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <ListChecks className="size-8 text-white/30" aria-hidden="true" />
          <p className="text-sm font-black text-white">La cola está vacía</p>
          <p className="max-w-xs text-xs leading-5 text-white/55">Buscá un producto en el paso 1, elegí la cantidad y tocá <span className="font-bold text-white/80">Agregar</span>. Si agregás el mismo artículo dos veces, se suman las cantidades.</p>
        </div>
      ) : (
        <ul className="space-y-2">
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
      {historyAvailable && <BatchHistory batches={batches} onRepeat={onRepeat} />}
      <AdminModal
        open={confirmClear}
        compact
        title="Vaciar la cola"
        description={`Se quitan ${plural(queue.length, "artículo")} (${plural(total, "etiqueta")}). No afecta productos ni stock.`}
        onClose={() => setConfirmClear(false)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setConfirmClear(false)}>Cancelar</AdminButton><AdminDangerButton onClick={() => { update(() => []); setConfirmClear(false) }}>Vaciar cola</AdminDangerButton></div>}
      >
        <span />
      </AdminModal>
    </LabelStepSection>
  )
}
