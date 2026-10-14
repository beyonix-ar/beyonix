"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  History,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
} from "lucide-react"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import {
  MercadoLibreReportError,
  parseMercadoLibreSalesReport,
  type MercadoLibreImportRow,
  type ParsedMercadoLibreReport,
} from "@/lib/mercadolibre/sales-report"
import type { MercadoLibrePreviewStatus } from "@/lib/mercadolibre/import-validation"
import {
  MercadoLibreImportInterruptedError,
  getMercadoLibreImportBatches,
  hashMercadoLibreFile,
  importMercadoLibreReport,
  previewMercadoLibreImport,
  revertMercadoLibreImportBatch,
  type MercadoLibreImportBatch,
  type MercadoLibreImportPreview,
  type MercadoLibreImportResult,
} from "@/lib/supabase/queries/mercadolibre-sales"
import { AdminDangerButton, AdminModal, AdminSecondaryButton } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

type Step = "select" | "analyzing" | "review" | "importing" | "done"

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "select", label: "Seleccionar archivo" },
  { id: "analyzing", label: "Analizar" },
  { id: "review", label: "Revisar resumen" },
  { id: "importing", label: "Importar" },
  { id: "done", label: "Resultado" },
]

const FILE_KIND_LABEL = { xlsx: "Excel (.xlsx)", xls: "Excel 97-2003 (.xls)", csv: "CSV" } as const

const STATUS_LABEL: Record<MercadoLibrePreviewStatus, string> = {
  new: "Nueva",
  changed: "Se actualiza",
  unchanged: "Ya cargada",
  stale: "Más vieja",
}

const STATUS_CLASS: Record<MercadoLibrePreviewStatus, string> = {
  new: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  changed: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  unchanged: "border-white/10 bg-white/5 text-white/55",
  stale: "border-amber-300/25 bg-amber-300/10 text-amber-100",
}

function plural(count: number, singular: string, pluralForm: string) {
  return `${count.toLocaleString("es-AR")} ${count === 1 ? singular : pluralForm}`
}

