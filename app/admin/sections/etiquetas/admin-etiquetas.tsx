"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Check } from "lucide-react"

import { AdminInfoBlock, AdminPageHeader, adminPageClassName } from "@/app/admin/components/admin-controls"
import { printHtmlDocument } from "@/lib/barcodes/print-labels"
import type { LabelCatalogProduct, LabelTarget } from "@/lib/labels/catalog"
import {
  deleteLabelPreset,
  fetchBarcodePatterns,
  loadLabelConfig,
  loadLabelProducts,
  saveLabelBatch,
  saveLabelPreference,
  saveLabelPreset,
  LabelApiError,
} from "@/lib/labels/client"
import type { BarcodePattern } from "@/lib/labels/drawing"
import { defaultBatchName, toBatchItems, type LabelBatchOutput, type LabelBatchSummary, type LabelPreset } from "@/lib/labels/history"
import { layoutNotices, type LabelPlan } from "@/lib/labels/layout"
import { labelQueueStore, labelSettingsStore } from "@/lib/labels/local-store"
import { addToQueue, createQueueItem, expandQueue, findTarget, queueLabelCount, reconcileQueue, type LabelQueueItem } from "@/lib/labels/queue"
import { buildPrintDocument, prepareBatch } from "@/lib/labels/render"
import { MAX_BATCH_LABELS, normalizeLabelSettings, type LabelSettings } from "@/lib/labels/settings"
import { buildZpl, zplUnavailableReason } from "@/lib/labels/zpl"
import { cn } from "@/lib/utils"

import { LabelFormatSample } from "./label-format-sample"
import { LabelZoomModal, previewPageCount } from "./label-preview"
import { LabelPrintStep, type PrintStatus } from "./label-print-step"
import { LabelQueuePanel } from "./label-queue-panel"
import { LabelSearchPanel } from "./label-search-panel"
import { LabelSettingsPanel, formatName } from "./label-settings-panel"

const PREFERENCE_SAVE_DELAY_MS = 1200

