"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  ChevronDown,
  Filter,
  History,
  Mail,
  RotateCcw,
  ShieldCheck,
  UserRound,
} from "lucide-react"

import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import {
  adminPageClassName,
  AdminDangerButton,
  AdminEmptyState,
  AdminFiltersBar,
  AdminInfoBlock,
  AdminModal,
  AdminPageHeader,
  AdminSearchInput,
  AdminSecondaryButton,
  AdminSection,
  AdminSelect,
  AdminSkeleton,
} from "@/app/admin/components/admin-controls"
import { getAuditLogs, undoAuditLog } from "@/lib/supabase/queries/auditoria"
import type { SupabaseAuditLog } from "@/lib/supabase/types"
import { formatARS } from "@/lib/customer-credit"

import {
  canUndoAuditLog,
  canUndoAuditGroup,
  formatAuditDate,
  formatAuditDescription,
  formatAuditGroupDescription,
  formatAuditTime,
  resolveFieldDisplayValue,
  getAuditGroupDisplayAction,
  getAuditGroupNonReversibleReason,
  getAuditGroupSeverity,
  getAuditGroupUndoLogs,
  getAuditSection,
  getAuditSeverity,
  getChangedFields,
  getHumanFieldName,
  getNonReversibleReason,
  getPreviewFields,
  getSeverityLabel,
  groupAuditLogs,
  isGeneralAdminAuditLog,
  isUndoAuditEvent,
  type AuditLogGroup,
  type AuditActionFilter,
  type AuditSeverity,
} from "./audit-helpers"
import {
  emptyAuditEntityMaps,
  fetchAuditEntityMaps,
  resolveVariantBarcode,
  type AuditEntityMaps,
} from "./audit-entity-resolver"

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

function parseDateInput(value: string, endOfDay = false) {
  const clean = value.trim()
  if (!clean) return null

  const parts = clean.includes("/")
    ? clean.split("/")
    : clean.includes("-")
      ? clean.split("-").reverse()
      : []

  if (parts.length !== 3) return null

  const [day, month, year] = parts.map((part) => Number(part))
  if (!day || !month || !year) return null

  const date = new Date(year, month - 1, day)
  const isValid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day

  if (!isValid) return null
  if (endOfDay) date.setHours(23, 59, 59, 999)
  return date
}