function formatDateTime(value: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

function waitForPaint() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function Stat({
  label,
  value,
  detail,
  help,
  tone = "neutral",
}: {
  label: string
  value: string
  detail?: string
  help?: string
  tone?: "neutral" | "positive" | "warning" | "danger"
}) {
  const toneClass = {
    neutral: "text-white",
    positive: "text-emerald-300",
    warning: "text-amber-200",
    danger: "text-red-300",
  }[tone]
  return (
    <div className="min-w-0 rounded-xl border border-beyonix-blue-light/14 bg-black/25 px-3 py-2.5">
      <p className="flex items-center gap-1 text-9px font-black uppercase tracking-widest text-white/45">
        <span className="min-w-0 leading-tight">{label}</span>
        {help && <AdminHelpTip label={label} text={help} />}
      </p>
      <p className={`mt-1 text-base font-black tabular-nums ${toneClass}`}>{value}</p>
      {detail && <p className="mt-0.5 text-10px font-semibold leading-4 text-white/40">{detail}</p>}
    </div>
  )
}

function StepIndicator({ step }: { step: Step }) {
  const current = STEPS.findIndex((item) => item.id === step)
  return (
    <ol className="mt-3 grid grid-cols-5 gap-1.5" aria-label="Pasos de la importación">
      {STEPS.map((item, index) => {
        const state = index < current ? "done" : index === current ? "current" : "pending"
        return (
          <li
            key={item.id}
            aria-current={state === "current" ? "step" : undefined}
            className={`min-w-0 rounded-lg border px-2 py-1.5 text-center text-10px font-black leading-tight ${
              state === "current"
                ? "border-beyonix-sky/50 bg-beyonix-blue/35 text-white"
                : state === "done"
                  ? "border-emerald-400/25 bg-emerald-400/8 text-emerald-200"
                  : "border-white/8 bg-black/20 text-white/35"
            }`}
          >
            <span className="block tabular-nums">{index + 1}</span>
            <span className="hidden sm:block">{item.label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function MercadoLibreImportPanel({
  disabled = false,
  onBusyChange,
  onImported,
  historyRefreshKey = 0,
}: {
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onImported: () => Promise<void> | void
  historyRefreshKey?: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>("select")
  const [fileName, setFileName] = useState("")
  const [fileSha256, setFileSha256] = useState("")
  const [report, setReport] = useState<ParsedMercadoLibreReport | null>(null)
  const [preview, setPreview] = useState<MercadoLibreImportPreview | null>(null)
  const [analysisError, setAnalysisError] = useState("")
  const [importError, setImportError] = useState<{ message: string; partial?: MercadoLibreImportInterruptedError } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<MercadoLibreImportResult | null>(null)
  const [historyKey, setHistoryKey] = useState(0)

  const busy = step === "analyzing" || step === "importing"
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  const reset = () => {
    setStep("select")
    setFileName("")
    setFileSha256("")
    setReport(null)
    setPreview(null)
    setAnalysisError("")
    setImportError(null)
    setProgress(null)
    setResult(null)
  }

  const analyze = async (file: File) => {
    reset()
    setFileName(file.name)
    setStep("analyzing")
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
        throw new MercadoLibreReportError("Formato no admitido. Cargá el Excel (.xlsx o .xls) o un CSV del reporte de ventas de Mercado Libre.")
      }
      const buffer = await file.arrayBuffer()
      await waitForPaint()
      const parsed = parseMercadoLibreSalesReport(buffer, file.name)
      const sha = await hashMercadoLibreFile(buffer)
      setReport(parsed)
      setFileSha256(sha)
      const comparison = parsed.rows.length
        ? await previewMercadoLibreImport(parsed.rows, sha, (done, total) => setProgress({ done, total }))
        : { statuses: [], previousImport: null }
      setPreview(comparison)
      setProgress(null)
      setStep("review")
    } catch (error) {
      setAnalysisError(
        error instanceof Error && error.message
          ? error.message
          : "No se pudo leer el archivo. Descargalo de nuevo desde Mercado Libre.",
      )
      setProgress(null)
      setStep("select")
    } finally {
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  const counts = useMemo(() => {
    const result = { new: 0, changed: 0, unchanged: 0, stale: 0 }
    for (const status of preview?.statuses ?? []) result[status] += 1
    return result
  }, [preview])

  const rowsToWrite = useMemo<MercadoLibreImportRow[]>(() => {
    if (!report || !preview) return []
    return report.rows.filter((_, index) => {
      const status = preview.statuses[index]
      return status === "new" || status === "changed"
    })
  }, [preview, report])

  const runImport = async () => {
    if (!report || !preview || !rowsToWrite.length || busy) return
    setStep("importing")
    setImportError(null)
    setProgress({ done: 0, total: 1 })
    try {
      const imported = await importMercadoLibreReport({
        report: { ...report, rows: rowsToWrite },
        fileName,
        fileSha256,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setResult({ ...imported, unchanged: imported.unchanged + counts.unchanged + counts.stale })
      setStep("done")
    } catch (error) {
      setImportError({
        message: error instanceof Error ? error.message : "No se pudo completar la importación.",
        partial: error instanceof MercadoLibreImportInterruptedError ? error : undefined,
      })
      setStep("review")
    } finally {
      setProgress(null)
      setHistoryKey((current) => current + 1)
      await onImported()
    }
  }

  const visibleRows = report?.rows.slice(0, 25) ?? []

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[#071018] p-3.5" aria-labelledby="ml-import-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">Importar ventas</p>
            <h3 id="ml-import-title" className="mt-1 flex items-center gap-1.5 text-lg font-black text-white">
              Reporte de Mercado Libre
              <AdminHelpTip
                label="Qué archivo cargar"
                text="En Mercado Libre: Ventas → Exportar → Excel de ventas. Se acepta .xlsx, .xls o CSV. Se puede cargar el mismo archivo o períodos superpuestos: las ventas ya cargadas no se duplican."
              />
            </h3>
            <p className="mt-1 text-xs leading-5 text-white/50">
              Primero se analiza el archivo sin guardar nada. Después revisás el resumen y confirmás.
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            className="hidden"
            aria-label="Archivo de ventas de Mercado Libre"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void analyze(file)
            }}
          />
          {(step === "select" || step === "done") && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
              className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/32 bg-beyonix-blue/35 px-5 text-sm font-black text-white transition hover:border-beyonix-sky/65 hover:bg-beyonix-blue/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileSpreadsheet className="size-4 text-beyonix-sky" />
              {step === "done" ? "Cargar otro archivo" : "Seleccionar archivo"}
            </button>
          )}
        </div>

        <StepIndicator step={step} />

        {analysisError && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2.5 text-sm text-red-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-black">No se pudo analizar {fileName ? `“${fileName}”` : "el archivo"}</p>
              <p className="mt-0.5 text-xs leading-5 text-red-100/85">{analysisError}</p>
            </div>
          </div>
        )}

        {step === "analyzing" && (
          <p role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 text-sm font-bold text-white/70">
            <RefreshCw className="size-4 animate-spin text-beyonix-sky" />
            Analizando “{fileName}”
            {progress ? ` · comparando con lo ya cargado (${progress.done}/${progress.total})` : "…"}
          </p>
        )}

        {report && preview && (step === "review" || step === "importing") && (
          <div className="mt-3 space-y-3">
            <div className="flex flex-col gap-1 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 text-xs text-white/60 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0">
                <span className="font-black text-white">{fileName}</span>
                {" · "}
                {FILE_KIND_LABEL[report.fileKind]} · hoja “{report.sheetName}” · encabezados en la fila {report.headerRowNumber}
              </p>
              <p className="shrink-0 text-white/45">{report.columns.length} columnas reconocidas</p>
            </div>

            {preview.previousImport && (
              <p className="flex items-start gap-2 rounded-xl border border-sky-400/22 bg-sky-400/8 px-3 py-2 text-xs leading-5 text-sky-100">
                <History className="mt-0.5 size-3.5 shrink-0" />
                Este mismo archivo ya se importó el {formatDateTime(preview.previousImport.created_at)}; volver a importarlo no duplica ventas, sólo aplica cambios.
              </p>
            )}

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Filas leídas" value={report.rowsRead.toLocaleString("es-AR")} detail={report.emptyRows ? `${plural(report.emptyRows, "fila vacía ignorada", "filas vacías ignoradas")}` : "Sin filas vacías"} />
              <Stat
                label="Ventas únicas"
                value={report.totals.operations.toLocaleString("es-AR")}
                detail={plural(report.totals.lines, "línea de producto", "líneas de producto")}
                help="Operaciones distintas del archivo. Una venta con varios productos ocupa varias líneas pero cuenta como una sola operación."
              />
              <Stat label="Nuevas" value={counts.new.toLocaleString("es-AR")} detail="Se agregan" tone={counts.new ? "positive" : "neutral"} />
              <Stat
                label="Ya cargadas"
                value={(counts.unchanged + counts.changed + counts.stale).toLocaleString("es-AR")}
                detail={`${counts.unchanged} sin cambios · ${counts.changed} se actualizan${counts.stale ? ` · ${counts.stale} más viejas` : ""}`}
                help="Ventas que ya están en BEYONIX. Si el archivo trae un estado más reciente (por ejemplo, una devolución) se actualizan; si trae un estado más viejo que el guardado, se ignoran."
              />
              <Stat
                label="Duplicadas en el archivo"
                value={report.duplicateRows.length.toLocaleString("es-AR")}
                detail="Filas idénticas: se importan una sola vez"
                tone={report.duplicateRows.length ? "warning" : "neutral"}
              />
              <Stat
                label="Filas inválidas"
                value={report.invalidRows.length.toLocaleString("es-AR")}
                detail={report.invalidRows.length ? "No se importan" : "Todo el archivo es válido"}
                tone={report.invalidRows.length ? "danger" : "positive"}
              />
              <Stat label="Total bruto" value={formatPrice(report.totals.gross)} detail="Ingresos por productos" help="Suma de ‘Ingresos por productos’ de las líneas válidas, antes de cargos, envíos y reembolsos." />
              <Stat
                label="Total neto"
                value={formatPrice(report.totals.net)}
                detail={`Cargos ${formatPrice(report.totals.charges)} · envíos ${formatPrice(report.totals.shipping)}`}
                help="Columna ‘Total’ que liquida Mercado Libre: bruto menos cargos por venta, impuestos, costos de envío y reembolsos."
                tone={report.totals.net >= 0 ? "positive" : "danger"}
              />
            </div>

            {report.warnings.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-amber-300/20 bg-amber-300/7 px-3 py-2 text-xs leading-5 text-amber-100">
                {report.warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    {warning}
                  </li>
                ))}
              </ul>
            )}

            {report.invalidRows.length > 0 && (
              <details className="rounded-xl border border-red-400/22 bg-red-400/6" open={report.invalidRows.length <= 10}>
                <summary className="cursor-pointer px-3 py-2 text-xs font-black text-red-100">
                  {plural(report.invalidRows.length, "fila con problemas", "filas con problemas")} (no se importan)
                </summary>
                <ul className="max-h-64 space-y-1 overflow-y-auto px-3 pb-3 text-xs leading-5 text-red-100/90">
                  {report.invalidRows.slice(0, 200).map((row) => (
                    <li key={row.rowNumber}>
                      <span className="font-black">Fila {row.rowNumber}</span>
                      {row.saleNumber ? ` (venta ${row.saleNumber})` : ""}: {row.messages.join("; ")}.
                    </li>
                  ))}
                  {report.invalidRows.length > 200 && <li>… y {report.invalidRows.length - 200} filas más.</li>}
                </ul>
              </details>
            )}

            {report.missingOptionalColumns.length > 0 && (
              <details className="rounded-xl border border-white/8 bg-black/20">
                <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-white/55">
                  {plural(report.missingOptionalColumns.length, "columna opcional no encontrada", "columnas opcionales no encontradas")} (quedan vacías)
                </summary>
                <p className="px-3 pb-3 text-xs leading-5 text-white/45">{report.missingOptionalColumns.join(" · ")}</p>
              </details>
            )}

            {visibleRows.length > 0 && (
              <div className="sales-ledger-scrollbar overflow-x-auto rounded-xl border border-white/8">
                <table className="w-full min-w-[960px] text-center text-xs">
                  <caption className="sr-only">Primeras líneas del archivo</caption>
                  <thead className="bg-beyonix-blue/18 text-9px font-black uppercase tracking-widest text-white/42">
                    <tr>
                      {["Fila", "Venta", "Fecha", "Estado ML", "Producto", "Unid.", "Bruto", "Total ML", "En BEYONIX"].map((label) => (
                        <th key={label} scope="col" className="px-2.5 py-2.5">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row, index) => {
                      const status = preview.statuses[index] ?? "new"
                      return (
                        <tr key={`${row.operation_id}-${row.raw_data.source.row_number}`} className="border-t border-white/6 text-white/65">
                          <td className="px-2.5 py-2 tabular-nums text-white/40">{row.raw_data.source.row_number}</td>
                          <td className="px-2.5 py-2 font-bold text-white">{row.operation_id}</td>
                          <td className="px-2.5 py-2 tabular-nums">{formatDateTime(row.sale_date)}</td>
                          <td className="max-w-48 px-2.5 py-2"><span className="block truncate" title={String(row.raw_data.parsed.status ?? "")}>{row.raw_data.parsed.status}</span></td>
                          <td className="max-w-64 px-2.5 py-2"><span className="block truncate" title={row.product_name}>{row.product_name}</span></td>
                          <td className="px-2.5 py-2 tabular-nums">{row.raw_data.parsed.units}</td>
                          <td className="px-2.5 py-2 tabular-nums">{formatPrice(row.gross_amount)}</td>
                          <td className="px-2.5 py-2 font-black tabular-nums">{formatPrice(row.net_amount)}</td>
                          <td className="px-2.5 py-2">
                            <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-10px font-black ${STATUS_CLASS[status]}`}>
                              {STATUS_LABEL[status]}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {report.rows.length > visibleRows.length && (
                  <p className="border-t border-white/6 px-3 py-2 text-center text-11px text-white/40">
                    Se muestran {visibleRows.length} de {report.rows.length.toLocaleString("es-AR")} líneas válidas.
                  </p>
                )}
              </div>
            )}

            {importError && (
              <div role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2.5 text-xs leading-5 text-red-100">
                <p className="font-black">La importación se detuvo</p>
                <p className="mt-0.5">{importError.message}</p>
                {importError.partial && importError.partial.completedChunks > 0 && (
                  <p className="mt-1 text-red-100/80">
                    Se guardaron {importError.partial.completedChunks} de {importError.partial.totalChunks} bloques
                    ({importError.partial.partial.inserted} nuevas, {importError.partial.partial.updated} actualizadas).
                    Corregí el problema y volvé a importar el mismo archivo: lo ya guardado no se duplica.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-white/8 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-white/45">
                {rowsToWrite.length
                  ? `Se guardarán ${plural(rowsToWrite.length, "línea", "líneas")} (${counts.new} nuevas, ${counts.changed} actualizadas). Las filas inválidas y las ya cargadas sin cambios no se tocan. Las líneas vinculadas a un producto descuentan stock.`
                  : "No hay ventas nuevas ni cambios para importar."}
              </p>
              <div className="flex shrink-0 gap-2">
                <AdminSecondaryButton icon={<X className="size-3.5" />} onClick={reset} disabled={step === "importing"}>
                  Cancelar
                </AdminSecondaryButton>
                <button
                  type="button"
                  onClick={() => void runImport()}
                  disabled={!rowsToWrite.length || step === "importing" || disabled}
                  className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/14 px-4 text-xs font-black text-emerald-200 transition hover:bg-emerald-400/24 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {step === "importing" ? <RefreshCw className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  {step === "importing"
                    ? `Importando${progress ? ` ${progress.done}/${progress.total}` : "…"}`
                    : `Importar ${rowsToWrite.length.toLocaleString("es-AR")} ${rowsToWrite.length === 1 ? "línea" : "líneas"}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "done" && result && (
          <div role="status" className="mt-3 rounded-xl border border-emerald-400/25 bg-emerald-400/8 px-3 py-3 text-sm text-emerald-100">
            <p className="flex items-center gap-2 font-black">
              <CheckCircle2 className="size-4" />
              Importación completa: {fileName}
            </p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/85">
              {plural(result.inserted, "venta nueva", "ventas nuevas")} · {plural(result.updated, "actualizada", "actualizadas")} ·{" "}
              {plural(result.unchanged, "sin cambios", "sin cambios")}
              {result.duplicateRows ? ` · ${plural(result.duplicateRows, "fila repetida ignorada", "filas repetidas ignoradas")}` : ""}
              {report?.invalidRows.length ? ` · ${plural(report.invalidRows.length, "fila inválida no importada", "filas inválidas no importadas")}` : ""}
              {result.linked ? ` · ${plural(result.linked, "vinculada al inventario", "vinculadas al inventario")}` : ""}.
            </p>
          </div>
        )}
      </section>

      <MercadoLibreImportHistory refreshKey={historyKey + historyRefreshKey} disabled={disabled || busy} onReverted={onImported} />
    </div>
  )
}

const BATCH_STATUS: Record<MercadoLibreImportBatch["status"], { label: string; className: string }> = {
  processing: { label: "En curso", className: "border-sky-400/25 bg-sky-400/10 text-sky-200" },
  completed: { label: "Completa", className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" },
  failed: { label: "Interrumpida", className: "border-red-400/25 bg-red-400/10 text-red-200" },
  reverted: { label: "Revertida", className: "border-white/12 bg-white/5 text-white/55" },
  partially_reverted: { label: "Revertida en parte", className: "border-amber-300/25 bg-amber-300/10 text-amber-100" },
}

function canRevert(batch: MercadoLibreImportBatch) {
  if (batch.reversible_sales <= 0) return false
  if (batch.status === "completed" || batch.status === "failed") return true
  return batch.status === "processing" && Date.now() - new Date(batch.created_at).getTime() > 15 * 60_000
}

export function MercadoLibreImportHistory({
  refreshKey,
  disabled,
  onReverted,
}: {
  refreshKey: number
  disabled: boolean
  onReverted: () => Promise<void> | void
}) {
  const [batches, setBatches] = useState<MercadoLibreImportBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [reverting, setReverting] = useState<MercadoLibreImportBatch | null>(null)
  const [revertBusy, setRevertBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setBatches(await getMercadoLibreImportBatches())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el historial de importaciones.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const confirmRevert = async () => {
    if (!reverting || revertBusy) return
    setRevertBusy(true)
    setError("")
    try {
      const outcome = await revertMercadoLibreImportBatch(reverting.id, reverting.reversible_sales)
      const kept = (outcome.kept_modified_later ?? 0) + (outcome.kept_with_return_review ?? 0)
      setNotice(
        `${plural(outcome.deleted ?? 0, "venta eliminada", "ventas eliminadas")} de “${reverting.source_file_name ?? "archivo"}”.` +
          (kept ? ` ${plural(kept, "venta se conservó", "ventas se conservaron")} porque se modificó después.` : "") +
          (outcome.updated_not_reversible ? ` ${plural(outcome.updated_not_reversible, "venta actualizada no vuelve", "ventas actualizadas no vuelven")} a su versión anterior.` : ""),
      )
      setReverting(null)
      await Promise.all([load(), onReverted()])
    } catch (revertError) {
      setError(revertError instanceof Error ? revertError.message : "No se pudo revertir la importación.")
      setReverting(null)
    } finally {
      setRevertBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-beyonix-blue-light/18 bg-[#071018] p-3.5" aria-labelledby="ml-import-history-title">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-11px font-black uppercase tracking-widest text-beyonix-cyan">Historial</p>
          <h3 id="ml-import-history-title" className="mt-1 flex items-center gap-1.5 text-base font-black text-white">
            Importaciones
            <AdminHelpTip
              label="Revertir una importación"
              text="Revertir elimina sólo las ventas que esa importación creó y que nadie modificó después. Las ventas que sólo actualizó no vuelven a su versión anterior y las que tienen una devolución revisada se conservan."
            />
          </h3>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Actualizar historial de importaciones"
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 text-white/60 transition hover:border-white/25 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && <p role="alert" className="mt-3 rounded-xl border border-red-400/22 bg-red-400/10 px-3 py-2 text-xs text-red-100">{error}</p>}
      {notice && <p role="status" className="mt-3 rounded-xl border border-emerald-400/22 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">{notice}</p>}

      {!loading && !error && batches.length === 0 && (
        <p className="mt-3 rounded-xl border border-white/8 bg-black/20 px-3 py-4 text-center text-xs text-white/45">
          Todavía no hay importaciones registradas.
        </p>
      )}

      {batches.length > 0 && (
        <ul className="mt-3 space-y-2">
          {batches.map((batch) => {
            const status = BATCH_STATUS[batch.status]
            return (
              <li key={batch.id} className="flex flex-col gap-2 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-xs font-black text-white">
                    <span className="min-w-0 break-all">{batch.source_file_name ?? "Archivo sin nombre"}</span>
                    <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-10px font-black ${status.className}`}>{status.label}</span>
                  </p>
                  <p className="mt-0.5 text-11px leading-5 text-white/45">
                    {formatDateTime(batch.created_at)} · {batch.imported_by_email ?? "usuario desconocido"} ·{" "}
                    {plural(batch.rows_read, "fila", "filas")} · {batch.inserted} nuevas · {batch.updated} actualizadas · {batch.unchanged} sin cambios
                    {batch.rows_duplicate_in_file ? ` · ${batch.rows_duplicate_in_file} repetidas` : ""}
                    {batch.rows_invalid ? ` · ${batch.rows_invalid} inválidas` : ""}
                    {batch.reverted_at ? ` · ${batch.reverted_count} eliminadas al revertir` : ""}
                  </p>
                  {batch.error_message && <p className="mt-0.5 text-11px text-red-200/85">{batch.error_message}</p>}
                </div>
                {canRevert(batch) && (
                  <AdminSecondaryButton
                    size="sm"
                    icon={<RotateCcw className="size-3.5" />}
                    disabled={disabled || revertBusy}
                    onClick={() => setReverting(batch)}
                    aria-label={`Revertir importación ${batch.source_file_name ?? ""}`}
                  >
                    Revertir
                  </AdminSecondaryButton>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <AdminModal
        open={Boolean(reverting)}
        title="Revertir importación"
        eyebrow="Ventas Mercado Libre"
        description={reverting?.source_file_name ?? undefined}
        compact
        onClose={() => { if (!revertBusy) setReverting(null) }}
        footer={
          <div className="flex justify-end gap-2">
            <AdminSecondaryButton onClick={() => setReverting(null)} disabled={revertBusy}>Cancelar</AdminSecondaryButton>
            <AdminDangerButton onClick={() => void confirmRevert()} disabled={revertBusy} icon={revertBusy ? <RefreshCw className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}>
              Eliminar {reverting?.reversible_sales ?? 0} ventas
            </AdminDangerButton>
          </div>
        }
      >
        {reverting && (
          <div className="space-y-2 text-sm leading-6 text-white/70">
            <p>
              Se van a eliminar <strong className="text-white">{plural(reverting.reversible_sales, "venta", "ventas")}</strong> que creó esta importación.
              El stock de los productos vinculados se recalcula y queda registro en la auditoría.
            </p>
            {reverting.kept_sales > 0 && (
              <p>{plural(reverting.kept_sales, "venta se conserva", "ventas se conservan")} porque otra importación o una revisión de devolución la modificó después.</p>
            )}
            {reverting.updated > 0 && (
              <p>{plural(reverting.updated, "venta que esta importación actualizó no vuelve", "ventas que esta importación actualizó no vuelven")} a su versión anterior.</p>
            )}
          </div>
        )}
      </AdminModal>
    </section>
  )
}
