"use client"

import {
  useCallback,
  useEffect,
  useState,
} from "react"
import {
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
} from "lucide-react"

import type {
  SupabaseProductoEspecificacion,
} from "@/lib/supabase/types"

import type {
  DraftProductoEspecificacion,
} from "./types"

import {
  createProductoEspecificacion,
  deleteProductoEspecificacion,
  getProductoEspecificaciones,
  updateProductoEspecificacion,
  updateProductoEspecificacionesOrden,
} from "@/lib/supabase/queries/producto-especificaciones"

import {
  getFriendlyIconName,
  getLucideIcon,
  isAllowedLucideIcon,
  LucideIconPicker,
} from "./lucide-icon-picker"
import {
  adminControlClassName,
  AdminDangerButton,
  AdminInfoBlock,
  AdminPrimaryButton,
  AdminSecondaryButton,
} from "../../components/admin-controls"
interface ProductSpecificationsEditorProps {
  productoId?: number
  draftSpecifications?: DraftProductoEspecificacion[]
  onDraftSpecificationsChange?: (
    specifications: DraftProductoEspecificacion[]
  ) => void
  onPersistedSpecificationsChange?: (
    specifications: SupabaseProductoEspecificacion[]
  ) => void
}

type EditingSpecification =
  | {
      kind: "draft"
      id: string
    }
  | {
      kind: "persisted"
      id: number
    }
  | null

const inputCls =
  `${adminControlClassName} text-base`

function normalizeOrder(value: string, fallback: number) {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message)
  }

  return "Error desconocido."
}

function sortSpecifications<T extends { orden: number; id?: number }>(
  specifications: T[]
) {
  return [...specifications].sort((a, b) => {
    if (a.orden !== b.orden) return a.orden - b.orden
    return (a.id ?? 0) - (b.id ?? 0)
  })
}

function reorderDraftSpecifications(
  specifications: DraftProductoEspecificacion[]
) {
  return specifications.map((specification, index) => ({
    ...specification,
    orden: index + 1,
  }))
}