function AuditTechnicalInfo({ log }: { log: SupabaseAuditLog }) {
  return (
    <details className="border-t border-white/7 px-4 py-3">
      <summary className="cursor-pointer list-none text-11px font-bold uppercase tracking-wider text-white/35 transition [&::-webkit-details-marker]:hidden hover:text-white/60">
        Información técnica
      </summary>

      <div className="mt-3 space-y-2 text-xs text-white/50">
        <div className="grid gap-1 sm:grid-cols-2">
          <p><span className="text-white/30">ID interno:</span> {log.id}</p>
          <p><span className="text-white/30">Tabla:</span> {log.table_name}</p>
          <p className="wrap-break-word sm:col-span-2">
            <span className="text-white/30">ID de registro:</span> {log.record_id ?? "-"}
          </p>
          {log.actor_user_id && (
            <p className="wrap-break-word sm:col-span-2">
              <span className="text-white/30">Usuario (UUID):</span> {log.actor_user_id}
            </p>
          )}
          {log.undone_by && (
            <p className="wrap-break-word sm:col-span-2">
              <span className="text-white/30">Deshecho por (UUID):</span> {log.undone_by}
            </p>
          )}
        </div>

        {log.before_data && (
          <div>
            <p className="mb-1 text-white/30">Datos antes (JSON crudo)</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 wrap-break-word whitespace-pre-wrap">
              {JSON.stringify(log.before_data, null, 2)}
            </pre>
          </div>
        )}
        {log.after_data && (
          <div>
            <p className="mb-1 text-white/30">Datos después (JSON crudo)</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 wrap-break-word whitespace-pre-wrap">
              {JSON.stringify(log.after_data, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  )
}

function AuditDetails({ log, maps }: { log: SupabaseAuditLog; maps: AuditEntityMaps }) {
  const changedFields = useMemo(() => getChangedFields(log), [log])
  const previewFields = useMemo(() => getPreviewFields(log), [log])
  const fields = log.action === "UPDATE" ? changedFields : previewFields
  const nonReversibleReason = useMemo(() => getNonReversibleReason(log), [log])

  // El código de barras no es una columna de la compra: se resuelve desde
  // la variante vigente y se inserta como fila extra junto al SKU. No es
  // parte de `fields` porque no viene de before_data/after_data.
  const barcode = useMemo(() => {
    if (log.table_name !== "product_cost_entries") return null
    const data = log.action === "DELETE" ? log.before_data : log.after_data
    return resolveVariantBarcode(maps, data?.variant_id)
  }, [log, maps])

  if (
    log.table_name === "customer_credit_movements" &&
    log.after_data?.source_kind === "balance_adjustment"
  ) {
    const data = log.after_data
    const isCredit = data.movement_type === "credit"
    const targetName = String(data.target_name ?? "Cuenta sin nombre")
    const targetEmail = String(data.target_email ?? "Email no disponible")
    const description = String(data.description ?? "Sin motivo informado")

    return (
      <div className="mt-4 overflow-hidden rounded-2xl border border-[#31506F]/70 bg-[#07111C]">
        <div className={`flex items-center gap-3 border-b px-5 py-4 ${
          isCredit
            ? "border-emerald-300/15 bg-emerald-400/[0.06]"
            : "border-red-300/15 bg-red-400/[0.06]"
        }`}>
          <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${
            isCredit
              ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200"
              : "border-red-300/25 bg-red-400/10 text-red-200"
          }`}>
            {isCredit ? (
              <ArrowUpCircle className="size-5" />
            ) : (
              <ArrowDownCircle className="size-5" />
            )}
          </div>
          <div>
            <p className={`text-9px font-black uppercase tracking-[0.18em] ${
              isCredit ? "text-emerald-200/65" : "text-red-200/65"
            }`}>
              Ajuste manual de saldo
            </p>
            <h3 className="mt-1 text-base font-black text-white">
              {isCredit ? "Saldo acreditado" : "Saldo debitado"}
            </h3>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-white/8 bg-black/20 p-4">
            <p className="text-9px font-bold uppercase tracking-wider text-white/38">Importe</p>
            <p className={`mt-1.5 text-xl font-black ${
              isCredit ? "text-emerald-200" : "text-red-200"
            }`}>
              {formatARS(Number(data.amount ?? 0))}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-black/20 p-4">
            <p className="text-9px font-bold uppercase tracking-wider text-white/38">Saldo resultante</p>
            <p className="mt-1.5 text-xl font-black text-beyonix-sky">
              {formatARS(Number(data.resulting_balance ?? 0))}
            </p>
          </div>
          <div className="rounded-xl border border-white/8 bg-black/20 p-4">
            <p className="flex items-center gap-1.5 text-9px font-bold uppercase tracking-wider text-white/38">
              <UserRound className="size-3" /> Cuenta
            </p>
            <p className="mt-1.5 truncate text-sm font-black text-white/88">{targetName}</p>
          </div>
          <div className="rounded-xl border border-white/8 bg-black/20 p-4">
            <p className="flex items-center gap-1.5 text-9px font-bold uppercase tracking-wider text-white/38">
              <Mail className="size-3" /> Email
            </p>
            <p className="mt-1.5 truncate text-sm font-semibold text-white/72">{targetEmail}</p>
          </div>
        </div>

        <div className="border-t border-white/7 px-5 py-4">
          <p className="text-9px font-bold uppercase tracking-wider text-white/38">Motivo informado</p>
          <p className="mt-2 text-sm leading-6 text-white/78">{description}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-white/7 bg-black">
      <div className="flex items-center justify-between gap-4 border-b border-white/7 px-4 py-3 text-sm">
        <p className="font-bold text-white">Detalle de la acción</p>
        <p className="text-xs text-white/40">
          {fields.length + (barcode ? 1 : 0)} dato{fields.length + (barcode ? 1 : 0) === 1 ? "" : "s"}
        </p>
      </div>

      {fields.length === 0 ? (
        <p className="px-4 py-3 text-sm text-white/55">
          No hay detalle adicional para mostrar.
        </p>
      ) : (
        fields.flatMap((field) => {
          const row = (
            <div
              key={`${log.id}-${field}`}
              className={`grid gap-3 border-b border-white/7 px-4 py-3 last:border-b-0 ${
                log.action === "UPDATE" ? "lg:grid-cols-3" : "lg:grid-cols-[0.45fr_1fr]"
              }`}
            >
              <p className="text-sm font-bold text-white">
                {getHumanFieldName(field)}
              </p>

              {log.action === "UPDATE" ? (
                <>
                  <p className="wrap-break-word text-sm text-white/65">
                    <span className="mr-2 text-white/35">Antes:</span>
                    {resolveFieldDisplayValue(field, log.before_data?.[field], maps, "before")}
                  </p>
                  <p className="wrap-break-word text-sm text-white/80">
                    <span className="mr-2 text-white/35">Después:</span>
                    {resolveFieldDisplayValue(field, log.after_data?.[field], maps, "after")}
                  </p>
                </>
              ) : (
                <p className="wrap-break-word text-sm text-white/80">
                  {resolveFieldDisplayValue(
                    field,
                    log.action === "DELETE" ? log.before_data?.[field] : log.after_data?.[field],
                    maps,
                    log.action === "DELETE" ? "before" : "after",
                  )}
                </p>
              )}
            </div>
          )

          if (field !== "sku" || !barcode) return [row]

          return [
            row,
            <div
              key={`${log.id}-codigo-barra`}
              className="grid gap-3 border-b border-white/7 px-4 py-3 last:border-b-0 lg:grid-cols-[0.45fr_1fr]"
            >
              <p className="text-sm font-bold text-white">Código de barras</p>
              <p className="wrap-break-word text-sm text-white/80">{barcode}</p>
            </div>,
          ]
        })
      )}

      {nonReversibleReason && (
        <p className="border-t border-white/7 px-4 py-3 text-xs leading-5 text-white/50">
          <span className="font-bold text-white/70">No reversible: </span>
          {nonReversibleReason}
        </p>
      )}

      <AuditTechnicalInfo log={log} />
    </div>
  )
}

function AuditGroupDetails({ group, maps }: { group: AuditLogGroup; maps: AuditEntityMaps }) {
  if (group.logs.length === 1) {
    return <AuditDetails log={group.primaryLog} maps={maps} />
  }

  return (
    <div className="mt-4 space-y-3">
      {group.logs.map((log) => (
        <div key={log.id}>
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-white/35">
            {formatAuditDescription(log, maps).title}
          </p>
          <AuditDetails log={log} maps={maps} />
        </div>
      ))}
    </div>
  )
}

export function AdminAuditoria() {
  const [logs, setLogs] = useState<SupabaseAuditLog[]>([])
  const [entityMaps, setEntityMaps] = useState<AuditEntityMaps>(emptyAuditEntityMaps)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [undoingId, setUndoingId] = useState<number | null>(null)
  const [pendingUndoGroup, setPendingUndoGroup] = useState<AuditLogGroup | null>(null)
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set())
  const [dateFromFilter, setDateFromFilter] = useState("")
  const [dateToFilter, setDateToFilter] = useState("")
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
      // Resolución de nombres humanos (producto/variante/categoría/usuario):
      // no bloquea el render de la lista, que ya es legible con los datos
      // congelados en cada evento; simplemente completa los casos donde
      // sólo hay un ID relacionado (imágenes, compras de stock, etc).
      void fetchAuditEntityMaps(data)
        .then(setEntityMaps)
        .catch(() => {})
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
    const fromDate = parseDateInput(dateFromFilter)
    const toDate = parseDateInput(dateToFilter, true)

    return adminLogs.filter((log) => {
      const createdAt = new Date(log.created_at)
      if (fromDate && createdAt < fromDate) return false
      if (toDate && createdAt > toDate) return false
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
    dateFromFilter,
    dateToFilter,
    onlyReversible,
    sectionFilter,
    severityFilter,
  ])

  const filteredGroups = useMemo(
    () => groupAuditLogs(filteredLogs),
    [filteredLogs],
  )

  const toggleGroupDetail = (groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const handleUndo = async () => {
    if (!pendingUndoGroup || !canUndoAuditGroup(pendingUndoGroup)) return

    try {
      setUndoingId(pendingUndoGroup.primaryLog.id)
      setError(null)
      for (const log of getAuditGroupUndoLogs(pendingUndoGroup)) {
        await undoAuditLog(log.id)
      }
      setPendingUndoGroup(null)
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
    <div className={adminPageClassName}>
      <AdminPageHeader eyebrow="Super admin" title="Auditoría" />

      <AdminSection
        title="Registro de actividad administrativa"
        description="Acciones realizadas por administradores dentro del panel. Los eventos normales de clientes, pagos y envíos quedan fuera de esta vista."
        actions={
          <span className="flex size-12 items-center justify-center rounded-xl border border-beyonix-blue-light/25 bg-beyonix-blue/20 text-beyonix-sky">
            <ShieldCheck className="size-5" />
          </span>
        }
      >
        <AdminFiltersBar className="mb-6">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-white/78">
            <Filter className="size-4 text-beyonix-sky" />
            Filtros
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-[146px_146px_minmax(220px,1fr)_minmax(176px,0.8fr)_minmax(150px,0.7fr)_minmax(150px,0.7fr)_minmax(160px,0.6fr)]">
            <AdminDatePicker
              title="Fecha desde"
              ariaLabel="Fecha desde"
              value={dateFromFilter}
              placeholder="Desde"
              onChange={setDateFromFilter}
            />

            <AdminDatePicker
              title="Fecha hasta"
              ariaLabel="Fecha hasta"
              value={dateToFilter}
              placeholder="Hasta"
              onChange={setDateToFilter}
            />

            <AdminSearchInput
              title="Filtrar por administrador"
              ariaLabel="Filtrar por administrador"
              value={adminFilter}
              placeholder="Usuario/admin"
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
        </AdminFiltersBar>

        {error && (
          <AdminInfoBlock
            tone="danger"
            icon={<AlertCircle className="size-5" />}
            className="mb-5"
          >
            {error}
          </AdminInfoBlock>
        )}

        {loading ? (
          <AdminSkeleton rows={4} />
        ) : filteredGroups.length === 0 ? (
          <AdminEmptyState
            icon={<History className="size-5" />}
            title="No hay acciones administrativas para los filtros seleccionados."
          />
        ) : (
          <div className="grid gap-1.5 lg:grid-cols-[minmax(80px,0.55fr)_minmax(180px,1.6fr)_minmax(150px,1fr)_minmax(0,3.2fr)_auto]">
            {filteredGroups.map((group) => {
              const log = group.primaryLog
              const isUndone = Boolean(log.undone_at)
              const description = formatAuditGroupDescription(group, entityMaps)
              const severity = getAuditGroupSeverity(group)
              const canUndo = canUndoAuditGroup(group)
              const isExpanded = expandedGroupIds.has(group.id)

              return (
                <article
                  key={group.id}
                  className="rounded-xl border border-white/7 bg-black px-3 py-2 transition hover:border-sky-300/35 hover:bg-admin-hover lg:col-span-5 lg:grid lg:grid-cols-subgrid lg:items-center lg:gap-x-4"
                >
                  <div className="text-xs leading-tight">
                    <p className="font-bold text-white">{formatAuditDate(log.created_at)}</p>
                    <p className="text-white/42">{formatAuditTime(log.created_at)}</p>
                  </div>

                  <p
                    className="truncate text-xs font-bold text-white/75"
                    title={log.actor_email ?? "Sistema"}
                  >
                    {log.actor_email ?? "Sistema"}
                  </p>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 lg:mt-0">
                    <span
                      title={`Importancia: ${getSeverityLabel(severity)}`}
                      className={`rounded-md border px-2 py-0.5 text-10px font-bold ${severityStyles[severity]}`}
                    >
                      {getAuditGroupDisplayAction(group)}
                    </span>
                    {isUndone && (
                      <span className="rounded-md border border-red-400/30 bg-red-500/10 px-1.5 py-0.5 text-10px font-bold text-red-200">
                        Deshecho
                      </span>
                    )}
                    {!isUndone && !canUndo && !isUndoAuditEvent(log) && (
                      <span
                        title={getAuditGroupNonReversibleReason(group) ?? undefined}
                        className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-10px font-bold text-white/40"
                      >
                        No reversible
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 min-w-0 lg:mt-0">
                    <p className="truncate text-sm font-bold text-white">{description.title}</p>
                    {description.lines[0] && (
                      <p className="truncate text-xs text-white/58">{description.lines[0]}</p>
                    )}
                  </div>

                  <div className="mt-1.5 flex items-center justify-start gap-2 lg:mt-0 lg:justify-end">
                    {canUndo && (
                      <AdminSecondaryButton
                        size="sm"
                        aria-label={`Deshacer movimiento ${log.id}`}
                        title="Deshacer movimiento"
                        disabled={undoingId === log.id}
                        onClick={() => setPendingUndoGroup(group)}
                      >
                        <RotateCcw className="size-3.5" />
                        {undoingId === log.id ? "Deshaciendo..." : "Deshacer"}
                      </AdminSecondaryButton>
                    )}

                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => toggleGroupDetail(group.id)}
                      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-11px font-bold text-sky-300 transition hover:text-white"
                    >
                      Detalle
                      <ChevronDown
                        className={`size-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="lg:col-span-5">
                      <AuditGroupDetails group={group} maps={entityMaps} />
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </AdminSection>

      {pendingUndoGroup && (
        <AdminModal
          open
          eyebrow="Confirmar acción"
          title="Deshacer movimiento"
          onClose={() => setPendingUndoGroup(null)}
          footer={
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <AdminSecondaryButton onClick={() => setPendingUndoGroup(null)}>
                Cancelar
              </AdminSecondaryButton>
              <AdminDangerButton
                onClick={() => void handleUndo()}
                disabled={undoingId === pendingUndoGroup.primaryLog.id || !canUndoAuditGroup(pendingUndoGroup)}
              >
                {undoingId === pendingUndoGroup.primaryLog.id ? "Deshaciendo..." : "Sí, estoy seguro"}
              </AdminDangerButton>
            </div>
          }
        >
          <div className="rounded-2xl border border-white/8 bg-black/30 px-4 py-4">
            {(() => {
              const pendingDescription = formatAuditGroupDescription(pendingUndoGroup, entityMaps)
              return (
                <>
                  <p className="text-sm font-bold leading-6 text-white">
                    ¿Está seguro de deshacer “{pendingDescription.lines[0] ?? pendingDescription.title}”?
                  </p>
                  <div className="mt-3 space-y-1 text-sm leading-6 text-white/55">
                    <p>{pendingDescription.title}</p>
                    {pendingDescription.lines.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                </>
              )
            })()}
          </div>
        </AdminModal>
      )}
    </div>
  )
}
