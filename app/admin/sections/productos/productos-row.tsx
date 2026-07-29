"use client"

import {
  type PointerEvent,
  useEffect,
  useState,
} from "react"
import { createPortal } from "react-dom"

import {
  BadgePercent,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  GripVertical,
  Package,
  Pencil,
  Star,
  Trash2,
} from "lucide-react"

import type {
  SupabaseConditionedStock,
  SupabaseProductoVariante,
  SupabaseProducto,
} from "@/lib/supabase/types"
import type { StockSettings } from "@/lib/site-settings"

import {
  deleteProductoVariante,
  setProductoVarianteActivo,
  updateProductoVariante,
} from "@/lib/supabase/queries/producto-variantes"

import {
  deleteConditionedStock,
  updateProducto,
  updateConditionedStock,
} from "@/lib/supabase/queries/productos"

import { AdminProductPreviewModal } from "./admin-product-preview-modal"
import {
  AdminModal,
  AdminSecondaryButton,
} from "../../components/admin-controls"

interface ProductosRowProps {
  producto: SupabaseProducto
  stockSettings: StockSettings
  visualIndex: number
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
  visualIndex,
  isLast,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosRowProps) {
  const [open, setOpen] =
    useState(false)

  const [editingVariantId, setEditingVariantId] =
    useState<number | null>(null)
  const [savingVariantId, setSavingVariantId] =
    useState<number | null>(null)
  const [deletingVariantId, setDeletingVariantId] =
    useState<number | null>(null)
  const [pendingVariantDelete, setPendingVariantDelete] =
    useState<SupabaseProductoVariante | null>(null)
  const [variantError, setVariantError] =
    useState("")

  const [viewingVariant, setViewingVariant] =
    useState<SupabaseProductoVariante | null>(
      null
    )
  const [previewOpen, setPreviewOpen] =
    useState(false)

  const [editColor, setEditColor] =
    useState("")

  const [localVariantes, setLocalVariantes] =
    useState<SupabaseProductoVariante[]>(
      producto.producto_variantes || []
    )
  const [localConditionedStock, setLocalConditionedStock] =
    useState<SupabaseConditionedStock[]>(
      producto.conditioned_stock || [],
    )
  const [editingConditionedStock, setEditingConditionedStock] =
    useState<SupabaseConditionedStock | null>(null)
  const [savingConditionedId, setSavingConditionedId] =
    useState<string | null>(null)
  const [conditionedError, setConditionedError] =
    useState("")
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
    setLocalConditionedStock(
      producto.conditioned_stock || [],
    )
  }, [producto.conditioned_stock])

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
  const conditionedStock = localConditionedStock
  const primaryVariant = variantes[0]
  const hasDetails = variantes.length > 0 || conditionedStock.length > 0
  const skuTitle = variantes.length
    ? "Los SKU se muestran en cada variante"
    : producto.sku?.trim() || "Sin SKU"
  const skuDisplay = variantes.length
    ? "—"
    : producto.sku?.trim() || "—"

  const stockTotal =
    variantes.length
      ? variantes.reduce(
          (total, variante) =>
            total +
            (variante.stock ?? 0),
          0
        )
      : getStockTotal(producto)
  const productStockStatus = stockStatus(stockTotal, stockSettings)

  const replaceConditionedStock = (nextItem: SupabaseConditionedStock) => {
    setLocalConditionedStock((current) =>
      current.map((item) =>
        item.id === nextItem.id ? nextItem : item,
      ),
    )
  }

  const toggleConditionedStock = async (item: SupabaseConditionedStock) => {
    try {
      setSavingConditionedId(item.id)
      setConditionedError("")
      replaceConditionedStock(
        await updateConditionedStock(item.id, { active: !item.active }),
      )
    } catch (error) {
      setConditionedError(
        error instanceof Error
          ? error.message
          : "No se pudo cambiar el estado.",
      )
    } finally {
      setSavingConditionedId(null)
    }
  }

  const saveConditionedStock = async (
    item: SupabaseConditionedStock,
    values: {
      discountPercent: number
      discountReason: string
      nonSellableReason: string
    },
  ) => {
    try {
      setSavingConditionedId(item.id)
      setConditionedError("")
      replaceConditionedStock(
        await updateConditionedStock(item.id, values),
      )
      setEditingConditionedStock(null)
    } catch (error) {
      setConditionedError(
        error instanceof Error
          ? error.message
          : "No se pudo editar la unidad.",
      )
      throw error
    } finally {
      setSavingConditionedId(null)
    }
  }

  const removeConditionedStock = async (item: SupabaseConditionedStock) => {
    if (
      !window.confirm(
        "¿Quitar esta unidad del inventario con descuento? Quedará pendiente de clasificación y no se borrará el historial de la devolución.",
      )
    ) {
      return
    }

    try {
      setSavingConditionedId(item.id)
      setConditionedError("")
      await deleteConditionedStock(item.id)
      setLocalConditionedStock((current) =>
        current.filter((currentItem) => currentItem.id !== item.id),
      )
    } catch (error) {
      setConditionedError(
        error instanceof Error
          ? error.message
          : "No se pudo quitar la unidad.",
      )
    } finally {
      setSavingConditionedId(null)
    }
  }

  const syncProductSummary = async (
    nextVariantes: SupabaseProductoVariante[]
  ) => {
    const imagenPrincipal =
      getPrincipalVariantImage(
        nextVariantes
      )

    setLocalPrincipalImage(
      imagenPrincipal
    )

    if (
      imagenPrincipal === localPrincipalImage
    ) {
      return
    }

    await updateProducto(producto.id, {
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
  }

  const saveVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    if (variante.color_hex === editColor) {
      setEditingVariantId(null)
      return
    }

    const updated =
      await updateProductoVariante(
        variante.id,
        {
          color_hex: editColor,
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

  const toggleVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    const nextActive = variante.activo === false

    if (nextActive && !producto.activo) {
      setVariantError(
        "Activá primero el producto principal para habilitar sus variantes.",
      )
      return
    }

    try {
      setSavingVariantId(variante.id)
      setVariantError("")

      const updated = await setProductoVarianteActivo(
        producto.id,
        variante.id,
        nextActive,
      )

      setLocalVariantes((current) =>
        current.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      )
    } catch (error) {
      setVariantError(
        error instanceof Error
          ? error.message
          : "No se pudo cambiar el estado de la variante.",
      )
    } finally {
      setSavingVariantId(null)
    }
  }

  const removeVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    try {
      setDeletingVariantId(variante.id)
      setVariantError("")
      await deleteProductoVariante(variante.id)
    } catch (error) {
      setVariantError(
        error instanceof Error
          ? error.message
          : "No se pudo eliminar la variante.",
      )
      return
    } finally {
      setDeletingVariantId(null)
    }

    const nextVariantes =
      variantes.filter(
        (item) =>
          item.id !== variante.id
      )

    setLocalVariantes(nextVariantes)
    setPendingVariantDelete(null)

    try {
      await syncProductSummary(nextVariantes)
    } catch {
      setVariantError(
        "La variante se eliminó, pero no se pudo actualizar la imagen principal.",
      )
    }
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
        visualIndex % 2 === 0
          ? "admin-product-group-even"
          : "admin-product-group-odd"
      } ${open ? "admin-product-row-open" : ""} ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      <div className="admin-product-row-grid relative z-[1] grid grid-cols-admin-products items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label={
              hasDetails
                ? `Ver detalle de ${producto.nombre}`
                : `${producto.nombre} no tiene detalles`
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

          <div className="min-w-0">
            <p
              className="truncate text-sm font-bold text-white"
              title={producto.nombre}
            >
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

              {!!conditionedStock.length && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-0.5 text-xs font-semibold text-amber-200">
                  <BadgePercent className="size-3" />
                  {conditionedStock.reduce(
                    (total, item) => total + item.quantity,
                    0,
                  )} con descuento
                </span>
              )}

            </div>
          </div>
        </div>

        <span
          data-label="Cantidad"
          className={`justify-self-center text-sm font-black tabular-nums ${stockColor(
            stockTotal,
            stockSettings,
          )}`}
        >
          {stockTotal}
        </span>

        <span
          data-label="SKU"
          className="justify-self-stretch truncate text-center text-xs font-bold text-white/70"
          title={skuTitle}
        >
          {skuDisplay}
        </span>

        <div
          data-label="Color"
          className="flex min-w-0 items-center justify-center gap-2"
        >
          {primaryVariant ? (
            <>
              <span
                className="size-4 shrink-0 rounded-full border border-white/25"
                style={{ backgroundColor: primaryVariant.color_hex }}
              />
              <span
                className="truncate text-xs font-bold text-white/70"
                title={primaryVariant.nombre}
              >
                {primaryVariant.nombre}
              </span>
              {variantes.length > 1 && (
                <span className="shrink-0 text-10px font-bold text-white/35">
                  +{variantes.length - 1}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs font-bold text-white/35">—</span>
          )}
        </div>

        <span
          data-label="Stock"
          className={`inline-flex w-fit items-center justify-self-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-center text-10px font-black ${productStockStatus.className}`}
        >
          <span
            className={`size-1.5 rounded-full ${productStockStatus.dotClassName}`}
          />
          {productStockStatus.label}
        </span>

        <div data-label="Precio" className="justify-self-stretch text-center">
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
          <p className="mt-0.5 text-10px font-semibold text-white/38">
            {getInstallmentsLabel(producto)}
          </p>
        </div>

        <button
          type="button"
          data-label="Estado"
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

        <div className="admin-product-actions flex items-center justify-end gap-1.5 pr-2">
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
        <div className="admin-product-details border-t border-white/5 bg-black py-2">
          <div className="grid gap-1.5">
            {variantes.length ? (
              variantes.map((variante, index) => {
                const stock = variante.stock ?? 0
                const status = stockStatus(stock, stockSettings)
                const isPrincipal = index === 0
                const editing = editingVariantId === variante.id

                return (
                  <div
                    key={variante.id}
                    data-variant-drop-id={variante.id}
                    className="admin-product-variant-row grid grid-cols-admin-products items-center gap-3 rounded-xl border border-beyonix-blue-light/14 bg-[#07111b] px-4 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {variantes.length > 1 ? (
                        <button
                          type="button"
                          aria-label={`Reordenar variante ${variante.nombre}`}
                          onPointerDown={(event) =>
                            handleVariantPointerDown(event, variante.id)
                          }
                          onPointerUp={handleVariantPointerUp}
                          onPointerCancel={stopVariantReorder}
                          className={`flex size-9 shrink-0 cursor-grab items-center justify-center rounded-xl border text-white/45 transition-colors active:cursor-grabbing ${
                            draggedVariantId === variante.id
                              ? "border-beyonix-blue-light/40 bg-beyonix-blue/20 text-beyonix-cyan"
                              : "border-white/8 bg-black/30 hover:border-beyonix-blue-light/30 hover:text-beyonix-cyan"
                          }`}
                        >
                          <GripVertical className="size-4" />
                        </button>
                      ) : (
                        <span className="size-9 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p
                          className="truncate text-xs font-bold text-white"
                          title={`${producto.nombre} · ${variante.nombre}`}
                        >
                          {producto.nombre}
                        </p>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-10px font-semibold text-white/48">
                            Variante {variante.nombre}
                          </span>
                          {isPrincipal && (
                            <span className="shrink-0 rounded-full border border-beyonix-blue-light/25 bg-beyonix-blue/20 px-1.5 py-0.5 text-9px font-semibold text-beyonix-cyan">
                              Principal
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <span
                      data-label="Cantidad"
                      className={`justify-self-center text-sm font-black tabular-nums ${stockColor(
                        stock,
                        stockSettings,
                      )}`}
                    >
                      {stock}
                    </span>

                    <span
                      data-label="SKU"
                      className="justify-self-stretch truncate text-center text-xs font-bold text-white/70"
                      title={variante.sku?.trim() || "Sin SKU"}
                    >
                      {variante.sku?.trim() || "—"}
                    </span>

                    {editing ? (
                      <label
                        data-label="Color"
                        className="relative flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/20 bg-black/25 px-2 transition-colors hover:border-beyonix-sky/45 focus-within:border-beyonix-sky/55"
                      >
                        <span
                          className="size-4 shrink-0 rounded-full border border-white/28"
                          style={{ backgroundColor: editColor }}
                        />
                        <span className="truncate text-10px font-bold uppercase text-white/68">
                          {editColor}
                        </span>
                        <input
                          type="color"
                          value={editColor}
                          aria-label={`Editar color de ${variante.nombre}`}
                          onChange={(event) => setEditColor(event.target.value)}
                          className="absolute inset-0 size-full cursor-pointer opacity-0"
                        />
                      </label>
                    ) : (
                      <div
                        data-label="Color"
                        className="flex min-w-0 items-center justify-center gap-2"
                      >
                        <span
                          className="size-4 shrink-0 rounded-full border border-white/25"
                          style={{ backgroundColor: variante.color_hex }}
                        />
                        <span className="min-w-0 text-center">
                          <span className="block truncate text-xs font-bold text-white/70">
                            {variante.nombre}
                          </span>
                          <span className="block truncate text-9px font-semibold uppercase text-white/35">
                            {variante.color_hex}
                          </span>
                        </span>
                      </div>
                    )}

                    <span
                      data-label="Stock"
                      className={`inline-flex w-fit items-center justify-self-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-center text-10px font-black ${status.className}`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${status.dotClassName}`}
                      />
                      {status.label}
                    </span>

                    <div data-label="Precio" className="justify-self-stretch text-center">
                      <p className="text-sm font-bold tabular-nums text-white">
                        ${producto.precio.toLocaleString("es-AR")}
                      </p>
                      {!!producto.precio_anterior && (
                        <p className="text-10px tabular-nums text-white/38 line-through">
                          ${producto.precio_anterior.toLocaleString("es-AR")}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      data-label="Estado"
                      disabled={savingVariantId === variante.id}
                      aria-label={
                        variante.activo !== false
                          ? `Desactivar variante ${variante.nombre}`
                          : `Activar variante ${variante.nombre}`
                      }
                      title={
                        !producto.activo && variante.activo === false
                          ? "Activá primero el producto principal"
                          : variante.activo !== false
                            ? "Desactivar variante"
                            : "Activar variante"
                      }
                      onClick={() => void toggleVariant(variante)}
                      className={`inline-flex w-fit items-center justify-self-center gap-1.5 rounded-full border px-2.5 py-1 text-10px font-semibold ${
                        variante.activo !== false
                          ? "border-green-500/20 bg-green-500/10 text-green-400"
                          : "border-white/10 bg-white/5 text-white/45"
                      } cursor-pointer transition-colors hover:border-beyonix-sky/35 disabled:cursor-wait disabled:opacity-55`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          variante.activo !== false
                            ? "bg-green-400"
                            : "bg-white/25"
                        }`}
                      />
                      {savingVariantId === variante.id
                        ? "Guardando…"
                        : variante.activo !== false
                          ? "Activa"
                          : "Inactiva"}
                    </button>

                    <div className="admin-product-actions flex items-center justify-end gap-1.5 pr-2">
                      <button
                        type="button"
                        aria-label={`Ver variante ${variante.nombre}`}
                        onClick={() => viewVariant(variante)}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-blue-400/30 hover:text-blue-400"
                      >
                        <Eye className="size-3.5" />
                      </button>

                      <button
                        type="button"
                        aria-label={
                          editing
                            ? `Guardar variante ${variante.nombre}`
                            : `Editar variante ${variante.nombre}`
                        }
                        onClick={() =>
                          editing
                            ? void saveVariant(variante)
                            : startEditVariant(variante)
                        }
                        className={`flex size-8 cursor-pointer items-center justify-center rounded-xl border transition-colors ${
                          editing
                            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/18"
                            : "border-white/8 text-white/60 hover:border-white/20 hover:text-white"
                        }`}
                      >
                        {editing ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Pencil className="size-3.5" />
                        )}
                      </button>

                      <button
                        type="button"
                        aria-label={`Eliminar variante ${variante.nombre}`}
                        onClick={() => {
                          setVariantError("")
                          setPendingVariantDelete(variante)
                        }}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-red-500/30 hover:text-red-400"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })
            ) : conditionedStock.length ? null : (
              <div className="mx-4 rounded-xl border border-white/7 bg-[#07111b] px-4 py-3">
                <p className="text-sm text-white/60">
                  Este producto no tiene variantes cargadas.
                </p>
              </div>
            )}

            {conditionedError && (
              <div className="mx-4 rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs font-semibold text-red-200">
                {conditionedError}
              </div>
            )}

            {variantError && (
              <div className="mx-4 rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs font-semibold text-red-200">
                {variantError}
              </div>
            )}

            {conditionedStock.map((item) => {
              const linkedVariant = variantes.find(
                (variante) => variante.id === item.variant_id,
              )
              const conditionedPrice = Math.round(
                producto.precio * (1 - item.discount_percent / 100),
              )

              return (
                <div
                  key={`conditioned-${item.id}`}
                  className="admin-product-variant-row grid grid-cols-admin-products items-center gap-3 rounded-xl border border-amber-300/22 bg-[linear-gradient(90deg,rgba(245,158,11,0.08),rgba(7,17,27,0.96))] px-4 py-2.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-amber-300/20 bg-amber-300/10">
                      <BadgePercent className="size-4 text-white" />
                    </span>
                    <div className="min-w-0">
                      <p
                        className="truncate text-xs font-bold text-white"
                        title={`${producto.nombre} · Con detalles`}
                      >
                        {producto.nombre}
                      </p>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 rounded-full border border-amber-300/25 bg-amber-300/12 px-1.5 py-0.5 text-9px font-black text-amber-200">
                          {item.discount_percent}% OFF
                        </span>
                        <span
                          className="truncate text-10px font-semibold text-white/48"
                          title={item.reason || "Motivo pendiente"}
                        >
                          {item.reason || "Motivo pendiente"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <span
                    data-label="Cantidad"
                    className="justify-self-center text-sm font-black tabular-nums text-amber-300"
                  >
                    {item.quantity}
                  </span>

                  <span
                    data-label="SKU"
                    className="justify-self-stretch truncate text-center text-xs font-bold text-white/70"
                    title={linkedVariant?.sku?.trim() || "Sin SKU"}
                  >
                    {linkedVariant?.sku?.trim() || "—"}
                  </span>

                  <div
                    data-label="Color"
                    className="flex min-w-0 items-center justify-center gap-2"
                  >
                    {linkedVariant ? (
                      <>
                        <span
                          className="size-4 shrink-0 rounded-full border border-white/25"
                          style={{ backgroundColor: linkedVariant.color_hex }}
                        />
                        <span className="truncate text-xs font-bold text-white/70">
                          {linkedVariant.nombre}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs font-semibold text-white/35">—</span>
                    )}
                  </div>

                  <span
                    data-label="Stock"
                    className="inline-flex w-fit items-center justify-self-center gap-2 whitespace-nowrap rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-10px font-black text-amber-200"
                  >
                    <span className="size-1.5 rounded-full bg-amber-300" />
                    Con descuento
                  </span>

                  <div data-label="Precio" className="justify-self-stretch text-center">
                    <p className="text-sm font-bold tabular-nums text-amber-200">
                      ${conditionedPrice.toLocaleString("es-AR")}
                    </p>
                    <p className="text-10px tabular-nums text-white/38 line-through">
                      ${producto.precio.toLocaleString("es-AR")}
                    </p>
                  </div>

                  <button
                    type="button"
                    data-label="Estado"
                    disabled={savingConditionedId === item.id}
                    onClick={() => void toggleConditionedStock(item)}
                    className={`inline-flex w-fit cursor-pointer items-center justify-self-center gap-1.5 rounded-full border px-2.5 py-1 text-10px font-semibold transition disabled:cursor-wait disabled:opacity-50 ${
                      item.active
                        ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                        : "border-white/10 bg-white/5 text-white/45 hover:border-emerald-400/20 hover:text-white/70"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        item.active ? "bg-emerald-400" : "bg-white/25"
                      }`}
                    />
                    {item.active ? "Activa" : "Inactiva"}
                  </button>

                  <div className="admin-product-actions flex items-center justify-end gap-1.5 pr-2">
                    <button
                      type="button"
                      aria-label="Editar unidad con descuento"
                      disabled={savingConditionedId === item.id}
                      onClick={() => {
                        setConditionedError("")
                        setEditingConditionedStock(item)
                      }}
                      className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/65 transition-colors hover:border-beyonix-blue-light/30 hover:text-white disabled:cursor-wait disabled:opacity-40"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Eliminar unidad con descuento"
                      disabled={savingConditionedId === item.id}
                      onClick={() => void removeConditionedStock(item)}
                      className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-red-400/20 bg-red-400/7 text-red-300 transition-colors hover:border-red-400/40 hover:bg-red-400/12 disabled:cursor-wait disabled:opacity-40"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {pendingVariantDelete &&
        createPortal(
          <AdminModal
            open
            compact
            title="Eliminar variante"
            description="Esta acción es permanente."
            onClose={() => {
              if (!deletingVariantId) {
                setPendingVariantDelete(null)
                setVariantError("")
              }
            }}
            footer={
              <div className="flex items-center justify-end gap-2">
                <AdminSecondaryButton
                  disabled={deletingVariantId !== null}
                  onClick={() => {
                    setPendingVariantDelete(null)
                    setVariantError("")
                  }}
                >
                  Cancelar
                </AdminSecondaryButton>
                <button
                  type="button"
                  disabled={deletingVariantId !== null}
                  onClick={() => void removeVariant(pendingVariantDelete)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-400/25 bg-red-400/10 px-4 text-sm font-black text-red-200 transition hover:border-red-400/45 hover:bg-red-400/16 disabled:cursor-wait disabled:opacity-50"
                >
                  <Trash2 className="size-4" />
                  {deletingVariantId !== null ? "Eliminando…" : "Eliminar"}
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/30">
                <span
                  className="size-4 rounded-full border border-white/25"
                  style={{ backgroundColor: pendingVariantDelete.color_hex }}
                />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-white">
                  {pendingVariantDelete.nombre}
                </span>
                <span className="mt-0.5 block text-10px font-semibold uppercase tracking-wider text-white/38">
                  {pendingVariantDelete.sku?.trim() || "Sin SKU"}
                </span>
              </span>
            </div>

            {variantError && (
              <p className="mt-3 rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs font-semibold text-red-200">
                {variantError}
              </p>
            )}
          </AdminModal>,
          document.body,
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

      {editingConditionedStock &&
        createPortal(
          <ConditionedStockEditModal
            item={editingConditionedStock}
            saving={savingConditionedId === editingConditionedStock.id}
            error={conditionedError}
            onClose={() => {
              if (!savingConditionedId) {
                setEditingConditionedStock(null)
                setConditionedError("")
              }
            }}
            onSave={(values) =>
              saveConditionedStock(editingConditionedStock, values)
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

function ConditionedStockEditModal({
  item,
  saving,
  error,
  onClose,
  onSave,
}: {
  item: SupabaseConditionedStock
  saving: boolean
  error: string
  onClose: () => void
  onSave: (values: {
    discountPercent: number
    discountReason: string
    nonSellableReason: string
  }) => Promise<void>
}) {
  const [discountPercent, setDiscountPercent] = useState(
    String(item.discount_percent),
  )
  const [discountReason, setDiscountReason] = useState(item.reason ?? "")
  const [nonSellableReason, setNonSellableReason] = useState(
    item.non_sellable_reason ?? "",
  )
  const parsedPercent = Number(discountPercent.replace(",", "."))
  const valid =
    Number.isFinite(parsedPercent) &&
    parsedPercent > 0 &&
    parsedPercent < 100 &&
    Boolean(discountReason.trim()) &&
    (
      item.non_sellable_quantity === 0 ||
      Boolean(nonSellableReason.trim())
    )
  const inputClass =
    "h-11 w-full rounded-xl border border-beyonix-blue-light/18 bg-[#07111B] px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/25 focus:border-beyonix-sky/55"

  const submit = async () => {
    if (!valid || saving) return
    try {
      await onSave({
        discountPercent: parsedPercent,
        discountReason: discountReason.trim(),
        nonSellableReason: nonSellableReason.trim(),
      })
    } catch {
      // El mensaje se muestra dentro del modal.
    }
  }

  return (
    <AdminModal
      open
      eyebrow="Inventario con descuento"
      title="Editar unidad"
      description="Actualizá el descuento y documentá el estado físico del producto."
      onClose={onClose}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AdminSecondaryButton
            title="Cancelar edición"
            aria-label="Cancelar edición"
            disabled={saving}
            onClick={onClose}
          >
            Cancelar
          </AdminSecondaryButton>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={() => void submit()}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue/25 px-4 text-sm font-black text-white transition hover:bg-beyonix-blue/38 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="size-4" />
            {saving ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-amber-300/18 bg-amber-300/6 p-3">
          <p className="text-10px font-black uppercase tracking-wider text-amber-100/65">
            Cantidad condicionada
          </p>
          <p className="mt-1 text-xl font-black tabular-nums text-amber-200">
            {item.quantity}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <label>
            <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-white/45">
              Descuento
            </span>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                value={discountPercent}
                onChange={(event) =>
                  setDiscountPercent(
                    event.target.value.replace(/[^\d.,]/g, ""),
                  )
                }
                className={`${inputClass} pr-9 text-center font-black`}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-black text-amber-200">
                %
              </span>
            </div>
          </label>

          <label>
            <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-white/45">
              Motivo del descuento
            </span>
            <input
              type="text"
              value={discountReason}
              maxLength={300}
              onChange={(event) => setDiscountReason(event.target.value)}
              placeholder="Ej.: Tiene una marca"
              className={inputClass}
            />
          </label>
        </div>

        {item.non_sellable_quantity > 0 && (
          <label className="block rounded-xl border border-red-400/16 bg-red-400/5 p-3">
            <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-red-200/70">
              Motivo de no vendible
            </span>
            <input
              type="text"
              value={nonSellableReason}
              maxLength={300}
              onChange={(event) => setNonSellableReason(event.target.value)}
              placeholder="Ej.: Llegó completamente roto"
              className={inputClass}
            />
          </label>
        )}

        {error && (
          <p className="rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs font-semibold text-red-200">
            {error}
          </p>
        )}
      </div>
    </AdminModal>
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

              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/65">
                SKU: {variante.sku?.trim() || "sin SKU"}
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
