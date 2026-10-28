"use client"

import { useMemo, useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, Copy, FileSpreadsheet, Info, XCircle } from "lucide-react"

import { getOrCreateIdempotencyAttempt, type IdempotencyAttempt } from "@/lib/business/idempotency-attempt"
import { cn } from "@/lib/utils"
import {
  EXTERNAL_SALE_IMPORT_MAX_ROWS,
  classifyExternalSalePreview,
  externalSaleCode,
  parseExternalSalesSheet,
  parseTabularText,
  type ExternalSaleImportRowPayload,
  type ExternalSalePreviewRow,
  type ExternalSalePreviewServerRow,
  type ExternalSaleStockEffect,
  type ParsedExternalSalesSheet,
} from "@/lib/business/external-sales"
import { importExternalSales, previewExternalSalesImport } from "@/lib/supabase/queries/external-sales"
import { formatPrice } from "../productos/helpers"
import {
  AdminInfoBlock,
  AdminModal,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminTextarea,
} from "../../components/admin-controls"

const MAX_REQUEST_BYTES = 3_500_000

type PreviewState = ExternalSalePreviewRow["state"]

const STATE_LABELS: Record<PreviewState, {
  label: string
  /** Singular y plural para el resumen: "1 advertencia", "3 advertencias". */
  count: [string, string]
  className: string
  /** Fila sin pintar entera: tono apenas perceptible y borde izquierdo (`edgeClassName`). */
  rowClassName: string
  edgeClassName: string
  icon: typeof CheckCircle2
}> = {
  valid: { label: "Válida", count: ["válida", "válidas"], className: "text-emerald-300", rowClassName: "", edgeClassName: "border-l-transparent", icon: CheckCircle2 },
  warning: { label: "Advertencia", count: ["advertencia", "advertencias"], className: "text-amber-200", rowClassName: "bg-amber-300/3", edgeClassName: "border-l-amber-300/60", icon: AlertTriangle },
  duplicate: { label: "Duplicada", count: ["duplicada", "duplicadas"], className: "text-sky-200", rowClassName: "bg-sky-300/3", edgeClassName: "border-l-sky-300/60", icon: Copy },
  error: { label: "Error", count: ["error", "errores"], className: "text-red-300", rowClassName: "bg-red-400/5", edgeClassName: "border-l-red-400/70", icon: XCircle },
}

const MODE_OPTIONS: Array<{ value: ExternalSaleStockEffect; title: string; hint: string }> = [
  { value: "none", title: "Históricas", hint: "Ya ocurrieron y no modifican stock." },
  { value: "consume", title: "Nuevas", hint: "Descuentan stock al confirmar." },
]

// Columnas cortas con ancho fijo; Cliente y Validación crecen con el modal y Producto toma el resto.
const COLUMNS: Array<{ label: string; className: string }> = [
  { label: "Fila", className: "w-10" },
  { label: "Estado", className: "w-26" },
  { label: "Fecha", className: "w-21" },
  { label: "Cliente", className: "w-[15%]" },
  { label: "SKU", className: "w-24" },
  { label: "Producto", className: "" },
  { label: "Cant.", className: "w-12 text-center" },
  { label: "Precio final", className: "w-26 text-right" },
  { label: "Validación", className: "w-[21%]" },
]

function formatDate(value: string) {
  return value.split("-").reverse().join("/")
}

function plural(count: number, [one, many]: [string, string]) {
  return count === 1 ? one : many
}

/** Frase corta del problema y, si aporta, el detalle completo desplegable (mouse, teclado y touch). */
function RowValidation({ row }: { row: ExternalSalePreviewRow }) {
  if (!row.summary) return null
  const { className, icon: Icon } = STATE_LABELS[row.state === "duplicate" ? "warning" : row.state]
  const hasDetail = row.messages.length > 1 || row.messages[0]?.replace(/\.$/, "") !== row.summary
  const headline = (
    <>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", className)} />
      <span className="line-clamp-2 font-semibold text-white/82">{row.summary}</span>
    </>
  )
  if (!hasDetail) return <p className="flex items-start gap-1.5">{headline}</p>
  return (
    <details className="group">
      <summary
        title={row.messages.join(" ")}
        className="flex cursor-pointer list-none items-start gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-beyonix-sky/50 [&::-webkit-details-marker]:hidden"
      >
        {headline}
        <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-white/40 group-open:text-white/75" />
        <span className="sr-only">Ver detalle</span>
      </summary>
      <ul className="mt-1.5 space-y-1 border-l border-white/12 pl-2 text-11px leading-4 text-white/62">
        {row.messages.map((message) => <li key={message}>{message}</li>)}
      </ul>
    </details>
  )
}

