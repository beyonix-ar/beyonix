"use client"

import { useMemo, useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, Copy, FileSpreadsheet, XCircle } from "lucide-react"

import { getOrCreateIdempotencyAttempt, type IdempotencyAttempt } from "@/lib/business/idempotency-attempt"
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

const STATE_LABELS: Record<ExternalSalePreviewRow["state"], { label: string; className: string; icon: typeof CheckCircle2 }> = {
  valid: { label: "Válida", className: "text-emerald-300", icon: CheckCircle2 },
  warning: { label: "Advertencia", className: "text-amber-200", icon: AlertTriangle },
  duplicate: { label: "Posible duplicada", className: "text-sky-200", icon: Copy },
  error: { label: "Error", className: "text-red-300", icon: XCircle },
}

function formatDate(value: string) {
  return value.split("-").reverse().join("/")
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
      wide
      eyebrow="Ventas externas"
      title={source === "paste" ? "Pegar ventas" : "Importar archivo"}
      description="Nada se guarda hasta que confirmes. Revisá el preview y elegí si las ventas son Históricas o Nuevas."
      onClose={() => { if (!importingRef.current) onClose() }}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {ready && (
            <p className="mr-auto text-xs text-white/58">
              Se importarán {importable.length} de {preview.length} filas.
              {counts.error ? ` ${counts.error} con error quedan afuera.` : ""}
            </p>
          )}
          <AdminSecondaryButton disabled={importing} onClick={onClose}>Cancelar</AdminSecondaryButton>
          {ready && (
            <AdminPrimaryButton disabled={!canConfirm} onClick={() => void confirm()}>
              {importing ? "Importando…" : `Importar ${importable.length} ventas`}
            </AdminPrimaryButton>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {source === "paste" ? (
          <div className="space-y-2">
            <AdminTextarea
              title="Filas copiadas desde Excel"
              placeholder="Copiá las filas en Excel (incluida la fila de títulos) y pegalas acá."
              value={text}
              disabled={importing}
              onChange={changeText}
              className="min-h-36 font-mono text-xs"
            />
            <div className="flex justify-end">
              <AdminSecondaryButton
                disabled={!text.trim() || loading || importing}
                onClick={() => void analyze(parseTabularText(text), versionRef.current)}
              >
                {loading ? "Verificando…" : "Previsualizar"}
              </AdminSecondaryButton>
            </div>
          </div>
        ) : (
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
        )}

        <p className="text-xs text-white/50">
          Envío: sólo el costo logístico que pagó BEYONIX. Si el cliente pagó su envío, va $0 o vacío.
        </p>

        {sheet?.error && <AdminInfoBlock tone="danger">{sheet.error}</AdminInfoBlock>}
        {error && <p role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-100">{error}</p>}
        {previousBatch && (
          <AdminInfoBlock tone="warning">
            Estas mismas filas ya se importaron el {new Date(previousBatch.created_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}. Revisá el historial antes de importarlas otra vez.
          </AdminInfoBlock>
        )}

        {ready && (
          <>
            <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
              {(Object.keys(STATE_LABELS) as Array<keyof typeof STATE_LABELS>).map((state) => {
                const { label, className, icon: Icon } = STATE_LABELS[state]
                return (
                  <div key={state} className="rounded-xl border border-white/8 bg-black/25 p-2">
                    <Icon className={`mx-auto size-4 ${className}`} />
                    <p className="mt-1 font-black text-white">{counts[state]}</p>
                    <p className="text-white/50">{label}</p>
                  </div>
                )
              })}
            </div>

            <fieldset className="grid gap-2 sm:grid-cols-2" disabled={importing}>
              <legend className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">¿Qué ventas son?</legend>
              {(["none", "consume"] as const).map((option) => (
                <label key={option} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/72 has-checked:border-beyonix-sky/50">
                  <input type="radio" name="external-sales-import-mode" checked={mode === option} onChange={() => changeMode(option)} className="mt-1" />
                  <span>
                    <span className="block font-black text-white">{option === "none" ? "Históricas" : "Nuevas"}</span>
                    {option === "none"
                      ? "Ya ocurrieron y el stock físico actual las contempla: no modifican el stock. Se cuentan en su fecha real."
                      : "Recién realizadas: descuentan stock al confirmar, sin tocar unidades reservadas por la tienda web."}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="sales-ledger-scrollbar max-h-[45vh] overflow-auto rounded-xl border border-white/8">
              <table className="w-full min-w-[920px] text-left text-xs">
                <thead className="sticky top-0 bg-[#07111B] text-10px font-black uppercase tracking-widest text-white/45">
                  <tr>
                    {["Fila", "Estado", "Fecha", "Cliente", "SKU", "Producto", "Cant.", "Precio final", "Validación"].map((label) => (
                      <th key={label} className="px-2 py-2">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => {
                    const { label, className, icon: Icon } = STATE_LABELS[row.state]
                    const payload = row.parsed.payload
                    const values = row.parsed.sourceValues
                    return (
                      <tr key={row.parsed.sourceRowNumber} className="border-t border-white/6 align-top text-white/72">
                        <td className="px-2 py-2 tabular-nums text-white/45">{row.parsed.sourceRowNumber}</td>
                        <td className={`whitespace-nowrap px-2 py-2 font-bold ${className}`}>
                          <Icon className="mr-1 inline size-3.5" />{label}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2">{payload ? formatDate(payload.sale_date) : values.Fecha ?? "—"}</td>
                        <td className="px-2 py-2">{payload?.customer_name ?? "—"}</td>
                        <td className="px-2 py-2 font-mono">{payload?.sku ?? values.SKU ?? "—"}</td>
                        <td className="px-2 py-2">
                          {payload?.product_name ?? row.catalogName ?? "—"}
                          {row.catalogName && payload?.product_name && row.catalogName !== payload.product_name && (
                            <span className="block text-10px text-white/40">Catálogo: {row.catalogName}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 tabular-nums">{payload?.quantity ?? "—"}</td>
                        <td className="px-2 py-2 tabular-nums">{payload ? formatPrice(payload.gross_amount) : "—"}</td>
                        <td className="px-2 py-2">
                          {row.messages.map((message) => <p key={message}>{message}</p>)}
                          {row.duplicateOf && (
                            <label className="mt-1 flex items-center gap-2 text-sky-100">
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
                              <span className="text-white/45">
                                ({row.duplicateOf.inPaste ? "repetida en estas filas" : ""}
                                {row.duplicateOf.inPaste && row.duplicateOf.saleNumbers.length ? " · " : ""}
                                {row.duplicateOf.saleNumbers.slice(0, 3).map(externalSaleCode).join(", ")})
                              </span>
                            </label>
                          )}
                          {!row.messages.length && !row.duplicateOf && <span className="text-white/35">OK</span>}
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
