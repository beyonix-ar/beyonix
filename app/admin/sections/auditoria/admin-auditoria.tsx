"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CalendarDays,
  Filter,
  History,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react"

import { AdminSelect, AdminTextInput } from "@/app/admin/components/admin-controls"
import { getAuditLogs, undoAuditLog } from "@/lib/supabase/queries/auditoria"
import type { SupabaseAuditLog } from "@/lib/supabase/types"

import {
  canUndoAuditLog,
  formatAuditDate,
  formatAuditDescription,
  formatAuditTime,
  formatTechnicalValue,
  getAuditDisplayAction,
  getAuditSection,
  getAuditSeverity,
  getChangedFields,
  getHumanFieldName,
  getPreviewFields,
  getSeverityLabel,
  getUndoDescription,
  isGeneralAdminAuditLog,
  isUndoAuditEvent,
  type AuditActionFilter,
  type AuditSeverity,
} from "./audit-helpers"

const severityStyles: Record<AuditSeverity, string> = {
  normal: "border-white/10 bg-white/5 text-white/68",
  importante: "border-amber-300/25 bg-amber-300/10 text-amber-200",
  critico: "border-red-400/30 bg-red-500/10 text-red-200",
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }

  return null
}

function getInputDate(value: string) {
  return new Date(value).toLocaleDateString("en-CA")
}

function AuditDetails({ log }: { log: SupabaseAuditLog }) {
  const changedFields = useMemo(() => getChangedFields(log), [log])
  const previewFields = useMemo(() => getPreviewFields(log), [log])
  const fields = log.action === "UPDATE" ? changedFields : previewFields

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-white/7 bg-black">
      <div className="grid gap-3 border-b border-white/7 px-4 py-3 text-sm lg:grid-cols-3">
        <p className="font-bold text-white">Tabla técnica</p>
        <p className="break-words text-white/65">{log.table_name}</p>
        <p className="break-words text-white/80">ID: {log.record_id ?? "-"}</p>
      </div>

      {fields.length === 0 ? (
        <p className="px-4 py-3 text-sm text-white/55">
          No hay detalle adicional para mostrar.
        </p>
      ) : (
        fields.map((field) => (
          <div
            key={`${log.id}-${field}`}
            className="grid gap-3 border-b border-white/7 px-4 py-3 last:border-b-0 lg:grid-cols-3"
          >
            <p className="text-sm font-bold text-white">
              {getHumanFieldName(field)}
            </p>

            <p className="break-words text-sm text-white/65">
              <span className="mr-2 text-white/35">Antes:</span>
              {formatTechnicalValue(log.before_data?.[field])}
            </p>

            <p className="break-words text-sm text-white/80">
              <span className="mr-2 text-white/35">Después:</span>
              {formatTechnicalValue(log.after_data?.[field])}
            </p>
          </div>
        ))
      )}
    </div>
  )
}