/**
 * Resultado del preview atado a la versión de la entrada que lo produjo.
 * Cualquier cambio de texto o archivo sube la versión y descarta el preview,
 * así que nunca se confirma una tanda distinta de la que se está viendo.
 */
interface PreviewSnapshot {
  inputVersion: number
  sheet: ParsedExternalSalesSheet
  serverRows: ExternalSalePreviewServerRow[] | null
  previousBatch: { id: string; created_at: string } | null
}

/**
 * Pegar filas de Excel o importar un archivo. Nada se escribe hasta confirmar:
 * el preview sólo lee la base (SKU, stock disponible y posibles duplicados).
 */
export function ExternalSalesImportModal({
  source,
  onClose,
  onImported,
}: {
  source: "paste" | "file"
  onClose: () => void
  onImported: (message: string, batchId: string) => void
}) {
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [inputVersion, setInputVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null)
  const [pendingVersion, setPendingVersion] = useState<number | null>(null)
  const [mode, setMode] = useState<ExternalSaleStockEffect | null>(null)
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState("")
  const versionRef = useRef(0)
  const requestRef = useRef(0)
  const importingRef = useRef(false)
  const attempt = useRef<IdempotencyAttempt | null>(null)

  // Sólo el preview de la entrada actual cuenta; uno viejo no se muestra ni se confirma.
  const current = snapshot?.inputVersion === inputVersion ? snapshot : null
  const sheet = current?.sheet ?? null
  const serverRows = current?.serverRows ?? null
  const previousBatch = current?.previousBatch ?? null
  const loading = pendingVersion === inputVersion

  const preview = useMemo(
    () => (sheet ? classifyExternalSalePreview(sheet.rows, serverRows, mode) : []),
    [sheet, serverRows, mode],
  )
  const importable = preview.filter((row) =>
    row.parsed.payload && (row.state === "valid" || row.state === "warning"
      || (row.state === "duplicate" && confirmed.has(row.parsed.sourceRowNumber))))
  const counts = preview.reduce(
    (acc, row) => ({ ...acc, [row.state]: acc[row.state] + 1 }),
    { valid: 0, warning: 0, duplicate: 0, error: 0 },
  )
  // Errores y duplicadas sin confirmar no se envían.
  const leftOut = preview.length - importable.length

  /** Invalida en el acto preview, confirmaciones y clave de la tanda anterior. */
  const startInput = () => {
    versionRef.current += 1
    setInputVersion(versionRef.current)
    setSnapshot(null)
    setConfirmed(new Set())
    setError("")
    attempt.current = null
    return versionRef.current
  }

  const changeMode = (next: ExternalSaleStockEffect) => {
    if (importingRef.current) return
    setMode(next)
    setConfirmed(new Set())
    attempt.current = null
  }

  const analyze = async (matrix: string[][], version: number) => {
    if (version !== versionRef.current) return
    setError("")
    setConfirmed(new Set())
    attempt.current = null
    const parsed = parseExternalSalesSheet(matrix)
    setSnapshot({ inputVersion: version, sheet: parsed, serverRows: null, previousBatch: null })
    if (parsed.error) return
    const payloads = parsed.rows.flatMap((row) => (row.payload ? [row.payload] : []))
    if (payloads.length > EXTERNAL_SALE_IMPORT_MAX_ROWS) {
      setError(`Cada tanda puede tener hasta ${EXTERNAL_SALE_IMPORT_MAX_ROWS} ventas. Dividí las filas en varias tandas.`)
      return
    }
    if (!payloads.length) return
    const request = ++requestRef.current
    // Una respuesta que llega tarde (otra entrada u otro preview posterior) se ignora.
    const isLatest = () => request === requestRef.current && version === versionRef.current
    setPendingVersion(version)
    try {
      const result = await previewExternalSalesImport(payloads)
      if (!isLatest()) return
      setSnapshot({ inputVersion: version, sheet: parsed, serverRows: result.rows, previousBatch: result.previous_batch })
    } catch (previewError) {
      if (!isLatest()) return
      setError(previewError instanceof Error ? previewError.message : "No se pudo verificar las filas contra el catálogo.")
    } finally {
      if (isLatest()) setPendingVersion(null)
    }
  }

  const changeText = (value: string) => {
    if (importingRef.current) return
    setText(value)
    startInput()
  }

  const readFile = async (file: File) => {
    if (importingRef.current) return
    const version = startInput()
    setFileName(file.name)
    try {
      const { readExternalSalesFile } = await import("@/lib/business/external-sales-file")
      const matrix = readExternalSalesFile(await file.arrayBuffer(), file.name)
      await analyze(matrix, version)
    } catch (fileError) {
      if (version !== versionRef.current) return
      setError(fileError instanceof Error ? fileError.message : "No se pudo leer el archivo.")
    }
  }

  const ready = Boolean(sheet && !sheet.error && serverRows)
  // Confirmar exige un preview vigente y verificado de exactamente esta
  // entrada (sin verificación en curso) y el modo elegido. Las filas con
  // error o duplicadas sin confirmar no se envían.
  const canConfirm = ready && !loading && !importing && mode !== null && importable.length > 0

  const confirm = async () => {
    if (importingRef.current || !canConfirm || !mode || !sheet || current?.inputVersion !== versionRef.current) return
    const rows: ExternalSaleImportRowPayload[] = importable.map((row) => ({
      ...(row.parsed.payload as ExternalSaleImportRowPayload),
      ...(row.state === "duplicate" ? { confirm_duplicate: true } : {}),
    }))
    const input = {
      source,
      fileName: source === "file" ? fileName : null,
      stockMode: mode,
      rowsRead: sheet.rows.length,
      rows,
    }
    if (JSON.stringify(input).length > MAX_REQUEST_BYTES) {
      setError("La tanda es demasiado grande para enviarla de una vez. Dividila en dos.")
      return
    }
    importingRef.current = true
    setImporting(true)
    setError("")
    try {
      attempt.current = getOrCreateIdempotencyAttempt(attempt.current, input, "external-sale-import")
      const result = await importExternalSales(input, attempt.current.key)
      onImported(
        mode === "none"
          ? `${result.imported} ventas históricas importadas. El stock no se modificó.`
          : `${result.imported} ventas nuevas importadas. El stock se descontó.`,
        result.batch_id,
      )
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "No se pudo importar la tanda.")
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }

  return (
    <AdminModal
      open
      extraWide
      eyebrow="Ventas externas"
      title={source === "paste" ? "Pegar ventas" : "Importar archivo"}
      description="Nada se guarda hasta que confirmes. Revisá el preview y elegí si las ventas son Históricas o Nuevas."
      onClose={() => { if (!importingRef.current) onClose() }}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-white/8 pt-4">
          {ready && (
            <p className="mr-auto text-xs leading-5" aria-live="polite">
              <span className="font-bold text-white/85">{importable.length} de {preview.length} {preview.length === 1 ? "fila lista" : "filas listas"}</span>
              {leftOut > 0 && (
                <span className="text-white/50"> · {leftOut} {plural(leftOut, ["fila quedará afuera", "filas quedarán afuera"])}</span>
              )}
              {mode === null && <span className="block text-amber-200/85">Elegí si son Históricas o Nuevas para importar.</span>}
            </p>
          )}
          <AdminSecondaryButton disabled={importing} onClick={onClose}>Cancelar</AdminSecondaryButton>
          {ready && (
            <AdminPrimaryButton disabled={!canConfirm} onClick={() => void confirm()}>
              {importing ? "Importando…" : `Importar ${importable.length} ${importable.length === 1 ? "venta" : "ventas"}`}
            </AdminPrimaryButton>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {source === "paste" ? (
          // Desktop: textarea ancho y, al costado, la acción y la nota de envío.
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-4">
            <AdminTextarea
              title="Filas copiadas desde Excel"
              placeholder="Copiá las filas en Excel (incluida la fila de títulos) y pegalas acá."
              value={text}
              disabled={importing}
              onChange={changeText}
              wrap="off"
              className="custom-scrollbar h-30 min-h-0 overflow-auto font-mono text-xs leading-5"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 lg:flex-col lg:flex-nowrap lg:items-stretch lg:justify-start">
              <p className="text-xs text-white/50">
                Envío: sólo el costo logístico que pagó BEYONIX. Si el cliente pagó su envío, va $0 o vacío.
              </p>
              <AdminSecondaryButton
                disabled={!text.trim() || loading || importing}
                onClick={() => void analyze(parseTabularText(text), versionRef.current)}
                className="lg:order-first"
              >
                {loading ? "Verificando…" : "Previsualizar"}
              </AdminSecondaryButton>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-beyonix-sky/30 bg-black/20 p-4 text-sm text-white/72">
              <FileSpreadsheet className="size-5 text-beyonix-sky" />
              <span>{fileName ?? "Elegí un archivo .xlsx, .xls o .csv (se lee la primera hoja)."}</span>
              <input
                type="file"
                className="sr-only"
                aria-label="Archivo de ventas externas"
                disabled={importing}
                accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void readFile(file)
                  event.target.value = ""
                }}
              />
            </label>
            <p className="text-xs text-white/50">
              Envío: sólo el costo logístico que pagó BEYONIX. Si el cliente pagó su envío, va $0 o vacío.
            </p>
          </div>
        )}

        {sheet?.error && <AdminInfoBlock tone="danger">{sheet.error}</AdminInfoBlock>}
        {error && <p role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</p>}
        {previousBatch && (
          <AdminInfoBlock tone="warning">
            Estas mismas filas ya se importaron el {new Date(previousBatch.created_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}. Revisá el historial antes de importarlas otra vez.
          </AdminInfoBlock>
        )}

        {ready && (
          <>
            {/* Desktop: modo a la izquierda y resumen a la derecha, en una sola franja. */}
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
              <fieldset className="grid gap-2 sm:grid-cols-2 lg:w-[36rem] lg:shrink-0" disabled={importing}>
                <legend className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">¿Qué ventas son?</legend>
                {MODE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="group flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 transition-colors hover:border-white/22 has-checked:border-beyonix-sky/70 has-checked:bg-beyonix-sky/10 has-focus-visible:ring-2 has-focus-visible:ring-beyonix-sky/40"
                  >
                    <input
                      type="radio"
                      name="external-sales-import-mode"
                      checked={mode === option.value}
                      onChange={() => changeMode(option.value)}
                      className="size-4 shrink-0 accent-beyonix-sky"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-black text-white/80 group-has-checked:text-white">{option.title}</span>
                      <span className="block text-xs text-white/52">{option.hint}</span>
                    </span>
                    <CheckCircle2 aria-hidden="true" className="ml-auto hidden size-4 shrink-0 text-beyonix-sky group-has-checked:block" />
                  </label>
                ))}
              </fieldset>

              <ul aria-label="Resumen de validación" className="flex flex-wrap gap-2 text-xs lg:justify-end lg:pb-1">
                {(Object.keys(STATE_LABELS) as PreviewState[]).map((state) => {
                  const { count, className, icon: Icon } = STATE_LABELS[state]
                  return (
                    <li
                      key={state}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-black/25 px-2.5 py-1",
                        counts[state] ? "text-white/82" : "text-white/40",
                      )}
                    >
                      <Icon aria-hidden="true" className={cn("size-3.5", counts[state] ? className : "text-white/30")} />
                      <span><b className="font-black tabular-nums">{counts[state]}</b> {plural(counts[state], count)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>

            {/* Alto atado al viewport y con tope: en desktop el modal entra entero y sólo scrollea la tabla. */}
            <div className="sales-ledger-scrollbar max-h-[clamp(12rem,calc(100dvh-32rem),26rem)] overflow-auto rounded-xl border border-white/8">
              <table className="w-full min-w-[920px] table-fixed text-left text-xs">
                <thead className="text-10px font-black uppercase tracking-wider text-white/45">
                  <tr>
                    {COLUMNS.map((column) => (
                      <th
                        key={column.label}
                        scope="col"
                        // El tema admin fuerza en th un color semitransparente: una capa de imagen opaca evita que las filas se vean debajo al scrollear.
                        className={cn("sticky top-0 z-10 bg-[linear-gradient(var(--admin-surface-raised),var(--admin-surface-raised))] px-2 py-2 leading-tight shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)]", column.className)}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => {
                    const { label, className, rowClassName, edgeClassName, icon: Icon } = STATE_LABELS[row.state]
                    const payload = row.parsed.payload
                    const values = row.parsed.sourceValues
                    const customer = payload?.customer_name ?? values.Cliente ?? null
                    const sku = payload?.sku ?? values.SKU ?? null
                    const product = payload?.product_name ?? row.catalogName ?? values.Producto ?? null
                    return (
                      <tr key={row.parsed.sourceRowNumber} className={cn("border-t border-white/6 align-top text-white/72", rowClassName)}>
                        <td className={cn("border-l-2 px-2 py-2 tabular-nums text-white/45", edgeClassName)}>{row.parsed.sourceRowNumber}</td>
                        <td className={cn("px-2 py-2 font-bold", className)}>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap">
                            <Icon aria-hidden="true" className="size-3.5 shrink-0" />{label}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">{payload ? formatDate(payload.sale_date) : values.Fecha || "—"}</td>
                        <td className="px-2 py-2">
                          <span className="line-clamp-2 break-words" title={customer ?? undefined}>{customer || "—"}</span>
                        </td>
                        <td className="px-2 py-2">
                          <span className="block truncate font-mono" title={sku ?? undefined}>{sku || "—"}</span>
                        </td>
                        <td className="px-2 py-2">
                          <span className="line-clamp-2 break-words" title={product ?? undefined}>{product || "—"}</span>
                          {row.catalogName && payload?.product_name && row.catalogName !== payload.product_name && (
                            <span className="block truncate text-10px text-white/40" title={row.catalogName}>Catálogo: {row.catalogName}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center tabular-nums">{payload?.quantity ?? "—"}</td>
                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{payload ? formatPrice(payload.gross_amount) : "—"}</td>
                        <td className="px-2 py-2">
                          <RowValidation row={row} />
                          {row.duplicateOf && (
                            <div className={cn("space-y-1", row.summary && "mt-1.5")}>
                              <p className="flex items-start gap-1.5 font-semibold text-sky-100">
                                <Copy aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-sky-200" />
                                Posible duplicada
                              </p>
                              <p className="truncate text-11px text-white/45">
                                {row.duplicateOf.inPaste ? "Repetida en estas filas" : ""}
                                {row.duplicateOf.inPaste && row.duplicateOf.saleNumbers.length ? " · " : ""}
                                {row.duplicateOf.saleNumbers.slice(0, 3).map(externalSaleCode).join(", ")}
                              </p>
                              <label className="flex items-center gap-2 text-sky-100">
                                <input
                                  type="checkbox"
                                  disabled={importing}
                                  checked={confirmed.has(row.parsed.sourceRowNumber)}
                                  onChange={(event) => setConfirmed((selected) => {
                                    const next = new Set(selected)
                                    if (event.target.checked) next.add(row.parsed.sourceRowNumber)
                                    else next.delete(row.parsed.sourceRowNumber)
                                    return next
                                  })}
                                />
                                Es una venta distinta
                              </label>
                            </div>
                          )}
                          {!row.summary && !row.duplicateOf && (
                            <span className="inline-flex items-center gap-1 text-white/35">
                              <CheckCircle2 aria-hidden="true" className="size-3.5" />OK
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AdminModal>
  )
}
