"use client"

import {
  type PointerEvent,
  useEffect,
  useState,
} from "react"

import {
  ChevronDown,
  ChevronRight,
  Eye,
  GripVertical,
  ImageIcon,
  Package,
  Pencil,
  Star,
  Trash2,
} from "lucide-react"

import type {
  SupabaseProductoVariante,
  SupabaseProducto,
} from "@/lib/supabase/types"

import {
  deleteProductoVariante,
  updateProductoVariante,
} from "@/lib/supabase/queries/producto-variantes"

import {
  updateProducto,
} from "@/lib/supabase/queries/productos"

import { AdminProductPreviewModal } from "./admin-product-preview-modal"
import { SITE_SETTINGS } from "@/config/site-settings"

interface ProductosRowProps {
  producto: SupabaseProducto
  isLast?: boolean
  onEdit: (
    producto: SupabaseProducto
  ) => void
  onDelete: (id: number) => void
  onToggleActivo: (
    producto: SupabaseProducto
  ) => void
}

const stockColor = (stock: number) => {
  if (stock <= 0) return "text-red-400"
  if (stock <= SITE_SETTINGS.stock.criticalStockThreshold) return "text-red-400"
  if (stock <= SITE_SETTINGS.stock.lowStockThreshold) return "text-amber-400"
  return "text-green-400"
}

const stockStatus = (stock: number) => {
  if (stock <= 0) {
    return {
      label: "Sin stock",
      className:
        "border-red-500/20 bg-red-500/10 text-red-400",
    }
  }

  if (stock <= SITE_SETTINGS.stock.criticalStockThreshold) {
    return {
      label: "Stock critico",
      className:
        "border-red-500/20 bg-red-500/10 text-red-400",
    }
  }

  if (stock <= SITE_SETTINGS.stock.lowStockThreshold) {
    return {
      label: "Stock bajo",
      className:
        "border-amber-500/20 bg-amber-500/10 text-amber-400",
    }
  }

  return {
    label: "Disponible",
    className:
      "border-green-500/20 bg-green-500/10 text-green-400",
  }
}

const getStockTotal = (
  producto: SupabaseProducto
) => {
  const variantes =
    producto.producto_variantes || []

  if (!variantes.length) {
    return producto.stock
  }

  return variantes.reduce(
    (total, variante) =>
      total + (variante.stock ?? 0),
    0
  )
}

const sortVariantes = (
  variantes: SupabaseProductoVariante[]
) =>
  [...variantes].sort((a, b) => {
    if (a.orden !== b.orden) {
      return a.orden - b.orden
    }

    return a.id - b.id
  })

const normalizeVariantOrder = (
  variantes: SupabaseProductoVariante[]
) =>
  sortVariantes(variantes).map(
    (variante, index) => ({
      ...variante,
      orden: index + 1,
    })
  )

const getPrincipalVariantImage = (
  variantes: SupabaseProductoVariante[]
) =>
  sortVariantes(variantes).flatMap(
    (variante) => variante.imagenes || []
  )[0] || null

const getInstallmentsLabel = (
  producto: SupabaseProducto
) => {
  if (
    producto.cuotas_sin_interes &&
    producto.cuotas_maximas === 3
  ) {
    return "3 cuotas"
  }

  if (
    producto.cuotas_sin_interes &&
    producto.cuotas_maximas === 6
  ) {
    return "6 cuotas"
  }

  return "Sin cuotas"
}