type Step = 1 | 2 | 3

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function fileStamp() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("es-AR")} ${count === 1 ? one : many}`

// Dónde cae cada artículo de la tanda (las copias de un artículo siempre
// quedan consecutivas): "Etiquetas 1–5 · fila 1–3".
function queuePlacements(labels: readonly LabelQueueItem[], plan: LabelPlan) {
  const placements = new Map<string, string>()
  if (plan.error || !plan.grid.perPage) return placements
  const ranges = new Map<string, { first: number; last: number }>()
  labels.forEach((item, index) => {
    const range = ranges.get(item.key)
    if (range) range.last = index
    else ranges.set(item.key, { first: index, last: index })
  })
  const unit = plan.mode === "a4" ? ["hoja", "hojas"] : ["fila", "filas"]
  ranges.forEach(({ first, last }, key) => {
    const from = Math.floor(first / plan.grid.perPage) + 1
    const to = Math.floor(last / plan.grid.perPage) + 1
    const labelsText = first === last ? `Etiqueta ${first + 1}` : `Etiquetas ${first + 1}–${last + 1}`
    placements.set(key, `${labelsText} · ${from === to ? `${unit[0]} ${from}` : `${unit[1]} ${from}–${to}`}`)
  })
  return placements
}

function Stepper({ step, onStep, items }: { step: Step; onStep: (step: Step) => void; items: { id: Step; title: string; summary: string; done: boolean }[] }) {
  return (
    <nav aria-label="Pasos para imprimir etiquetas">
      <ol className="admin-label-steps grid gap-2 sm:grid-cols-3">
        {items.map((item) => {
          const state = item.id === step ? "current" : item.done ? "done" : "todo"
          return (
            <li key={item.id}>
              <button type="button" className="admin-label-step flex w-full items-center gap-3 px-3 py-2.5 text-left" data-state={state} aria-current={item.id === step ? "step" : undefined} onClick={() => onStep(item.id)}>
                <span className="admin-label-step-number flex size-7 shrink-0 items-center justify-center text-xs font-black" aria-hidden="true">
                  {state === "done" ? <Check className="size-3.5" /> : item.id}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-black text-white">{item.title}</span>
                  <span className="block truncate text-xs text-white/62" data-step-summary>{item.summary}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export function AdminEtiquetas() {
  const queue = useSyncExternalStore(labelQueueStore.subscribe, labelQueueStore.get, labelQueueStore.getServer)
  const settings = useSyncExternalStore(labelSettingsStore.subscribe, labelSettingsStore.get, labelSettingsStore.getServer)
  const [step, setStep] = useState<Step>(1)
  const [formatReviewed, setFormatReviewed] = useState(false)
  const [products, setProducts] = useState<ReadonlyMap<number, LabelCatalogProduct>>(new Map())
  const [patterns, setPatterns] = useState<ReadonlyMap<string, BarcodePattern>>(new Map())
  const [patternErrors, setPatternErrors] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<LabelPreset[]>([])
  const [batches, setBatches] = useState<LabelBatchSummary[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [preferenceError, setPreferenceError] = useState("")
  const [page, setPage] = useState(0)
  const [zoomIndex, setZoomIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState<LabelBatchOutput | null>(null)
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null)
  const settingsTouched = useRef(false)
  // Filas ya validadas contra el catálogo del servidor en esta sesión.
  const validatedKeys = useRef(new Set<string>())

  const updateQueue = useCallback((change: (current: LabelQueueItem[]) => LabelQueueItem[]) => labelQueueStore.update(change), [])
  const updateSettings = useCallback((change: (current: LabelSettings) => LabelSettings) => {
    settingsTouched.current = true
    labelSettingsStore.update((current) => normalizeLabelSettings(change(current)))
  }, [])

  const mergeProducts = useCallback((items: LabelCatalogProduct[]) => {
    if (!items.length) return
    setProducts((current) => {
      const next = new Map(current)
      items.forEach((product) => next.set(product.id, product))
      return next
    })
  }, [])

  const goTo = useCallback((next: Step) => {
    if (next > 2) setFormatReviewed(true)
    setStep(next)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  // Presets, preferencia guardada e historial: una sola consulta.
  useEffect(() => {
    let current = true
    loadLabelConfig()
      .then((config) => {
        if (!current) return
        setPresets(config.presets)
        setBatches(config.batches)
        setStorageUnavailable(config.storageUnavailable)
        if (config.preference && !settingsTouched.current) labelSettingsStore.set(config.preference)
      })
      .catch(() => current && setPreferenceError("No se pudo cargar el formato guardado; se usa el de este navegador."))
      .finally(() => current && setConfigLoaded(true))
    return () => { current = false }
  }, [])

  // Toda fila que llega a la tanda sin validar (guardada en el navegador o
  // agregada desde Productos, incluso en otra pestaña) se revalida contra el
  // catálogo actual: nombre, color, SKU y que el código siga siendo suyo.
  useEffect(() => {
    const pending = queue.filter((item) => !validatedKeys.current.has(item.key))
    if (!pending.length) return
    pending.forEach((item) => validatedKeys.current.add(item.key))
    const keys = new Set(pending.map((item) => item.key))
    const missingIds = [...new Set(pending.filter((item) => !products.has(item.productId)).map((item) => item.productId))]
    const apply = (catalog: LabelCatalogProduct[]) => labelQueueStore.update((current) => {
      const fresh = new Map(reconcileQueue(current.filter((item) => keys.has(item.key)), catalog).map((item) => [item.key, item]))
      return current.map((item) => fresh.get(item.key) ?? item)
    })
    if (!missingIds.length) { apply([...products.values()]); return }
    loadLabelProducts(missingIds)
      .then((items) => {
        mergeProducts(items)
        apply([...products.values(), ...items])
      })
      .catch(() => {
        keys.forEach((key) => validatedKeys.current.delete(key))
        setMessage({ tone: "danger", text: "No se pudo revalidar la tanda con el catálogo. Revisá la conexión antes de imprimir." })
      })
  }, [queue, products, mergeProducts])

  // Recordar el formato (debounce) sólo cuando lo cambia el usuario.
  useEffect(() => {
    if (!settingsTouched.current || !configLoaded || storageUnavailable) return
    const timer = window.setTimeout(() => {
      saveLabelPreference(settings)
        .then(() => setPreferenceError(""))
        .catch(() => setPreferenceError("No se pudo guardar el formato en tu cuenta; queda recordado en este navegador."))
    }, PREFERENCE_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [settings, configLoaded, storageUnavailable])

  // Patrones de barras de los códigos de la tanda que todavía no se tienen.
  const queueCodes = useMemo(() => [...new Set(queue.filter((item) => !item.issue).map((item) => item.code))].sort(), [queue])
  const missingCodes = useMemo(() => queueCodes.filter((code) => !patterns.has(code) && !patternErrors[code]), [queueCodes, patterns, patternErrors])
  const missingKey = missingCodes.join("\n")
  useEffect(() => {
    if (!missingKey) return
    const controller = new AbortController()
    fetchBarcodePatterns(missingKey.split("\n"), controller.signal)
      .then((result) => {
        setPatterns((current) => {
          const next = new Map(current)
          Object.entries(result.patterns).forEach(([code, pattern]) => next.set(code, pattern))
          return next
        })
        if (Object.keys(result.errors).length) setPatternErrors((current) => ({ ...current, ...result.errors }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const text = error instanceof Error ? error.message : "No se pudieron generar los códigos de barras."
        setMessage({ tone: "danger", text })
      })
    return () => controller.abort()
  }, [missingKey])

  const labels = useMemo(() => expandQueue(queue, settings.order), [queue, settings.order])
  const batch = useMemo(() => prepareBatch(labels, patterns, settings), [labels, patterns, settings])
  const { plan, drawings } = batch
  const pageCount = previewPageCount(plan)
  const currentPage = Math.min(page, pageCount - 1)
  const total = queueLabelCount(queue)
  const loadingPatterns = missingCodes.length > 0
  const blockedCodes = queueCodes.filter((code) => patternErrors[code])
  const warnings = useMemo(() => {
    const unique = new Set<string>()
    drawings.forEach((drawing) => drawing.warnings.forEach((warning) => unique.add(warning.message)))
    return [...unique]
  }, [drawings])
  const notices = layoutNotices(settings)
  const placements = useMemo(() => queuePlacements(labels, plan), [labels, plan])
  const zplReason = zplUnavailableReason(settings)
  const status: PrintStatus = !total
    ? { tone: "blocked", text: "Agregá productos a la tanda." }
    : plan.overLimit
      ? { tone: "blocked", text: `La tanda supera las ${MAX_BATCH_LABELS} etiquetas. Dividila en tandas más chicas.` }
      : plan.error
        ? { tone: "blocked", text: plan.error }
        : blockedCodes.length
          ? { tone: "blocked", text: `No se pudo generar el código ${blockedCodes.join(", ")}. Quitalo de la tanda.` }
          : loadingPatterns
            ? { tone: "loading", text: "Generando códigos de barras…" }
            : { tone: "ready", text: `Lista para imprimir: ${plural(plan.pages.length, plan.mode === "thermal" ? "fila" : "hoja", plan.mode === "thermal" ? "filas" : "hojas")}.` }

  const addTarget = useCallback((target: LabelTarget, code: string, copies: number) => {
    const item = createQueueItem(target, code, copies)
    if (!item) return null
    const max = labelSettingsStore.get().maxCopiesPerItem
    const outcome = addToQueue(labelQueueStore.get(), item, max)
    validatedKeys.current.add(item.key)
    labelQueueStore.set(outcome.queue)
    // El alta se ve en la propia fila; sólo se avisa lo que no se pudo hacer.
    if (outcome.rejected) setMessage({ tone: "danger", text: "La tanda llegó al máximo de artículos. Imprimí o vaciá antes de seguir." })
    else if (outcome.clamped) setMessage({ tone: "info", text: `Tope de ${max} etiquetas por artículo (se cambia en Formato → Ajustes avanzados).` })
    return outcome
  }, [])

  async function repeatBatch(entry: LabelBatchSummary) {
    try {
      const items = await loadLabelProducts(entry.items.map((item) => item.productId))
      mergeProducts(items)
      const max = labelSettingsStore.get().maxCopiesPerItem
      let next = labelQueueStore.get()
      let added = 0
      for (const batchItem of entry.items) {
        const target = findTarget(items, batchItem.productId, batchItem.variantId)
        const item = target && createQueueItem(target, batchItem.code, batchItem.copies)
        if (!item) continue
        added += 1
        validatedKeys.current.add(item.key)
        next = addToQueue(next, { ...item, labelName: batchItem.labelName }, max).queue
      }
      labelQueueStore.set(next)
      const skipped = entry.items.length - added
      setMessage({ tone: skipped ? "info" : "success", text: `Tanda "${entry.name}" agregada${skipped ? `; ${skipped} ${skipped === 1 ? "artículo ya no existe o cambió de código" : "artículos ya no existen o cambiaron de código"}` : ""}.` })
    } catch {
      setMessage({ tone: "danger", text: "No se pudo cargar la tanda." })
    }
  }

  function recordBatch(output: LabelBatchOutput) {
    if (storageUnavailable) return
    const items = toBatchItems(queue)
    saveLabelBatch(defaultBatchName(queue.filter((item) => !item.issue)), items, output)
      .then((saved) => { if (saved) setBatches((current) => [saved, ...current].slice(0, 20)) })
      .catch(() => setMessage({ tone: "info", text: "Las etiquetas salieron, pero no se pudo guardar la tanda en el historial." }))
  }

  async function runOutput(output: LabelBatchOutput) {
    if (busy || status.tone !== "ready") return
    setBusy(output)
    setMessage(null)
    try {
      if (output === "print") {
        await printHtmlDocument(buildPrintDocument(batch, settings))
      } else if (output === "pdf") {
        const { buildLabelsPdf } = await import("@/lib/labels/pdf")
        const bytes = await buildLabelsPdf(batch, settings)
        const buffer = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(buffer).set(bytes)
        downloadBlob(new Blob([buffer], { type: "application/pdf" }), `etiquetas-beyonix-${fileStamp()}.pdf`)
      } else {
        downloadBlob(new Blob([buildZpl(batch, settings)], { type: "text/plain;charset=utf-8" }), `etiquetas-beyonix-${fileStamp()}.zpl`)
      }
      recordBatch(output)
      setMessage({ tone: "success", text: output === "print" ? `Enviadas ${plan.totalLabels} etiquetas al diálogo de impresión.` : `Archivo ${output === "pdf" ? "PDF" : "ZPL"} generado con ${plan.totalLabels} etiquetas.` })
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "No se pudieron generar las etiquetas." })
    } finally {
      setBusy(null)
    }
  }

  async function savePreset(name: string, overwrite: boolean): Promise<"saved" | "exists"> {
    try {
      const preset = await saveLabelPreset(name, labelSettingsStore.get(), overwrite)
      setPresets((current) => [...current.filter((item) => item.id !== preset.id), preset].sort((left, right) => left.name.localeCompare(right.name, "es")))
      return "saved"
    } catch (error) {
      if (error instanceof LabelApiError && error.status === 409) return "exists"
      throw error
    }
  }

  async function removePreset(preset: LabelPreset) {
    await deleteLabelPreset(preset.id)
    setPresets((current) => current.filter((item) => item.id !== preset.id))
  }

  const zoomItem = zoomIndex != null ? labels[zoomIndex] ?? null : null
  const zoomDrawing = zoomIndex != null ? drawings[zoomIndex] ?? null : null

  return (
    <div className={cn(adminPageClassName, "admin-labels-page mx-auto w-full max-w-1400px")}>
      <AdminPageHeader eyebrow="Productos" title="Etiquetas" description="Armá la tanda, elegí el formato e imprimí." />

      <Stepper
        step={step}
        onStep={goTo}
        items={[
          { id: 1, title: "Productos", summary: total ? `${plural(total, "etiqueta", "etiquetas")} · ${plural(queue.length, "artículo", "artículos")}` : "Elegí qué imprimir", done: total > 0 },
          { id: 2, title: "Formato", summary: formatName(settings), done: formatReviewed },
          { id: 3, title: "Vista previa e impresión", summary: status.tone === "ready" ? "Lista para imprimir" : status.text, done: false },
        ]}
      />

      {message && (
        <AdminInfoBlock role={message.tone === "danger" ? "alert" : "status"} tone={message.tone}>
          {message.text}
        </AdminInfoBlock>
      )}

      {step === 1 && (
        <div className="grid items-start gap-5 *:min-w-0 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,1fr)]">
          <LabelSearchPanel queue={queue} maxCopies={settings.maxCopiesPerItem} onAdd={addTarget} update={updateQueue} onProducts={mergeProducts} />
          <LabelQueuePanel
            className="lg:sticky lg:top-4"
            queue={queue}
            products={products}
            maxCopies={settings.maxCopiesPerItem}
            order={settings.order}
            patternErrors={patternErrors}
            placements={placements}
            batches={batches}
            historyAvailable={configLoaded && !storageUnavailable}
            onRepeat={(entry) => void repeatBatch(entry)}
            onContinue={() => goTo(2)}
            update={updateQueue}
          />
        </div>
      )}

      {step === 2 && (
        <div className="grid items-start gap-5 *:min-w-0 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,1fr)]">
          <LabelSettingsPanel
            settings={settings}
            onChange={updateSettings}
            presets={presets}
            storageUnavailable={storageUnavailable}
            preferenceError={preferenceError}
            onSavePreset={savePreset}
            onDeletePreset={removePreset}
          />
          <LabelFormatSample settings={settings} drawing={drawings[0]} onBack={() => goTo(1)} onContinue={() => goTo(3)} />
        </div>
      )}

      {step === 3 && (
        <LabelPrintStep
          plan={plan}
          drawings={drawings}
          labels={labels}
          settings={settings}
          page={currentPage}
          onPage={setPage}
          onZoom={setZoomIndex}
          status={status}
          warnings={warnings}
          notices={notices}
          busy={busy}
          zplReason={zplReason}
          onOutput={(output) => void runOutput(output)}
        />
      )}

      <LabelZoomModal key={zoomIndex ?? "none"} item={zoomItem} drawing={zoomDrawing} settings={settings} onClose={() => setZoomIndex(null)} />
    </div>
  )
}
