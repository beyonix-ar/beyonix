"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  History,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react"

import { getAuditLogs, undoAuditLog } from "@/lib/supabase/queries/auditoria"
import type { SupabaseAuditLog } from "@/lib/supabase/types"

const tableLabels: Record<string, string> = {
  categorias: "Categorias",
  admin_events: "Eventos admin",
  imagenes_producto: "Imagenes",
  orden_items: "Items de pedido",
  ordenes: "Pedidos",
  producto_variantes: "Variantes",
  productos: "Productos",
  profiles: "Usuarios",
}

const actionLabels: Record<SupabaseAuditLog["action"], string> = {
  DELETE: "Elimino",
  INSERT: "Creo",
  UPDATE: "Edito",
}

const fieldLabels: Record<string, string> = {
  activo: "Estado",
  categoria_id: "Categoria",
  color_hex: "Color",
  descripcion: "Descripcion",
  destacado: "Destacado",
  descuento: "Descuento",
  estado: "Estado",
  last_sign_in_at: "Ultimo inicio",
  imagen_principal: "Imagen principal",
  imagenes: "Imagenes",
  nombre: "Nombre",
  orden: "Orden",
  precio: "Precio",
  precio_anterior: "Precio anterior",
  producto_id: "Producto",
  slug: "Slug",
  stock: "Stock",
  total: "Total",
  url: "Imagen",
  rol: "Permisos",
}

const ignoredFields = new Set(["created_at", "updated_at"])

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value))
}

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "boolean") return value ? "Si" : "No"
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`
  if (typeof value === "object") return JSON.stringify(value)

  return String(value)
}

function getChangedFields(log: SupabaseAuditLog) {
  if (log.action !== "UPDATE" || !log.before_data || !log.after_data) return []

  return Object.keys(log.after_data)
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => {
      const beforeValue = log.before_data?.[key]
      const afterValue = log.after_data?.[key]

      return JSON.stringify(beforeValue) !== JSON.stringify(afterValue)
    })
}

function getPreviewFields(log: SupabaseAuditLog) {
  const data = log.action === "DELETE" ? log.before_data : log.after_data
  if (!data) return []

  return Object.keys(data)
    .filter((key) => !ignoredFields.has(key))
    .filter((key) => data[key] !== null && data[key] !== undefined && data[key] !== "")
    .slice(0, 6)
}

function getSummary(log: SupabaseAuditLog) {
  if (log.action === "UPDATE") {
    const fields = getChangedFields(log)

    if (fields.length === 0) return "Actualizacion sin cambios visibles."

    return `Cambio: ${fields.map((field) => fieldLabels[field] ?? field).join(", ")}.`
  }

  const tableName = tableLabels[log.table_name] ?? log.table_name
  return `${actionLabels[log.action]} un registro en ${tableName}.`
}

function AuditDetails({ log }: { log: SupabaseAuditLog }) {
  const changedFields = useMemo(() => getChangedFields(log), [log])
  const previewFields = useMemo(() => getPreviewFields(log), [log])
  const fields = log.action === "UPDATE" ? changedFields : previewFields

  if (fields.length === 0) {
    return (
      <p className="mt-4 rounded-2xl border border-white/7 bg-black px-4 py-3 text-sm text-white/55">
        No hay detalle adicional para mostrar.
      </p>
    )
  }

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-white/7 bg-black">
      {fields.map((field) => (
        <div
          key={`${log.id}-${field}`}
          className="grid gap-3 border-b border-white/7 px-4 py-3 last:border-b-0 lg:grid-cols-3"
        >
          <p className="text-sm font-bold text-white">
            {fieldLabels[field] ?? field}
          </p>

          <p className="break-words text-sm text-white/65">
            <span className="mr-2 text-white/35">Antes:</span>
            {formatValue(log.before_data?.[field])}
          </p>

          <p className="break-words text-sm text-white/80">
            <span className="mr-2 text-white/35">Despues:</span>
            {formatValue(log.after_data?.[field])}
          </p>
        </div>
      ))}
    </div>
  )
}

export function AdminAuditoria() {
  const [logs, setLogs] = useState<SupabaseAuditLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [undoingId, setUndoingId] = useState<number | null>(null)

  const loadLogs = useCallback(async () => {
    try {
      setError(null)
      const data = await getAuditLogs()
      setLogs(data)
    } catch (err) {
      console.error(err)
      setError("No se pudo cargar la auditoria. Ejecuta primero 04-audit-logs.sql en Supabase.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const handleUndo = async (log: SupabaseAuditLog) => {
    const confirmed = window.confirm(
      "Vas a deshacer este cambio. Si depende de otros registros, Supabase puede rechazar la operacion. ¿Continuar?",
    )

    if (!confirmed) return

    try {
      setUndoingId(log.id)
      setError(null)
      await undoAuditLog(log.id)
      await loadLogs()
    } catch (err) {
      console.error(err)
      setError("No se pudo deshacer este cambio. Puede depender de otros registros relacionados.")
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
            Auditoria
          </h1>
        </div>

        <button
          type="button"
          aria-label="Actualizar registro de auditoria"
          title="Actualizar registro"
          onClick={() => {
            setLoading(true)
            void loadLogs()
          }}
          className="inline-flex min-h-48px min-w-140px items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white px-6 py-3 text-sm font-bold text-black transition hover:bg-white/90"
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
              Registro de actividad
            </h2>

            <p className="mt-1 text-sm text-white/65">
              Fecha, usuario, accion, tabla afectada y cambios detectados. Preparado para productos, stock, pedidos, permisos, admins y errores relevantes.
            </p>
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
        ) : logs.length === 0 ? (
          <div className="rounded-2xl border border-white/7 bg-black px-5 py-6">
            <div className="flex items-center gap-3 text-white/65">
              <History className="size-5" />

              <p className="text-sm">
                Todavia no hay movimientos registrados. Los cambios nuevos van a aparecer aca despues de ejecutar el SQL.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {logs.map((log) => {
              const tableName = tableLabels[log.table_name] ?? log.table_name
              const isUndone = Boolean(log.undone_at)

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
                        {formatDate(log.created_at)}
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
                          {actionLabels[log.action]}
                        </span>

                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold text-white/75">
                          {tableName}
                        </span>

                        {log.record_id && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-bold text-white/45">
                            ID {log.record_id}
                          </span>
                        )}

                        {isUndone && (
                          <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-200">
                            Deshecho
                          </span>
                        )}
                      </div>

                      <p className="mt-3 text-sm text-white/75">
                        {getSummary(log)}
                      </p>
                    </div>

                    <div className="flex justify-start xl:justify-end">
                      <button
                        type="button"
                        aria-label={`Deshacer movimiento ${log.id}`}
                        title="Deshacer movimiento"
                        disabled={isUndone || undoingId === log.id}
                        onClick={() => void handleUndo(log)}
                        className="inline-flex min-h-44px min-w-140px items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white px-5 py-2 text-sm font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35"
                      >
                        <RotateCcw className="size-4" />
                        {undoingId === log.id ? "Deshaciendo..." : "Deshacer"}
                      </button>
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
    </div>
  )
}