export function ProductosRow({
  producto,
  isLast,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosRowProps) {
  const [open, setOpen] =
    useState(false)

  const [editingVariantId, setEditingVariantId] =
    useState<number | null>(null)

  const [viewingVariant, setViewingVariant] =
    useState<SupabaseProductoVariante | null>(
      null
    )
  const [previewOpen, setPreviewOpen] =
    useState(false)

  const [editColor, setEditColor] =
    useState("")

  const [editStock, setEditStock] =
    useState("")

  const [localVariantes, setLocalVariantes] =
    useState<SupabaseProductoVariante[]>(
      producto.producto_variantes || []
    )
  const [localPrincipalImage, setLocalPrincipalImage] =
    useState<string | null>(
      producto.imagen_principal
    )
  const [draggedVariantId, setDraggedVariantId] =
    useState<number | null>(null)

  useEffect(() => {
    setLocalVariantes(
      sortVariantes(
        producto.producto_variantes || []
      )
    )
  }, [producto.producto_variantes])

  useEffect(() => {
    setLocalPrincipalImage(
      producto.imagen_principal
    )
  }, [producto.imagen_principal])

  useEffect(() => {
    return () => {
      document.body.style.cursor = ""
    }
  }, [])

  const variantes =
    sortVariantes(localVariantes)

  const stockTotal =
    variantes.length
      ? variantes.reduce(
          (total, variante) =>
            total +
            (variante.stock ?? 0),
          0
        )
      : getStockTotal(producto)

  const syncProductSummary = async (
    nextVariantes: SupabaseProductoVariante[]
  ) => {
    const total = nextVariantes.reduce(
      (acc, variante) =>
        acc + (variante.stock ?? 0),
      0
    )

    const imagenPrincipal =
      getPrincipalVariantImage(
        nextVariantes
      )

    setLocalPrincipalImage(
      imagenPrincipal
    )

    if (
      total === stockTotal &&
      imagenPrincipal === localPrincipalImage
    ) {
      return
    }

    await updateProducto(producto.id, {
      ...(total !== stockTotal
        ? {
            stock: total,
          }
        : {}),
      ...(imagenPrincipal !== localPrincipalImage
        ? {
            imagen_principal:
              imagenPrincipal,
          }
        : {}),
    })
  }

  const startEditVariant = (
    variante: SupabaseProductoVariante
  ) => {
    setEditingVariantId(variante.id)
    setEditColor(variante.color_hex)
    setEditStock(
      String(variante.stock ?? 0)
    )
  }

  const saveVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    const nextStock =
      Number(editStock) || 0

    if (
      variante.color_hex === editColor &&
      (variante.stock ?? 0) === nextStock
    ) {
      setEditingVariantId(null)
      return
    }

    const updated =
      await updateProductoVariante(
        variante.id,
        {
          color_hex: editColor,
          stock: nextStock,
        }
      )

    const nextVariantes =
      variantes.map((item) =>
        item.id === updated.id
          ? updated
          : item
      )

    setLocalVariantes(nextVariantes)
    await syncProductSummary(
      nextVariantes
    )
    setEditingVariantId(null)
  }

  const removeVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    if (
      !confirm(
        `¿Eliminar variante ${variante.nombre}?`
      )
    ) {
      return
    }

    await deleteProductoVariante(
      variante.id
    )

    const nextVariantes =
      variantes.filter(
        (item) =>
          item.id !== variante.id
      )

    setLocalVariantes(nextVariantes)
    await syncProductSummary(
      nextVariantes
    )
  }

  const viewVariant = (
    variante: SupabaseProductoVariante
  ) => {
    setViewingVariant(variante)
  }

  const reorderVariant = async (
    draggedId: number,
    targetId: number
  ) => {
    const ordered =
      normalizeVariantOrder(variantes)
    const currentIndex =
      ordered.findIndex(
        (item) => item.id === draggedId
      )
    const targetIndex =
      ordered.findIndex(
        (item) => item.id === targetId
      )

    if (
      currentIndex < 0 ||
      targetIndex < 0 ||
      currentIndex === targetIndex
    ) {
      return
    }

    const previousVariantes =
      localVariantes
    const previousPrincipalImage =
      localPrincipalImage
    const reordered = [...ordered]
    const [selected] =
      reordered.splice(currentIndex, 1)

    reordered.splice(targetIndex, 0, selected)

    const nextVariantes =
      reordered.map(
        (item, index) => ({
          ...item,
          orden: index + 1,
        })
      )

    setLocalVariantes(nextVariantes)

    try {
      await Promise.all(
        nextVariantes.map((item) =>
          updateProductoVariante(
            item.id,
            {
              orden: item.orden,
            }
          )
        )
      )

      await syncProductSummary(
        nextVariantes
      )
    } catch (err) {
      console.error(err)
      setLocalVariantes(
        previousVariantes
      )
      setLocalPrincipalImage(
        previousPrincipalImage
      )
    }
  }

  const stopVariantReorder = () => {
    setDraggedVariantId(null)
    document.body.style.cursor = ""
  }

  const handleVariantPointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    varianteId: number
  ) => {
    event.preventDefault()
    setDraggedVariantId(varianteId)

    document.body.style.cursor = "grab"
    event.currentTarget.setPointerCapture(
      event.pointerId
    )
  }

  const handleVariantPointerUp = async (
    event: PointerEvent<HTMLButtonElement>
  ) => {
    event.preventDefault()

    const sourceId = draggedVariantId

    stopVariantReorder()

    if (
      event.currentTarget.hasPointerCapture(
        event.pointerId
      )
    ) {
      event.currentTarget.releasePointerCapture(
        event.pointerId
      )
    }

    if (
      sourceId === null ||
      !Number.isFinite(sourceId)
    ) {
      return
    }

    const target = document
      .elementFromPoint(
        event.clientX,
        event.clientY
      )
      ?.closest<HTMLElement>(
        "[data-variant-drop-id]"
      )

    const targetId = Number(
      target?.dataset.variantDropId
    )

    if (!Number.isFinite(targetId)) {
      return
    }

    await reorderVariant(
      sourceId,
      targetId
    )
  }

  return (
    <div
      className={`bg-black transition-colors hover:bg-admin-hover ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      <div className="grid grid-cols-admin-products items-center gap-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            title={
              variantes.length
                ? "Ver variantes"
                : "Sin variantes"
            }
            aria-label={
              variantes.length
                ? `Ver variantes de ${producto.nombre}`
                : `${producto.nombre} no tiene variantes`
            }
            onClick={() =>
              setOpen((value) => !value)
            }
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors cursor-pointer ${
              open
                ? "border-blue-400/60 bg-blue-400/10 text-white"
                : "border-white/20 bg-white/5 text-white/90 hover:border-blue-400/50 hover:bg-blue-400/10"
            }`}
          >
            {open ? (
              <ChevronDown className="size-5" />
            ) : (
              <ChevronRight className="size-5" />
            )}
          </button>

          <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/6 bg-white">
            {localPrincipalImage ? (
              <img
                alt={producto.nombre}
                src={localPrincipalImage}
                className="h-full w-full object-cover"
              />
            ) : (
              <ImageIcon className="size-4 text-black/20" />
            )}
          </div>

          <div className="min-w-0">
            <p className="truncate text-base font-bold text-white">
              {producto.nombre}
            </p>

            <div className="mt-1 flex flex-wrap items-center gap-2">
              {producto.destacado && (
                <span className="inline-flex items-center gap-1 rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/18 px-1.5 py-px text-8px font-semibold text-beyonix-cyan">
                  <Star className="size-2.5 fill-beyonix-cyan/70 text-beyonix-cyan" />
                  Destacado
                </span>
              )}

              {!!variantes.length && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-10px font-semibold text-white/60">
                  {variantes.length} variantes
                </span>
              )}

              <span
                className={`text-10px font-semibold ${stockColor(
                  stockTotal
                )}`}
              >
                Stock: {stockTotal}
              </span>
            </div>
          </div>
        </div>

        <span className="truncate text-base font-bold text-white">
          {producto.categorias?.nombre ||
            "—"}
        </span>

        <div>
          <p className="text-base font-bold tabular-nums text-white">
            $
            {producto.precio.toLocaleString(
              "es-AR"
            )}
          </p>

          {!!producto.precio_anterior && (
            <p className="text-10px tabular-nums text-white/40 line-through">
              $
              {producto.precio_anterior.toLocaleString(
                "es-AR"
              )}
            </p>
          )}

          {!!producto.descuento && (
            <p className="mt-0.5 text-10px font-semibold text-green-400">
              -{producto.descuento}% OFF
            </p>
          )}
        </div>

        <span
          className={`w-fit justify-self-center rounded-full border px-2.5 py-1 text-11px font-semibold ${
            producto.cuotas_sin_interes
              ? "border-beyonix-blue-light/20 bg-beyonix-blue/18 text-beyonix-cyan"
              : "border-white/10 bg-white/5 text-white/45"
          }`}
        >
          {getInstallmentsLabel(producto)}
        </span>

        <button
          type="button"
          title={
            producto.activo
              ? "Desactivar producto"
              : "Activar producto"
          }
          aria-label={
            producto.activo
              ? "Desactivar producto"
              : "Activar producto"
          }
          onClick={() =>
            onToggleActivo(producto)
          }
          className={`inline-flex w-fit justify-self-center items-center gap-1.5 rounded-full border px-2.5 py-1 text-11px font-semibold transition-colors cursor-pointer ${
            producto.activo
              ? "border-green-500/20 bg-green-500/10 text-green-400"
              : "border-white/10 bg-white/5 text-white/45"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${
              producto.activo
                ? "bg-green-400"
                : "bg-white/25"
            }`}
          />

          {producto.activo
            ? "Activo"
            : "Inactivo"}
        </button>

        <div className="flex items-center justify-end gap-1.5 pr-2">
          <button
            type="button"
            title="Ver producto"
            aria-label={`Ver producto ${producto.nombre}`}
            onClick={() => setPreviewOpen(true)}
            className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-blue-400/30 hover:text-blue-400 cursor-pointer"
          >
            <Package className="size-3.5" />
          </button>

          <button
            type="button"
            title="Editar"
            aria-label="Editar"
            onClick={() =>
              onEdit(producto)
            }
            className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-white/20 hover:text-white cursor-pointer"
          >
            <Pencil className="size-3.5" />
          </button>

          <button
            type="button"
            title="Eliminar"
            aria-label="Eliminar"
            onClick={() =>
              onDelete(producto.id)
            }
            className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-red-500/30 hover:text-red-400 cursor-pointer"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-white/5 bg-black px-5 py-4">
          <div className="grid gap-2">
            {variantes.length ? (
              variantes.map((variante, index) => {
              const stock =
                variante.stock ?? 0

              const status =
                stockStatus(stock)
              const isPrincipal =
                index === 0

              return (
                <div
                  key={variante.id}
                  data-variant-drop-id={
                    variante.id
                  }
                  className="grid grid-cols-[2.5rem_1fr] items-stretch gap-3"
                >
                  <div className="flex items-center justify-center">
                    {variantes.length > 1 ? (
                      <button
                        type="button"
                        title="Arrastrar para reordenar variante"
                        aria-label={`Reordenar variante ${variante.nombre}`}
                        onPointerDown={(event) =>
                          handleVariantPointerDown(
                            event,
                            variante.id
                          )
                        }
                        onPointerUp={
                          handleVariantPointerUp
                        }
                        onPointerCancel={
                          stopVariantReorder
                        }
                        className={`flex size-9 cursor-grab items-center justify-center rounded-xl border text-white/45 transition-colors active:cursor-grab ${
                          draggedVariantId ===
                          variante.id
                            ? "border-beyonix-blue-light/40 bg-beyonix-blue/20 text-beyonix-cyan"
                            : "border-white/8 bg-white/5 hover:border-beyonix-blue-light/30 hover:text-beyonix-cyan"
                        }`}
                      >
                        <GripVertical className="size-4" />
                      </button>
                    ) : (
                      <span className="size-9" />
                    )}
                  </div>

                  <div className="grid grid-cols-admin-variant-row items-center gap-3 rounded-2xl border border-white/7 bg-black px-4 py-3">
                    <div className="flex items-center gap-3">
                    <span
                      className="size-5 rounded-full border border-white/20"
                      style={{
                        backgroundColor:
                          variante.color_hex,
                      }}
                    />

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-white">
                          {variante.nombre}
                        </p>

                        {isPrincipal && (
                          <span className="rounded-full border border-beyonix-blue-light/25 bg-beyonix-blue/20 px-2 py-0.5 text-10px font-semibold text-beyonix-cyan">
                            Principal
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-white/50">
                        {variante.color_hex}
                      </p>
                    </div>
                  </div>

                  {editingVariantId ===
                  variante.id ? (
                    <>
                      <input
                        min="0"
                        type="number"
                        title="Editar stock"
                        value={editStock}
                        aria-label={`Editar stock de ${variante.nombre}`}
                        onChange={(event) =>
                          setEditStock(
                            event.target.value
                          )
                        }
                        className="h-9 rounded-xl border border-white/10 bg-black px-3 text-sm text-white outline-none focus:border-blue-400"
                      />

                      <input
                        type="color"
                        title="Editar color"
                        value={editColor}
                        aria-label={`Editar color de ${variante.nombre}`}
                        onChange={(event) =>
                          setEditColor(
                            event.target.value
                          )
                        }
                        className="h-9 w-14 cursor-pointer rounded-xl border border-white/10 bg-black p-1"
                      />

                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          title="Guardar variante"
                          aria-label={`Guardar variante ${variante.nombre}`}
                          onClick={() =>
                            saveVariant(
                              variante
                            )
                          }
                          className="h-9 min-w-90px rounded-xl bg-white px-4 text-xs font-semibold text-black transition-colors hover:bg-white/90 cursor-pointer"
                        >
                          Guardar
                        </button>

                        <button
                          type="button"
                          title="Cancelar edición"
                          aria-label="Cancelar edición"
                          onClick={() =>
                            setEditingVariantId(
                              null
                            )
                          }
                          className="h-9 min-w-90px rounded-xl border border-white/10 px-4 text-xs font-semibold text-white/70 transition-colors hover:text-white cursor-pointer"
                        >
                          Cancelar
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span
                        className={`text-sm font-semibold ${stockColor(
                          stock
                        )}`}
                      >
                        Stock: {stock}
                      </span>

                      <span
                        className={`w-fit rounded-full border px-2.5 py-1 text-10px font-semibold ${status.className}`}
                      >
                        {status.label}
                      </span>

                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          title="Ver variante"
                          aria-label={`Ver variante ${variante.nombre}`}
                          onClick={() =>
                            viewVariant(
                              variante
                            )
                          }
                          className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-blue-400/30 hover:text-blue-400 cursor-pointer"
                        >
                          <Eye className="size-3.5" />
                        </button>

                        <button
                          type="button"
                          title="Editar variante"
                          aria-label={`Editar variante ${variante.nombre}`}
                          onClick={() =>
                            startEditVariant(
                              variante
                            )
                          }
                          className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-white/20 hover:text-white cursor-pointer"
                        >
                          <Pencil className="size-3.5" />
                        </button>

                        <button
                          type="button"
                          title="Eliminar variante"
                          aria-label={`Eliminar variante ${variante.nombre}`}
                          onClick={() =>
                            removeVariant(
                              variante
                            )
                          }
                          className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-red-500/30 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                  </div>
                </div>
              )
            })
            ) : (
              <div className="rounded-2xl border border-white/7 bg-black px-4 py-3">
                <p className="text-sm text-white/60">
                  Este producto no tiene variantes cargadas.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {viewingVariant && (
        <VariantModal
          producto={producto}
          variante={viewingVariant}
          onClose={() =>
            setViewingVariant(null)
          }
        />
      )}

      {previewOpen && (
        <AdminProductPreviewModal
          product={{
            ...producto,
            imagen_principal:
              localPrincipalImage,
            producto_variantes: variantes,
          }}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  )
}

interface VariantModalProps {
  producto: SupabaseProducto
  variante: SupabaseProductoVariante
  onClose: () => void
}

function VariantModal({
  producto,
  variante,
  onClose,
}: VariantModalProps) {
  const stock =
    variante.stock ?? 0

  const status =
    stockStatus(stock)

  const imagenes =
    variante.imagenes || []

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 px-6 py-8">
      <button
        type="button"
        title="Cerrar detalle de variante"
        aria-label="Cerrar detalle de variante"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />

      <div className="relative z-10 max-h-full w-full max-w-5xl overflow-y-auto rounded-3xl border border-white/10 bg-black p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="mb-1 text-10px font-semibold uppercase tracking-wide text-blue-300">
              Variante
            </p>

            <h2 className="text-2xl font-bold text-white">
              {producto.nombre} · {variante.nombre}
            </h2>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span
                className="size-6 rounded-full border border-white/20"
                style={{
                  backgroundColor:
                    variante.color_hex,
                }}
              />

              <span className="text-sm font-semibold text-white/70">
                {variante.color_hex}
              </span>

              <span
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${status.className}`}
              >
                {status.label}
              </span>

              <span
                className={`text-sm font-semibold ${stockColor(
                  stock
                )}`}
              >
                Stock: {stock}
              </span>
            </div>
          </div>

          <button
            type="button"
            title="Cerrar"
            aria-label="Cerrar"
            onClick={onClose}
            className="min-h-44px min-w-120px rounded-2xl border border-white/10 px-5 py-2 text-sm font-semibold text-white/70 transition-colors hover:text-white cursor-pointer"
          >
            Cerrar
          </button>
        </div>

        {imagenes.length ? (
          <div className="grid grid-cols-3 gap-4">
            {imagenes.map((imagen, index) => (
              <div
                key={`${imagen}-${index}`}
                className="overflow-hidden rounded-2xl border border-white/8 bg-white"
              >
                <img
                  src={imagen}
                  alt={`${producto.nombre} ${variante.nombre} ${index + 1}`}
                  className="aspect-square h-full w-full object-cover"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-white/8 bg-black px-5 py-10 text-center">
            <p className="text-sm text-white/55">
              Esta variante no tiene imágenes cargadas.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
