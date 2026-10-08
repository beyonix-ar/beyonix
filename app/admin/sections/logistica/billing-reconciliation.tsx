"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import {
  AdminBadge,
  AdminButton,
  AdminFormField,
  AdminModal,
  AdminPrimaryButton,
  AdminSelect,
  AdminTextInput,
} from "@/app/admin/components/admin-controls"
import {
  BILLED_HELP,
  BILLING_FIELD_LABELS,
  BILLING_MOVEMENT_LABELS,
  BILLING_MOVEMENT_TYPES,
  BillingCsvError,
  detectBillingColumns,
  MAX_BILLING_CSV_BYTES,
  parseBillingCsv,
  RECONCILIATION_LABELS,
  UNMATCHED_LABEL,
  type BillingColumnMapping,
  type BillingEntry,
  type BillingField,
  type BillingMovementType,
  type BillingRecordResult,
  type ReconciliationStatus,
} from "@/lib/admin/andreani-billing"
import { parseOrderCode } from "@/lib/admin/dispatch"
import type { LogisticsOrderRow } from "@/lib/admin/logistics"
import { supabase } from "@/lib/supabase/client"

import { formatMoney, formatSignedMoney } from "./logistics-summary"

export const RECONCILIATION_TONE: Record<ReconciliationStatus, "neutral" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  reconciled: "success",
  minor_difference: "warning",
  major_difference: "danger",
  no_reference: "neutral",
}

const money = (value: number | null) => value === null ? "—" : formatMoney(value)
const today = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)