export function AdminAuditoria() {
  const [logs, setLogs] = useState<SupabaseAuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [undoingId, setUndoingId] = useState<number | null>(null)
  const [pendingUndoLog, setPendingUndoLog] = useState<SupabaseAuditLog | null>(null)
  const [dateFilter, setDateFilter] = useState("")
  const [adminFilter, setAdminFilter] = useState("")
  const [sectionFilter, setSectionFilter] = useState("all")
  const [actionFilter, setActionFilter] = useState<AuditActionFilter>("all")
  const [severityFilter, setSeverityFilter] = useState<"all" | AuditSeverity>("all")
  const [onlyReversible, setOnlyReversible] = useState(false)

  const loadLogs = useCallback(async () => {
    try {
      setError(null)
      const data = await getAuditLogs()
      setLogs(data)
    } catch (err) {
      const message = getErrorMessage(err)
      setError(
        message
          ? `No se pudo cargar la auditoría: ${message}`
          : "No se pudo cargar la auditoría. Ejecutá primero el SQL de auditoría en Supabase.",
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const adminLogs = useMemo(() => logs.filter(isGeneralAdminAuditLog), [logs])

  const sections = useMemo(() => {
    return Array.from(new Set(adminLogs.map(getAuditSection))).sort((a, b) =>
      a.localeCompare(b),
    )
  }, [adminLogs])

  const filteredLogs = useMemo(() => {
    const normalizedAdminFilter = adminFilter.trim().toLowerCase()

    return adminLogs.filter((log) => {
      if (dateFilter && getInputDate(log.created_at) !== dateFilter) return false
      if (
        normalizedAdminFilter &&
        !(log.actor_email ?? "Sistema").toLowerCase().includes(normalizedAdminFilter)
      ) {
        return false
      }

      if (sectionFilter !== "all" && getAuditSection(log) !== sectionFilter) return false

      if (actionFilter === "UNDONE" && !log.undone_at && !isUndoAuditEvent(log)) return false
      if (actionFilter !== "all" && actionFilter !== "UNDONE" && log.action !== actionFilter) {
        return false
      }

      if (severityFilter !== "all" && getAuditSeverity(log) !== severityFilter) return false
      if (onlyReversible && !canUndoAuditLog(log)) return false

      return true
    })
  }, [
    actionFilter,
    adminFilter,
    adminLogs,
    dateFilter,
    onlyReversible,
    sectionFilter,
    severityFilter,
  ])

  const handleUndo = async () => {
    if (!pendingUndoLog || !canUndoAuditLog(pendingUndoLog)) return

    try {
      setUndoingId(pendingUndoLog.id)
      setError(null)
      await undoAuditLog(pendingUndoLog.id)
      setPendingUndoLog(null)
      await loadLogs()
    } catch (err) {
      const message = getErrorMessage(err)
      setError(
        message
          ? `No se pudo deshacer este cambio: ${message}`
          : "No se pudo deshacer este cambio. Puede depender de otros registros relacionados.",
      )
    } finally {
      setUndoingId(null)
    }
  }

  return (
    <div className="p-8">
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-sky-300">
            Super admin
          </p>

          <h1 className="text-3xl font-bold text-white">
            Auditoría
          </h1>
        </div>

        <button
          type="button"
          aria-label="Actualizar registro de auditoría"
          title="Actualizar registro"
          onClick={() => {
            setLoading(true)
            void loadLogs()
          }}
          className="inline-flex min-h-48px min-w-140px cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white px-6 py-3 text-sm font-bold text-black transition hover:bg-white/90"
        >
          <RefreshCw className="size-4" />
          Actualizar
        </button>
      </div>

      <div className="rounded-3xl border border-white/7 bg-black p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl border border-sky-300/25 bg-sky-300/10 text-sky-300">
            <ShieldCheck className="size-5" />
          </div>

          <div>
            <h2 className="text-xl font-bold text-white">
              Registro de actividad administrativa
            </h2>

            <p className="mt-1 text-sm text-white/65">
              Acciones realizadas por administradores dentro del panel. Los eventos normales de clientes, pagos y envíos quedan fuera de esta vista.
            </p>
          </div>
        </div>

        <div className="mb-6 rounded-3xl border border-white/7 bg-transparent p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-white/78">
            <Filter className="size-4 text-beyonix-sky" />
            Filtros
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <label className="relative block" title="Filtrar por fecha">
              <CalendarDays className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-white/38" />
              <input
                type="date"
                aria-label="Filtrar por fecha"
                value={dateFilter}
                onChange={(event) => setDateFilter(event.target.value)}
                className="h-11 w-full cursor-pointer rounded-18px border border-white/12 bg-black pl-11 pr-4 text-sm font-medium text-white/86 outline-none transition-colors hover:border-beyonix-blue-light/45 focus:border-beyonix-blue-light"
              />
            </label>

            <AdminTextInput
              title="Filtrar por administrador"
              ariaLabel="Filtrar por administrador"
              value={adminFilter}
              placeholder="Usuario/admin"
              icon={<Search className="size-4" />}
              onChange={setAdminFilter}
            />

            <AdminSelect
              title="Sección afectada"
              ariaLabel="Sección afectada"
              value={sectionFilter}
              onChange={setSectionFilter}
            >
              <option value="all">Todas las secciones</option>
              {sections.map((section) => (
                <option key={section} value={section}>
                  {section}
                </option>
              ))}
            </AdminSelect>

            <AdminSelect
              title="Acción"
              ariaLabel="Acción"
              value={actionFilter}
              onChange={(value) => setActionFilter(value as AuditActionFilter)}
            >
              <option value="all">Todas las acciones</option>
              <option value="INSERT">Creado</option>
              <option value="UPDATE">Editado</option>
              <option value="DELETE">Eliminado</option>
              <option value="UNDONE">Deshecho</option>
            </AdminSelect>

            <AdminSelect
              title="Importancia"
              ariaLabel="Importancia"
              value={severityFilter}
              onChange={(value) => setSeverityFilter(value as "all" | AuditSeverity)}
            >
              <option value="all">Todas las importancias</option>
              <option value="normal">Normal</option>
              <option value="importante">Importante</option>
              <option value="critico">Crítico</option>
            </AdminSelect>

            <label className="flex h-11 cursor-pointer items-center justify-between gap-3 rounded-18px border border-white/12 bg-black px-4 text-sm font-medium text-white/86 transition-colors hover:border-beyonix-blue-light/45">
              <span>Solo reversibles</span>
              <input
                type="checkbox"
                checked={onlyReversible}
                onChange={(event) => setOnlyReversible(event.target.checked)}
                className="size-4 cursor-pointer accent-beyonix-sky"
              />
            </label>
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-center gap-3 rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            <AlertCircle className="size-5 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl border border-white/7 bg-black px-5 py-6 text-sm text-white/60">
            Cargando movimientos...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="rounded-2xl border border-white/7 bg-black px-5 py-6">
            <div className="flex items-center gap-3 text-white/65">
              <History className="size-5" />

              <p className="text-sm">
                No hay acciones administrativas para los filtros seleccionados.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredLogs.map((log) => {
              const isUndone = Boolean(log.undone_at)
              const description = formatAuditDescription(log)
              const severity = getAuditSeverity(log)
              const canUndo = canUndoAuditLog(log)

              return (
                <article
                  key={log.id}
                  className="rounded-2xl border border-white/7 bg-black p-4 transition hover:border-sky-300/35 hover:bg-admin-hover"
                >
                  <div className="grid gap-4 xl:grid-cols-4 xl:items-center">
                    <div>
                      <p className="text-11px font-semibold uppercase tracking-widest text-white/35">
                        Fecha
                      </p>
                      <p className="mt-1 text-sm font-bold text-white">
                        {formatAuditDate(log.created_at)}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-white/45">
                        Hora: {formatAuditTime(log.created_at)}
                      </p>
                    </div>

                    <div>
                      <p className="text-11px font-semibold uppercase tracking-widest text-white/35">
                        Usuario
                      </p>
                      <p className="mt-1 break-words text-sm font-bold text-white">
                        {log.actor_email ?? "Sistema"}
                      </p>
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-sky-300/20 bg-sky-300/10 px-3 py-1 text-xs font-bold text-sky-200">
                          {getAuditDisplayAction(log)}
                        </span>

                        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${severityStyles[severity]}`}>
                          {getSeverityLabel(severity)}
                        </span>

                        {isUndone && (
                          <span className="rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-xs font-bold text-red-200">
                            Deshecho
                          </span>
                        )}
                      </div>

                      <div className="mt-3 space-y-2">
                        <p className="text-sm font-bold text-white/85">
                          {description.title}
                        </p>
                        {description.lines.length > 0 && (
                          <ul className="space-y-1 text-sm leading-6 text-white/62">
                            {description.lines.map((line) => (
                              <li key={`${log.id}-${line}`}>{line}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-start xl:justify-end">
                      {canUndo && (
                        <button
                          type="button"
                          aria-label={`Deshacer movimiento ${log.id}`}
                          title="Deshacer movimiento"
                          disabled={undoingId === log.id}
                          onClick={() => setPendingUndoLog(log)}
                          className="inline-flex min-h-44px min-w-140px cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white px-5 py-2 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35"
                        >
                          <RotateCcw className="size-4" />
                          {undoingId === log.id ? "Deshaciendo..." : "Deshacer"}
                        </button>
                      )}
                    </div>
                  </div>

                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-bold text-sky-200 transition hover:text-white">
                      Ver detalle
                    </summary>

                    <AuditDetails log={log} />
                  </details>
                </article>
              )
            })}
          </div>
        )}
      </div>

      {pendingUndoLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-3xl border border-beyonix-blue-light/25 bg-black p-6 shadow-2xl shadow-black">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="mb-2 text-11px font-black uppercase tracking-widest text-beyonix-sky">
                  Confirmar acción
                </p>
                <h2 className="text-2xl font-black text-white">
                  Deshacer movimiento
                </h2>
              </div>

              <button
                type="button"
                aria-label="Cerrar alerta"
                title="Cerrar"
                onClick={() => setPendingUndoLog(null)}
                className="flex size-10 cursor-pointer items-center justify-center rounded-2xl border border-white/10 bg-black text-white/55 transition hover:border-white/25 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="rounded-2xl border border-white/8 bg-black px-4 py-4">
              <p className="text-sm font-bold leading-6 text-white">
                ¿Está seguro de deshacer "{getUndoDescription(pendingUndoLog)}"?
              </p>
              <div className="mt-3 space-y-1 text-sm leading-6 text-white/55">
                <p>{formatAuditDescription(pendingUndoLog).title}</p>
                {formatAuditDescription(pendingUndoLog).lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setPendingUndoLog(null)}
                className="inline-flex min-h-44px cursor-pointer items-center justify-center rounded-2xl border border-white/10 bg-black px-5 py-2 text-sm font-black text-white transition hover:border-beyonix-blue-light/40 hover:text-beyonix-sky"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={() => void handleUndo()}
                disabled={undoingId === pendingUndoLog.id || !canUndoAuditLog(pendingUndoLog)}
                className="inline-flex min-h-44px cursor-pointer items-center justify-center rounded-2xl border border-white/10 bg-black px-5 py-2 text-sm font-black text-white/55 transition hover:border-red-600 hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-black disabled:text-white/25"
              >
                {undoingId === pendingUndoLog.id ? "Deshaciendo..." : "Sí, estoy seguro"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