export function ProductSpecificationsEditor({
  productoId,
  draftSpecifications = [],
  onDraftSpecificationsChange,
  onPersistedSpecificationsChange,
}: ProductSpecificationsEditorProps) {
  const [specifications, setSpecifications] =
    useState<SupabaseProductoEspecificacion[]>([])
  const [icono, setIcono] = useState("")
  const [texto, setTexto] = useState("")
  const [orden, setOrden] = useState("1")
  const [draggedSpecificationKey, setDraggedSpecificationKey] =
    useState<string | null>(null)
  const [activo, setActivo] = useState(true)
  const [
    editingSpecification,
    setEditingSpecification,
  ] = useState<EditingSpecification>(null)
  const [loading, setLoading] = useState(Boolean(productoId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const loadSpecifications = useCallback(async () => {
    if (!productoId) {
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError("")

      const data = await getProductoEspecificaciones(productoId)
      setSpecifications(data)
      setOrden(String(data.length + 1))
    } catch (err) {
      console.error(err)
      setError("No se pudieron cargar las especificaciones.")
    } finally {
      setLoading(false)
    }
  }, [productoId])

  useEffect(() => {
    loadSpecifications()
  }, [loadSpecifications])

  useEffect(() => {
    if (productoId && !loading) {
      onPersistedSpecificationsChange?.(specifications)
    }
  }, [
    loading,
    onPersistedSpecificationsChange,
    productoId,
    specifications,
  ])

  const resetFields = () => {
    setIcono("")
    setTexto("")
    setOrden(
      String(
        productoId
          ? specifications.length + 1
          : draftSpecifications.length + 1
      )
    )
    setActivo(true)
    setEditingSpecification(null)
  }

  const saveSpecification = async () => {
    setError("")

    const cleanText = texto.trim()
    const cleanIcon = icono.trim()
    const nextOrder = normalizeOrder(
      orden,
      productoId ? specifications.length + 1 : draftSpecifications.length + 1
    )

    if (!cleanText) {
      setError("El texto de la especificación es obligatorio.")
      return
    }

    if (!cleanIcon) {
      setError("Elegí un ícono para la especificación.")
      return
    }

    if (!isAllowedLucideIcon(cleanIcon)) {
      setError("El ícono elegido no está permitido.")
      return
    }

    const nextSpecification = {
      icono: cleanIcon,
      texto: cleanText,
      orden: nextOrder,
      activo,
    }

    if (editingSpecification?.kind === "draft") {
      onDraftSpecificationsChange?.(
        sortSpecifications(
          draftSpecifications.map((specification) =>
            specification.tempId === editingSpecification.id
              ? {
                  ...specification,
                  ...nextSpecification,
                }
              : specification
          )
        )
      )

      resetFields()
      return
    }

    if (!productoId) {
      onDraftSpecificationsChange?.(
        sortSpecifications([
          ...draftSpecifications,
          {
            ...nextSpecification,
            tempId: crypto.randomUUID(),
          },
        ])
      )

      resetFields()
      return
    }

    if (!Number.isFinite(productoId) || productoId <= 0) {
      const message = `producto_id invalido: ${productoId}`
      console.error(message, {
        productoId,
        nextSpecification,
      })
      setError(message)
      return
    }

    try {
      setSaving(true)

      if (editingSpecification?.kind === "persisted") {
        const updated = await updateProductoEspecificacion(
          editingSpecification.id,
          nextSpecification
        )

        setSpecifications((current) =>
          sortSpecifications(
            current.map((specification) =>
              specification.id === updated.id ? updated : specification
            )
          )
        )
        resetFields()
        return
      }

      const created = await createProductoEspecificacion({
        producto_id: productoId,
        ...nextSpecification,
      })

      setSpecifications((current) =>
        sortSpecifications([...current, created])
      )
      resetFields()
    } catch (err) {
      const message = getErrorMessage(err)

      console.error("No se pudo guardar la especificación.", {
        error: err,
        productoId,
        payload: {
          producto_id: productoId,
          ...nextSpecification,
        },
      })
      setError(`No se pudo guardar la especificación: ${message}`)
    } finally {
      setSaving(false)
    }
  }

  const editDraftSpecification = (
    specification: DraftProductoEspecificacion
  ) => {
    setIcono(specification.icono)
    setTexto(specification.texto)
    setOrden(String(specification.orden))
    setActivo(specification.activo)
    setEditingSpecification({
      kind: "draft",
      id: specification.tempId,
    })
  }

  const editPersistedSpecification = (
    specification: SupabaseProductoEspecificacion
  ) => {
    setIcono(specification.icono)
    setTexto(specification.texto)
    setOrden(String(specification.orden))
    setActivo(specification.activo)
    setEditingSpecification({
      kind: "persisted",
      id: specification.id,
    })
  }

  const removeDraftSpecification = (tempId: string) => {
    onDraftSpecificationsChange?.(
      reorderDraftSpecifications(
        draftSpecifications.filter(
          (specification) => specification.tempId !== tempId
        )
      )
    )
  }

  const removePersistedSpecification = async (id: number) => {
    try {
      setError("")
      await deleteProductoEspecificacion(id)

      const nextSpecifications = reorderPersistedSpecifications(
        specifications.filter((specification) => specification.id !== id)
      )

      setSpecifications(nextSpecifications)
      await updateProductoEspecificacionesOrden(
        nextSpecifications.map((specification) => ({
          id: specification.id,
          orden: specification.orden,
        }))
      )
    } catch (err) {
      const message = getErrorMessage(err)
      console.error("No se pudo eliminar la especificación.", err)
      setError(`No se pudo eliminar la especificación: ${message}`)
    }
  }

  const toggleDraftSpecification = (
    specification: DraftProductoEspecificacion
  ) => {
    onDraftSpecificationsChange?.(
      draftSpecifications.map((item) =>
        item.tempId === specification.tempId
          ? {
              ...item,
              activo: !item.activo,
            }
          : item
      )
    )
  }

  const togglePersistedSpecification = async (
    specification: SupabaseProductoEspecificacion
  ) => {
    try {
      setError("")
      const updated = await updateProductoEspecificacion(specification.id, {
        activo: !specification.activo,
      })

      setSpecifications((current) =>
        current.map((item) =>
          item.id === updated.id ? updated : item
        )
      )
    } catch (err) {
      const message = getErrorMessage(err)
      console.error("No se pudo actualizar el estado.", err)
      setError(`No se pudo actualizar el estado: ${message}`)
    }
  }

  const moveDraftSpecification = (tempId: string, direction: number) => {
    const ordered = sortSpecifications(draftSpecifications)
    const currentIndex = ordered.findIndex(
      (specification) => specification.tempId === tempId
    )
    const nextIndex = currentIndex + direction

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ordered.length) {
      return
    }

    const nextSpecifications = [...ordered]
    const [item] = nextSpecifications.splice(currentIndex, 1)
    nextSpecifications.splice(nextIndex, 0, item)

    onDraftSpecificationsChange?.(
      reorderDraftSpecifications(nextSpecifications)
    )
  }

  const movePersistedSpecification = async (id: number, direction: number) => {
    const ordered = sortSpecifications(specifications)
    const currentIndex = ordered.findIndex(
      (specification) => specification.id === id
    )
    const nextIndex = currentIndex + direction

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ordered.length) {
      return
    }

    const nextSpecifications = [...ordered]
    const [item] = nextSpecifications.splice(currentIndex, 1)
    nextSpecifications.splice(nextIndex, 0, item)
    const reordered = reorderPersistedSpecifications(nextSpecifications)

    try {
      setSpecifications(reordered)
      await updateProductoEspecificacionesOrden(
        reordered.map((specification) => ({
          id: specification.id,
          orden: specification.orden,
        }))
      )
    } catch (err) {
      const message = getErrorMessage(err)
      console.error("No se pudo actualizar el orden.", err)
      setError(`No se pudo actualizar el orden: ${message}`)
      await loadSpecifications()
    }
  }

  const visibleDrafts = sortSpecifications(draftSpecifications)
  const visibleSpecifications = sortSpecifications(specifications)
  const visibleCount = productoId
    ? visibleSpecifications.length
    : visibleDrafts.length

  return (
    <section className="product-editor-panel min-w-0 rounded-xl border p-4">
      <div className="product-editor-panel-heading mb-3">
        <h2 className="text-base font-black text-white">Especificaciones</h2>
        <p className="mt-1 text-xs leading-5 text-white/44">
          Ícono, característica y estado visible en la tienda.
        </p>
      </div>

      <div className="grid min-w-0 items-start gap-3 2xl:grid-cols-[minmax(16rem,0.68fr)_minmax(0,1.32fr)]">
      <div className="product-editor-subpanel min-w-0 rounded-xl border p-3">
        <div className="mb-3 border-b border-white/8 pb-3">
          <h3 className="text-base font-black text-white">
            {editingSpecification ? "Editar especificación" : "Agregar especificación"}
          </h3>
        </div>

        <div className="grid min-w-0 gap-3">
        <div className="min-w-0">
          <p className="mb-2 text-sm font-black text-white/68">
            Ícono
          </p>
          <LucideIconPicker
            value={icono}
            onChange={setIcono}
          />
        </div>

        <label className="min-w-0">
          <span className="mb-2 block text-sm font-black text-white/68">
            Característica
          </span>
          <input
            type="text"
            value={texto}
            placeholder="Ej.: Sonido estéreo de alta fidelidad"
            onChange={(event) => setTexto(event.target.value)}
            className={inputCls}
          />
        </label>

      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-white/8 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <AdminSecondaryButton
          size="sm"
          aria-label={
            activo ? "Desactivar especificación" : "Activar especificación"
          }
          onClick={() => setActivo((current) => !current)}
          aria-pressed={activo}
          className="justify-start"
        >
          {activo ? (
            <ToggleRight className="size-5 text-white" />
          ) : (
            <ToggleLeft className="size-5 text-white/45" />
          )}
          <span className="text-xs text-white/80">
            {activo ? "Activa" : "Inactiva"}
          </span>
        </AdminSecondaryButton>

        <div className="flex gap-2">
        <AdminPrimaryButton
          size="sm"
          aria-label={
            editingSpecification
              ? "Guardar especificación"
              : "Agregar especificación"
          }
          onClick={saveSpecification}
          disabled={saving}
          className="flex-1 sm:flex-none"
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {editingSpecification ? "Guardar cambios" : "Agregar especificación"}
        </AdminPrimaryButton>

        {editingSpecification && (
          <AdminSecondaryButton
            size="sm"
            aria-label="Cancelar edición"
            onClick={resetFields}
            className="flex-1 sm:flex-none"
          >
            <X className="size-4" />
            Cancelar
          </AdminSecondaryButton>
        )}
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>
        </div>
      )}
      </div>

      <div className="product-editor-subpanel min-w-0 rounded-xl border p-3">
        <div className="mb-3 flex items-start justify-between gap-3 border-b border-white/8 pb-3">
          <div className="min-w-0">
            <h3 className="text-base font-black text-white">Características cargadas</h3>
            <p className="mt-1 text-xs leading-5 text-white/44">
              Arrastrá los elementos para definir el orden en la tienda.
            </p>
          </div>
          <span className="inline-flex shrink-0 rounded-md border border-white/12 bg-black/20 px-2.5 py-1 text-xs font-black text-white/70">
            {visibleCount}
          </span>
        </div>

        {loading ? (
        <div className="flex h-16 items-center justify-center text-white/45">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {productoId ? (
            visibleSpecifications.length ? (
              visibleSpecifications.map((specification, index) => (
                <SpecificationRow
                  key={specification.id}
                  icono={specification.icono}
                  texto={specification.texto}
                  orden={specification.orden}
                  activo={specification.activo}
                  dragKey={`persisted-${specification.id}`}
                  draggedKey={draggedSpecificationKey}
                  onDragStart={setDraggedSpecificationKey}
                  onDragEnd={() => setDraggedSpecificationKey(null)}
                  onDrop={() => {
                    if (!draggedSpecificationKey?.startsWith("persisted-")) {
                      return
                    }

                    const draggedId = Number(
                      draggedSpecificationKey.replace("persisted-", "")
                    )
                    const draggedIndex = visibleSpecifications.findIndex(
                      (item) => item.id === draggedId
                    )

                    if (draggedIndex >= 0) {
                      movePersistedSpecification(
                        draggedId,
                        index - draggedIndex
                      )
                    }

                    setDraggedSpecificationKey(null)
                  }}
                  onEdit={() => editPersistedSpecification(specification)}
                  onRemove={() =>
                    removePersistedSpecification(specification.id)
                  }
                  onToggle={() => togglePersistedSpecification(specification)}
                />
              ))
            ) : (
              <EmptySpecifications />
            )
          ) : visibleDrafts.length ? (
            visibleDrafts.map((specification, index) => (
              <SpecificationRow
                key={specification.tempId}
                icono={specification.icono}
                texto={specification.texto}
                orden={specification.orden}
                  activo={specification.activo}
                dragKey={`draft-${specification.tempId}`}
                draggedKey={draggedSpecificationKey}
                onDragStart={setDraggedSpecificationKey}
                onDragEnd={() => setDraggedSpecificationKey(null)}
                onDrop={() => {
                  if (!draggedSpecificationKey?.startsWith("draft-")) {
                    return
                  }

                  const draggedId = draggedSpecificationKey.replace("draft-", "")
                  const draggedIndex = visibleDrafts.findIndex(
                    (item) => item.tempId === draggedId
                  )

                  if (draggedIndex >= 0) {
                    moveDraftSpecification(
                      draggedId,
                      index - draggedIndex
                    )
                  }

                  setDraggedSpecificationKey(null)
                }}
                onEdit={() => editDraftSpecification(specification)}
                onRemove={() =>
                  removeDraftSpecification(specification.tempId)
                }
                onToggle={() => toggleDraftSpecification(specification)}
              />
            ))
          ) : (
            <EmptySpecifications />
          )}
        </div>
      )}
      </div>
      </div>
    </section>
  )
}