async function billingRequest<T>(method: "GET" | "POST" | "PATCH", query: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error("La sesión administrativa venció. Volvé a iniciar sesión.")
  const response = await fetch(`/api/admin/logistics/billing${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  const result = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || !result) throw new Error(result?.error ?? "No se pudo completar la operación.")
  return result
}

type EntryDraft = { amount: string; billedOn: string; reference: string; notes: string; movementType: BillingMovementType }
const emptyDraft = (): EntryDraft => ({ amount: "", billedOn: today(), reference: "", notes: "", movementType: "outbound" })

function MovementSelect({ value, onChange }: { value: BillingMovementType; onChange: (value: BillingMovementType) => void }) {
  return (
    <AdminSelect title="Tipo de movimiento" value={value} onChange={(next) => onChange(next as BillingMovementType)}>
      {BILLING_MOVEMENT_TYPES.map((type) => <option key={type} value={type}>{BILLING_MOVEMENT_LABELS[type]}</option>)}
    </AdminSelect>
  )
}

/** Modal "Conciliar": cargos facturados del pedido, alta manual y corrección auditada. */
export function ReconcileOrderModal({ row, onClose, onSaved }: { row: LogisticsOrderRow | null; onClose: () => void; onSaved: () => void }) {
  const [entries, setEntries] = useState<BillingEntry[] | null>(null)
  const [draft, setDraft] = useState<EntryDraft>(emptyDraft)
  const [editing, setEditing] = useState<BillingEntry | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const orderId = row?.id ?? null

  const load = useCallback(async () => {
    if (!orderId) return
    try {
      setEntries((await billingRequest<{ entries: BillingEntry[] }>("GET", `?orderId=${orderId}`)).entries)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar la facturación.")
    }
  }, [orderId])

  useEffect(() => {
    setEntries(null); setDraft(emptyDraft()); setEditing(null); setReason(""); setError(""); setNotice("")
    void load()
  }, [load])

  if (!row) return null
  const total = entries?.reduce((sum, entry) => sum + entry.amount, 0) ?? 0

  async function submit() {
    if (busyRef.current || !row) return
    busyRef.current = true; setBusy(true); setError(""); setNotice("")
    try {
      if (editing) {
        await billingRequest("PATCH", "", {
          entryId: editing.id,
          reason,
          patch: { amount: draft.amount, billedOn: draft.billedOn, reference: draft.reference, notes: draft.notes || null, movementType: draft.movementType },
        })
        setNotice("Cargo corregido. El cambio quedó auditado.")
      } else {
        const { result } = await billingRequest<{ result: BillingRecordResult }>("POST", "", {
          action: "manual", orderId: row.id, tracking: row.tracking, ...draft,
        })
        setNotice(result.status === "duplicate" ? "Esa factura ya estaba registrada: no se duplicó." : "Facturación registrada.")
      }
      setDraft(emptyDraft()); setEditing(null); setReason("")
      await load()
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar.")
    } finally {
      busyRef.current = false; setBusy(false)
    }
  }

  const canSubmit = draft.amount.trim() && draft.billedOn && draft.reference.trim() && (!editing || reason.trim().length >= 5)
  return (
    <AdminModal open wide title={`Conciliar ${row.code}`} description="Registrá lo que Andreani facturó o liquidó para este pedido. Cargá el importe final con IVA." onClose={onClose}
      footer={<div className="flex flex-wrap items-center justify-end gap-2">
        {editing ? <AdminButton disabled={busy} onClick={() => { setEditing(null); setDraft(emptyDraft()); setReason("") }}>Cancelar corrección</AdminButton> : null}
        <AdminButton onClick={onClose}>Cerrar</AdminButton>
        <AdminPrimaryButton disabled={busy || !canSubmit} onClick={() => void submit()}>{editing ? "Guardar corrección" : "Guardar"}</AdminPrimaryButton>
      </div>}>
      <dl className="grid gap-2 text-sm sm:grid-cols-5">
        {[
          ["Pedido", row.code],
          ["Tracking", row.tracking ?? "—"],
          ["Cotizado checkout", money(row.checkoutQuote)],
          ["Cotizado con bulto real", money(row.parcelQuote)],
          ["Facturado Andreani", entries && entries.length ? formatMoney(total) : "Pendiente"],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl border border-white/10 px-3 py-2">
            <dt className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/50">{label}{label === "Facturado Andreani" ? <AdminHelpTip label={label} text={BILLED_HELP} /> : null}</dt>
            <dd className="mt-1 truncate font-black tabular-nums text-white">{value}</dd>
          </div>
        ))}
      </dl>
      {entries && entries.length ? (
        <ul className="mt-4 space-y-2" aria-label="Cargos facturados">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm text-white/85">
              <AdminBadge tone="info">{BILLING_MOVEMENT_LABELS[entry.movementType]}</AdminBadge>
              <span className="font-black tabular-nums text-white">{formatMoney(entry.amount)}</span>
              <span>{entry.billedOn.split("-").reverse().join("/")}</span>
              <span className="font-mono text-xs">{entry.reference}</span>
              <span className="text-xs text-white/50">{entry.source === "csv" ? "CSV" : entry.source === "api" ? "API" : "Manual"}{entry.correctionReason ? ` · corregido: ${entry.correctionReason}` : ""}</span>
              <AdminButton size="sm" className="ml-auto" disabled={busy} onClick={() => {
                setEditing(entry); setReason(""); setNotice("")
                setDraft({ amount: String(entry.amount), billedOn: entry.billedOn, reference: entry.reference, notes: entry.notes ?? "", movementType: entry.movementType })
              }}>Corregir</AdminButton>
            </li>
          ))}
        </ul>
      ) : entries ? <p className="mt-4 text-sm text-white/60">Todavía no hay facturación registrada para este pedido.</p> : <p role="status" className="mt-4 text-sm text-white/60">Cargando…</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <AdminFormField label="Tipo de movimiento"><MovementSelect value={draft.movementType} onChange={(movementType) => setDraft((current) => ({ ...current, movementType }))} /></AdminFormField>
        <AdminFormField label="Importe facturado (con IVA)"><AdminTextInput title="Importe facturado" inputMode="decimal" placeholder="Ej.: 8.500,00" value={draft.amount} onChange={(amount) => setDraft((current) => ({ ...current, amount }))} /></AdminFormField>
        <AdminFormField label="Fecha de factura"><AdminTextInput title="Fecha de factura" placeholder="AAAA-MM-DD" type="date" value={draft.billedOn} onChange={(billedOn) => setDraft((current) => ({ ...current, billedOn }))} /></AdminFormField>
        <AdminFormField label="Referencia / factura"><AdminTextInput title="Referencia o número de factura" maxLength={80} placeholder="Ej.: A-0001-00012345" value={draft.reference} onChange={(reference) => setDraft((current) => ({ ...current, reference }))} /></AdminFormField>
        <AdminFormField label="Observación" className="sm:col-span-2"><AdminTextInput title="Observación" placeholder="Opcional" maxLength={1000} value={draft.notes} onChange={(notes) => setDraft((current) => ({ ...current, notes }))} /></AdminFormField>
        {editing ? <AdminFormField label="Motivo de la corrección" className="sm:col-span-2" help="Obligatorio. Queda en la auditoría junto con el valor anterior."><AdminTextInput title="Motivo de la corrección" placeholder="Ej.: factura rectificada por Andreani" maxLength={500} value={reason} onChange={setReason} /></AdminFormField> : null}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm font-bold text-red-300">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-sm font-bold text-emerald-300">{notice}</p> : null}
    </AdminModal>
  )
}

/** Archivo de texto: UTF-8; si trae caracteres inválidos (Excel en Windows), Windows-1252. */
async function readCsvFile(file: File) {
  const buffer = await file.arrayBuffer()
  const utf8 = new TextDecoder("utf-8").decode(buffer)
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8
}

type ImportRow = BillingRecordResult & { row?: number }
const IMPORT_STATUS_LABELS: Record<ImportRow["status"], string> = {
  ready: "Lista", created: "Registrada", duplicate: "Ya registrada", conflict: "Conflicto", invalid: "Inválida",
}
const FIELDS: BillingField[] = ["tracking", "amount", "billedOn", "reference", "movementType", "notes"]

/** Importación CSV: asignación de columnas, vista previa (sin escribir) e importación. */
export function BillingImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState<string | null>(null)
  const [fileName, setFileName] = useState("")
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<BillingColumnMapping>({})
  const [rows, setRows] = useState<ImportRow[] | null>(null)
  const [previewed, setPreviewed] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const reset = () => { setCsv(null); setFileName(""); setHeaders([]); setMapping({}); setRows(null); setPreviewed(false); setError("") }

  async function selectFile(file: File | undefined) {
    reset()
    if (!file) return
    if (!/\.csv$/i.test(file.name)) { setError("Subí un archivo .csv (en Excel: Guardar como → CSV)."); return }
    if (file.size > MAX_BILLING_CSV_BYTES) { setError("El archivo supera 1 MB."); return }
    try {
      const text = await readCsvFile(file)
      const parsed = parseBillingCsv(text)
      setCsv(text); setFileName(file.name); setHeaders(parsed.headers); setMapping(detectBillingColumns(parsed.headers))
    } catch (cause) {
      setError(cause instanceof BillingCsvError ? cause.message : "No se pudo leer el archivo.")
    }
  }

  async function send(dryRun: boolean) {
    if (!csv || busyRef.current) return
    busyRef.current = true; setBusy(true); setError("")
    try {
      const result = await billingRequest<{ rows: ImportRow[] }>("POST", "", { action: "import", csv, mapping, dryRun })
      setRows(result.rows); setPreviewed(dryRun)
      if (!dryRun) onImported()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo importar.")
    } finally {
      busyRef.current = false; setBusy(false)
    }
  }

  const counts = rows?.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }), {}) ?? {}
  const unmatched = rows?.filter((row) => row.matchStatus === "unmatched").length ?? 0
  return (
    <AdminModal open={open} wide title="Importar facturación Andreani" description="CSV con tracking, importe (con IVA), fecha y referencia de la factura o liquidación. Se asocia sólo por tracking; lo que no coincide queda como “Sin pedido asociado”." onClose={() => { reset(); onClose() }}
      footer={<div className="flex flex-wrap items-center justify-end gap-2">
        <AdminButton onClick={() => { reset(); onClose() }}>Cerrar</AdminButton>
        <AdminButton disabled={busy || !csv} onClick={() => void send(true)}>Vista previa</AdminButton>
        <AdminPrimaryButton disabled={busy || !csv || !previewed} onClick={() => void send(false)}>Importar</AdminPrimaryButton>
      </div>}>
      <label className="block text-sm text-white/80">
        <span className="mb-2 block text-11px font-black uppercase tracking-widest text-white/48">Archivo CSV (máx. 1 MB, 2000 filas)</span>
        <input type="file" accept=".csv,text/csv" aria-label="Archivo CSV de facturación" onChange={(event) => void selectFile(event.target.files?.[0])} className="block w-full text-sm text-white/80 file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-white" />
      </label>
      {headers.length ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {FIELDS.map((field) => (
            <AdminFormField key={field} label={BILLING_FIELD_LABELS[field]}>
              <AdminSelect title={BILLING_FIELD_LABELS[field]} value={mapping[field] ?? ""} onChange={(column) => { setMapping((current) => ({ ...current, [field]: column || undefined })); setRows(null); setPreviewed(false) }}>
                <option value="">— Sin asignar —</option>
                {headers.map((header) => <option key={header} value={header}>{header}</option>)}
              </AdminSelect>
            </AdminFormField>
          ))}
        </div>
      ) : null}
      {fileName ? <p className="mt-2 text-xs text-white/55">{fileName}</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm font-bold text-red-300">{error}</p> : null}
      {rows ? (
        <div className="mt-4">
          <p role="status" className="text-sm font-bold text-white">
            {previewed ? "Vista previa (todavía no se guardó nada): " : "Resultado: "}
            {Object.entries(counts).map(([status, count]) => `${count} ${IMPORT_STATUS_LABELS[status as ImportRow["status"]].toLowerCase()}`).join(" · ")}
            {unmatched ? ` · ${unmatched} ${UNMATCHED_LABEL.toLowerCase()}` : ""}
          </p>
          <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-white/10">
            <table className="w-full text-left text-xs text-white/80">
              <thead><tr className="text-10px uppercase tracking-widest text-white/50"><th className="px-2 py-1.5">Fila</th><th className="px-2 py-1.5">Estado</th><th className="px-2 py-1.5">Pedido</th><th className="px-2 py-1.5">Tipo</th><th className="px-2 py-1.5">Detalle</th></tr></thead>
              <tbody>{rows.map((row, index) => (
                <tr key={`${row.row ?? "x"}-${index}`} className="border-t border-white/8">
                  <td className="px-2 py-1.5 tabular-nums">{row.row ?? "—"}</td>
                  <td className="px-2 py-1.5">{IMPORT_STATUS_LABELS[row.status]}</td>
                  <td className="px-2 py-1.5">{row.orderId ? `BX-${1000 + row.orderId}` : row.status === "invalid" ? "—" : UNMATCHED_LABEL}</td>
                  <td className="px-2 py-1.5">{row.movementType ? BILLING_MOVEMENT_LABELS[row.movementType] : "—"}</td>
                  <td className="px-2 py-1.5">{row.error ?? (row.unmatchedReason === "ambiguous" ? "El tracking coincide con más de un envío" : row.unmatchedReason === "no_tracking" ? "Sin tracking" : row.unmatchedReason === "not_found" ? "Tracking sin envío en BEYONIX" : row.status === "conflict" ? "Ya existe con otro importe o fecha" : "")}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}
    </AdminModal>
  )
}

/** Cargos facturados del período sin pedido asociado: se asocian sólo a mano. */
export function UnmatchedBillingList({ from, to, version, onChanged }: { from: string; to: string; version: number; onChanged: () => void }) {
  const [entries, setEntries] = useState<BillingEntry[] | null>(null)
  const [linking, setLinking] = useState<BillingEntry | null>(null)
  const [code, setCode] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    billingRequest<{ entries: BillingEntry[] }>("GET", `?${new URLSearchParams({ from, to })}`)
      .then((result) => { if (active) setEntries(result.entries) })
      .catch(() => { if (active) setEntries([]) })
    return () => { active = false }
  }, [from, to, version])

  if (!entries?.length) return null
  const orderId = parseOrderCode(code)
  return (
    <section className="rounded-2xl border border-amber-400/25 bg-[rgba(3,7,13,0.72)] p-3">
      <h2 className="text-sm font-black text-white">{UNMATCHED_LABEL} · {entries.length}</h2>
      <p className="text-xs text-white/55">Cargos facturados cuyo tracking no identifica un único envío de BEYONIX. No se asocian automáticamente.</p>
      <ul className="mt-2 space-y-1.5">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm text-white/85">
            <span className="font-mono text-xs">{entry.tracking ?? "Sin tracking"}</span>
            <span className="font-black tabular-nums text-white">{formatMoney(entry.amount)}</span>
            <span>{entry.billedOn.split("-").reverse().join("/")}</span>
            <span className="font-mono text-xs">{entry.reference}</span>
            <AdminButton size="sm" className="ml-auto" onClick={() => { setLinking(entry); setCode(""); setReason(""); setError("") }}>Asociar a pedido</AdminButton>
          </li>
        ))}
      </ul>
      <AdminModal open={linking !== null} compact title="Asociar a pedido" description="Indicá el pedido al que corresponde este cargo. Queda auditado con el motivo." onClose={() => setLinking(null)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setLinking(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={busy || !orderId || reason.trim().length < 5} onClick={() => {
          if (!linking || !orderId) return
          setBusy(true); setError("")
          billingRequest("PATCH", "", { entryId: linking.id, reason, patch: { orderId } })
            .then(() => { setLinking(null); onChanged() })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "No se pudo asociar."))
            .finally(() => setBusy(false))
        }}>Asociar</AdminPrimaryButton></div>}>
        <div className="space-y-3">
          <AdminFormField label="Pedido"><AdminTextInput title="Pedido" placeholder="BX-1024" value={code} onChange={setCode} /></AdminFormField>
          <AdminFormField label="Motivo"><AdminTextInput title="Motivo" placeholder="Ej.: tracking informado en la factura" maxLength={500} value={reason} onChange={setReason} /></AdminFormField>
          {error ? <p role="alert" className="text-sm font-bold text-red-300">{error}</p> : null}
        </div>
      </AdminModal>
    </section>
  )
}

export function ReconciliationBadge({ status }: { status: ReconciliationStatus }) {
  return <AdminBadge tone={RECONCILIATION_TONE[status]}>{RECONCILIATION_LABELS[status]}</AdminBadge>
}

export const signedOrDash = (value: number | null) => value === null ? "—" : formatSignedMoney(value)
