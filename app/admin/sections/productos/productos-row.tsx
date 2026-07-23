"use client"

import {
  type PointerEvent,
  useEffect,
  useState,
} from "react"
import { createPortal } from "react-dom"

import {
  Check,
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
import type { StockSettings } from "@/lib/site-settings"

import {
  deleteProductoVariante,
  updateProductoVariante,
} from "@/lib/supabase/queries/producto-variantes"

import {
  updateProducto,
} from "@/lib/supabase/queries/productos"

import { AdminProductPreviewModal } from "./admin-product-preview-modal"

interface ProductosRowProps {
  producto: SupabaseProducto
  stockSettings: StockSettings
  isLast?: boolean
  onEdit: (
    producto: SupabaseProducto
  ) => void
  onDelete: (id: number) => void
  onToggleActivo: (
    producto: SupabaseProducto
  ) => void
}

const stockColor = (stock: number, settings: StockSettings) => {
  if (stock <= 0) return "text-red-400"
  if (stock <= settings.criticalStockThreshold) return "text-red-400"
  if (stock <= settings.lowStockThreshold) return "text-amber-400"
  return "text-green-400"
}

const stockStatus = (stock: number, settings: StockSettings) => {
  if (stock <= 0) {
    return {
      label: "Sin stock",
      className:
        "border-red-400/35 bg-red-500/14 text-red-300 shadow-[0_0_16px_rgba(248,113,113,0.08)]",
      dotClassName: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]",
    }
  }

  if (stock <= settings.criticalStockThreshold) {
    return {
      label: "Stock crítico",
      className:
        "border-red-400/35 bg-red-500/14 text-red-300 shadow-[0_0_16px_rgba(248,113,113,0.08)]",
      dotClassName: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]",
    }
  }

  if (stock <= settings.lowStockThreshold) {
    return {
      label: "Stock bajo",
      className:
        "border-amber-400/35 bg-amber-500/14 text-amber-200 shadow-[0_0_16px_rgba(251,191,36,0.07)]",
      dotClassName: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)]",
    }
  }

  return {
    label: "Disponible",
    className:
      "border-emerald-400/30 bg-emerald-500/12 text-emerald-300",
    dotClassName: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]",
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
  stockSettings,
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
      className={`admin-product-row relative bg-black transition-colors ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      <div className="admin-product-row-grid relative z-[1] grid grid-cols-admin-products items-center gap-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
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
                <span className="inline-flex items-center gap-1.5 rounded-full border border-beyonix-blue-light/20 bg-beyonix-blue/18 px-2 py-0.5 text-xs font-semibold text-beyonix-cyan">
                  <Star className="size-3 fill-beyonix-cyan/70 text-beyonix-cyan" />
                  Destacado
                </span>
              )}

              {!!variantes.length && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-semibold text-white/65">
                  {variantes.length} variantes
                </span>
              )}

              <span
                className={`text-xs font-semibold ${stockColor(
                  stockTotal,
                  stockSettings,
                )}`}
              >
                Stock: {stockTotal}
              </span>
            </div>
          </div>
        </div>

        <span className="justify-self-stretch truncate text-center text-base font-bold text-white">
          {producto.categorias?.nombre ||
            "—"}
        </span>

        <div className="justify-self-stretch text-center">
          <p className="text-base font-bold tabular-nums text-white">
            $
            {producto.precio.toLocaleString(
              "es-AR"
            )}
          </p>

          {!!producto.precio_anterior && (
            <p className="text-xs tabular-nums text-white/45 line-through">
              $
              {producto.precio_anterior.toLocaleString(
                "es-AR"
              )}
            </p>
          )}

          {!!producto.descuento && (
            <p className="mt-0.5 text-xs font-semibold text-green-400">
              -{producto.descuento}% OFF
            </p>
          )}
        </div>

        <span
          className={`w-fit justify-self-center rounded-full border px-3 py-1.5 text-xs font-semibold ${
            producto.cuotas_sin_interes
              ? "border-beyonix-blue-light/20 bg-beyonix-blue/18 text-beyonix-cyan"
              : "border-white/10 bg-white/5 text-white/45"
          }`}
        >
          {getInstallmentsLabel(producto)}
        </span>

        <button
          type="button"
          aria-label={
            producto.activo
              ? "Desactivar producto"
              : "Activar producto"
          }
          onClick={() =>
            onToggleActivo(producto)
          }
          className={`inline-flex w-fit justify-self-center items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
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
            aria-label={`Ver producto ${producto.nombre}`}
            onClick={() => setPreviewOpen(true)}
            className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-blue-400/30 hover:text-blue-400 cursor-pointer"
          >
            <Package className="size-3.5" />
          </button>

          <button
            type="button"
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
                stockStatus(stock, stockSettings)
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

                  <div
                    className={`grid items-center gap-3 rounded-2xl border border-white/7 bg-black px-4 py-3 ${
                      editingVariantId === variante.id
                        ? "grid-cols-[minmax(0,1fr)_130px_170px_120px]"
                        : "grid-cols-admin-variant-row"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-white/35 bg-white/8 p-1">
                      <span
                        className="size-full rounded-full"
                        style={{
                          backgroundColor:
                            variante.color_hex,
                        }}
                      />
                    </span>

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
                        type="text"
                        inputMode="numeric"
                        value={editStock}
                        placeholder="Stock"
                        aria-label={`Editar stock de ${variante.nombre}`}
                        onChange={(event) =>
                          setEditStock(
                            event.target.value.replace(/\D/g, "")
                          )
                        }
                        className="h-10 w-full min-w-0 max-w-full rounded-xl border border-beyonix-blue-light/16 bg-[#07111b] px-3 text-center text-sm font-black text-white outline-none transition-colors placeholder:text-white/35 hover:border-beyonix-sky/35 focus:border-beyonix-sky/55"
                      />

                      <label className="relative flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-beyonix-blue-light/16 bg-[#07111b] px-3 transition-colors hover:border-beyonix-sky/40 hover:bg-beyonix-blue/12 focus-within:border-beyonix-sky/55">
                        <span
                          className="size-5 shrink-0 rounded-md border border-white/28 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
                          style={{ backgroundColor: editColor }}
                        />
                        <span className="text-xs font-bold uppercase text-white/68">
                          {editColor}
                        </span>
                        <input
                          type="color"
                          value={editColor}
                          aria-label={`Editar color de ${variante.nombre}`}
                          onChange={(event) =>
                            setEditColor(
                              event.target.value
                            )
                          }
                          className="absolute inset-0 size-full cursor-pointer opacity-0"
                        />
                      </label>

                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          aria-label={`Guardar variante ${variante.nombre}`}
                          onClick={() =>
                            saveVariant(
                              variante
                            )
                          }
                          className="inline-flex h-10 min-w-100px cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-sky/38 bg-beyonix-blue/28 px-4 text-xs font-black text-white transition-colors hover:border-beyonix-sky/65 hover:bg-beyonix-blue/42"
                        >
                          <Check className="size-4 text-emerald-300" />
                          Guardar
                        </button>

                      </div>
                    </>
                  ) : (
                    <>
                      <span
                        className={`text-sm font-semibold ${stockColor(
                          stock,
                          stockSettings,
                        )}`}
                      >
                        Stock: {stock}
                      </span>

                      <span
                        className={`inline-flex w-fit items-center justify-self-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-center text-xs font-black ${status.className}`}
                      >
                        <span className={`size-1.5 rounded-full ${status.dotClassName}`} />
                        {status.label}
                      </span>

                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
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

      {viewingVariant &&
        createPortal(
          <VariantModal
            producto={producto}
            variante={viewingVariant}
            stockSettings={stockSettings}
            onClose={() =>
              setViewingVariant(null)
            }
          />,
          document.body,
        )}

      {previewOpen &&
        createPortal(
          <AdminProductPreviewModal
            product={{
              ...producto,
              imagen_principal:
                localPrincipalImage,
              producto_variantes: variantes,
            }}
            onClose={() => setPreviewOpen(false)}
          />,
          document.body,
        )}
    </div>
  )
}

interface VariantModalProps {
  producto: SupabaseProducto
  variante: SupabaseProductoVariante
  stockSettings: StockSettings
  onClose: () => void
}

function VariantModal({
  producto,
  variante,
  stockSettings,
  onClose,
}: VariantModalProps) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  const stock =
    variante.stock ?? 0

  const status =
    stockStatus(stock, stockSettings)

  const imagenes =
    variante.imagenes || []

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 px-6 py-8">
      <button
        type="button"
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
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-white/35 bg-white/8 p-1">
                <span
                  className="size-full rounded-full"
                  style={{
                    backgroundColor:
                      variante.color_hex,
                  }}
                />
              </span>

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
                  stock,
                  stockSettings,
                )}`}
              >
                Stock: {stock}
              </span>
            </div>
          </div>

          <button
            type="button"
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