function reorderPersistedSpecifications(
  specifications: SupabaseProductoEspecificacion[]
) {
  return specifications.map((specification, index) => ({
    ...specification,
    orden: index + 1,
  }))
}

function EmptySpecifications() {
  return (
    <div className="product-editor-empty rounded-lg border border-dashed border-white/10 px-4 py-5 text-center">
      <p className="text-sm font-bold text-white/58">
        Todavía no hay especificaciones cargadas.
      </p>
      <p className="mt-1 text-xs text-white/38">
        Agregá la primera desde el formulario.
      </p>
    </div>
  )
}

interface SpecificationRowProps {
  icono: string
  texto: string
  orden: number
  activo: boolean
  dragKey: string
  draggedKey: string | null
  onDragStart: (key: string) => void
  onDragEnd: () => void
  onDrop: () => void
  onEdit: () => void
  onRemove: () => void
  onToggle: () => void
}

function SpecificationRow({
  icono,
  texto,
  orden,
  activo,
  dragKey,
  draggedKey,
  onDragStart,
  onDragEnd,
  onDrop,
  onEdit,
  onRemove,
  onToggle,
}: SpecificationRowProps) {
  const Icon = getLucideIcon(icono)

  return (
    <div
      draggable
      onDragStart={(event) => {
        onDragStart(dragKey)
        event.dataTransfer.effectAllowed = "move"
      }}
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
      className={`product-editor-spec-row rounded-lg border px-3 py-2.5 transition-colors ${
        draggedKey === dragKey
          ? "product-editor-spec-row-active border-white/35"
          : "border-white/8 hover:border-white/18 hover:bg-white/[0.03]"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-xl border border-white/8 text-white/45 active:cursor-grabbing">
            <GripVertical className="size-4" />
          </span>

          <span className="product-editor-icon-cell flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/12 text-white">
            <Icon className="size-4 text-white" />
          </span>

          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">
              {texto}
            </p>
            <p className="text-xs text-white/50">
              {`Orden ${orden} - ${getFriendlyIconName(icono)} - ${
                activo ? "Activo" : "Inactivo"
              }`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-white/7 pt-2.5 sm:border-0 sm:pt-0">
          <AdminSecondaryButton
            size="sm"
            aria-label={
              activo ? "Desactivar especificación" : "Activar especificación"
            }
            title={activo ? "Desactivar especificación" : "Activar especificación"}
            onClick={onToggle}
          >
            {activo ? (
              <ToggleRight className="size-4 text-white" />
            ) : (
              <ToggleLeft className="size-4" />
            )}
            {activo ? "Activa" : "Inactiva"}
          </AdminSecondaryButton>

          <AdminSecondaryButton
            size="sm"
            aria-label="Editar especificación"
            title="Editar especificación"
            onClick={onEdit}
          >
            <Pencil className="size-4" />
            Editar
          </AdminSecondaryButton>

          <AdminDangerButton
            size="sm"
            aria-label="Eliminar especificación"
            title="Eliminar especificación"
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
            Eliminar
          </AdminDangerButton>
        </div>
      </div>
    </div>
  )
}
