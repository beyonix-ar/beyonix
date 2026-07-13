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
import { adminControlClassName } from "../../components/admin-controls"

interface ProductSpecificationsEditorProps {
  productoId?: number
  draftSpecifications?: DraftProductoEspecificacion[]
  onDraftSpecificationsChange?: (
    specifications: DraftProductoEspecificacion[]
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
  adminControlClassName

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

  return (
    <div className="space-y-3">
      <div className="grid gap-2">
        <LucideIconPicker
          value={icono}
          onChange={setIcono}
        />

        <div>
          <input
            type="text"
            value={texto}
            placeholder="Sonido estereo de alta fidelidad"
            onChange={(event) => setTexto(event.target.value)}
            className={inputCls}
          />
        </div>

        <button
          type="button"
          aria-label={
            activo ? "Desactivar especificación" : "Activar especificación"
          }
          onClick={() => setActivo((current) => !current)}
          className="flex min-h-40px cursor-pointer items-center gap-3 rounded-xl border border-white/8 bg-[#181818] px-3.5 text-left transition-colors hover:border-[#112A43] hover:bg-[#112A43]"
        >
          {activo ? (
            <ToggleRight className="size-6 text-beyonix-cyan" />
          ) : (
            <ToggleLeft className="size-6 text-white/45" />
          )}
          <span className="text-sm text-white/80">
            {activo ? "Especificación activa" : "Especificación inactiva"}
          </span>
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label={
            editingSpecification
              ? "Guardar especificación"
              : "Agregar especificación"
          }
          onClick={saveSpecification}
          disabled={saving}
          className="inline-flex h-10 min-w-120px cursor-pointer items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-black transition-colors hover:bg-[#112A43] hover:text-white disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {editingSpecification ? "Guardar" : "Agregar"}
        </button>

        {editingSpecification && (
          <button
            type="button"
            aria-label="Cancelar edicion"
            onClick={resetFields}
            className="inline-flex h-10 min-w-110px cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#181818] px-4 text-sm text-white/70 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white"
          >
            <X className="size-4" />
            Cancelar
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex h-20 items-center justify-center text-white/45">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-2 border-t border-white/8 pt-3">
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
    <div className="rounded-xl border border-white/7 bg-[#181818] px-4 py-4 text-center">
      <p className="text-sm text-white/55">
        Todavia no hay especificaciones cargadas.
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
      className={`rounded-xl border bg-[#181818] px-3 py-2.5 ${
        draggedKey === dragKey
          ? "border-beyonix-sky"
          : "border-white/7"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-xl border border-white/8 text-white/45 active:cursor-grabbing">
            <GripVertical className="size-4" />
          </span>

          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-beyonix-sky/20 bg-beyonix-blue/35 text-beyonix-sky">
            <Icon className="size-4" />
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

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={
              activo ? "Desactivar especificación" : "Activar especificación"
            }
            onClick={onToggle}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/60 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white"
          >
            {activo ? (
              <ToggleRight className="size-4 text-beyonix-cyan" />
            ) : (
              <ToggleLeft className="size-4" />
            )}
          </button>

          <button
            type="button"
            aria-label="Editar especificación"
            onClick={onEdit}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/60 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white"
          >
            <Pencil className="size-4" />
          </button>

          <button
            type="button"
            aria-label="Eliminar especificación"
            onClick={onRemove}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/60 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
