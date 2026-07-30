"use client"

import {
  type PointerEvent,
  useEffect,
  useState,
} from "react"
import { createPortal } from "react-dom"
import Image from "next/image"

import {
  BadgePercent,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  GripVertical,
  Package,
  Pencil,
  Star,
  Trash2,
  X,
} from "lucide-react"

import type {
  SupabaseConditionedStock,
  SupabaseProductoVariante,
  SupabaseProducto,
} from "@/lib/supabase/types"
import type { StockSettings } from "@/lib/site-settings"
import { calculateInventoryStock } from "@/lib/inventory/stock-metrics"

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
import {
  deleteProductoImageByUrl,
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import { AdminProductPreviewModal } from "./admin-product-preview-modal"
import { DraftImageUploader } from "./draft-image-uploader"
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

const formatProductPrice = (value: number | null | undefined) => {
  const price = Number(value)
  const safePrice = Number.isFinite(price) ? Math.max(0, price) : 0
  return `$${safePrice.toLocaleString("es-AR")}`
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
  const [editVariantName, setEditVariantName] =
    useState("")
  const [editVariantSku, setEditVariantSku] =
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
  const [localPendingReviewDelta, setLocalPendingReviewDelta] =
    useState(0)
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
    setLocalPendingReviewDelta(0)
  }, [producto.conditioned_stock, producto.inventory_stock_summary])

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
    ? ""
    : producto.sku?.trim() || "—"

  const conditionedStockTotal = conditionedStock.reduce(
    (total, item) => total + item.quantity,
    0,
  )
  const normalStockTotal =
    producto.inventory_stock_summary?.normal ?? producto.stock
  const stockMetrics = calculateInventoryStock({
    normal: normalStockTotal,
    discounted: conditionedStockTotal,
    nonSellable: producto.inventory_stock_summary?.non_sellable,
    pendingReview:
      (producto.inventory_stock_summary?.pending_review ?? 0) +
      localPendingReviewDelta,
  })
  const physicalStockTotal = stockMetrics.physical
  const stockBreakdownTitle = [
    `${physicalStockTotal} ${
      physicalStockTotal === 1 ? "unidad física" : "unidades físicas"
    }`,
    `${normalStockTotal} normales`,
    `${conditionedStockTotal} con descuento`,
    `${stockMetrics.quarantine} en cuarentena`,
  ].join(" · ")
  const productStockStatus = stockStatus(normalStockTotal, stockSettings)

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
      active: boolean
      discountPercent: number
      discountReason: string
      nonSellableReason: string
      sourceVariantId: number | null
      conditionedName: string
      conditionedSku: string
      conditionedColor: string
      conditionedImages: string[]
      newImages: File[]
    },
  ) => {
    let uploadedImages: string[] = []
    try {
      setSavingConditionedId(item.id)
      setConditionedError("")
      uploadedImages = values.newImages.length
        ? await uploadProductoImages(
            producto.id,
            values.newImages,
            values.conditionedImages.length,
          )
        : []
      const nextItem = await updateConditionedStock(item.id, {
        active: values.active,
        discountPercent: values.discountPercent,
        discountReason: values.discountReason,
        nonSellableReason: values.nonSellableReason,
        sourceVariantId: values.sourceVariantId,
        conditionedName: values.conditionedName,
        conditionedSku: values.conditionedSku,
        conditionedColor: values.conditionedColor,
        conditionedImages: [
          ...values.conditionedImages,
          ...uploadedImages,
        ],
      })
      replaceConditionedStock(nextItem)
      setEditingConditionedStock(null)
    } catch (error) {
      await Promise.all(
        uploadedImages.map((image) =>
          deleteProductoImageByUrl(image).catch(() => undefined),
        ),
      )
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
      const result = await deleteConditionedStock(item.id)
      if (result?.archived) {
        replaceConditionedStock({ ...item, active: false })
      } else {
        setLocalConditionedStock((current) =>
          current.filter((currentItem) => currentItem.id !== item.id),
        )
        setLocalPendingReviewDelta((current) => current + item.quantity)
      }
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
    setVariantError("")
    setEditingVariantId(variante.id)
    setEditColor(variante.color_hex)
    setEditVariantName(variante.nombre)
    setEditVariantSku(variante.sku ?? "")
  }

  const cancelEditVariant = () => {
    setEditingVariantId(null)
    setEditColor("")
    setEditVariantName("")
    setEditVariantSku("")
  }

  const saveVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    const name = editVariantName.trim()
    const sku = editVariantSku.trim() || null
    const color = editColor.trim().toUpperCase()

    if (!name) {
      setVariantError("El nombre del color es obligatorio.")
      return
    }
    if (!/^#[0-9A-F]{6}$/.test(color)) {
      setVariantError("El color hexadecimal no es válido.")
      return
    }

    if (
      variante.nombre === name &&
      (variante.sku?.trim() || null) === sku &&
      variante.color_hex.toUpperCase() === color
    ) {
      cancelEditVariant()
      return
    }

    try {
      setSavingVariantId(variante.id)
      setVariantError("")
      const updated = await updateProductoVariante(
        producto.id,
        producto.id,
        variante.id,
        {
          nombre: name,
          sku,
          color_hex: color,
        },
      )

      const nextVariantes = variantes.map((item) =>
        item.id === updated.id
          ? updated
          : item,
      )

      setLocalVariantes(nextVariantes)
      await syncProductSummary(nextVariantes)
      cancelEditVariant()
    } catch (error) {
      setVariantError(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar la variante.",
      )
    } finally {
      setSavingVariantId(null)
    }
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
      await deleteProductoVariante(producto.id, variante.id)
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
            producto.id,
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
                  {conditionedStockTotal}{" "}
                  {conditionedStockTotal === 1
                    ? "unidad con descuento"
                    : "unidades con descuento"}
                </span>
              )}

              {stockMetrics.pendingReview > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-red-300/25 bg-red-400/10 px-2.5 py-0.5 text-xs font-semibold text-red-200">
                  <CircleAlert className="size-3" />
                  {stockMetrics.pendingReview} sin clasificar
                </span>
              )}

              {stockMetrics.nonSellable > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-orange-300/20 bg-orange-400/10 px-2.5 py-0.5 text-xs font-semibold text-orange-200">
                  <Package className="size-3" />
                  {stockMetrics.nonSellable} no vendible
                </span>
              )}

            </div>
          </div>
        </div>

        <span
          data-label="Cantidad"
          title={stockBreakdownTitle}
          aria-label={stockBreakdownTitle}
          className="inline-flex min-w-14 flex-col items-center justify-center justify-self-center text-center"
        >
          <span className="text-9px font-semibold leading-none text-white/38">
            Total:
          </span>
          <span
            className={`mt-1 text-sm font-black leading-none tabular-nums ${stockColor(
              physicalStockTotal,
              stockSettings,
            )}`}
          >
            {physicalStockTotal}
          </span>
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
          title={`${productStockStatus.label}: ${normalStockTotal} unidades normales, ${conditionedStockTotal} con descuento y ${stockMetrics.quarantine} en cuarentena.`}
          className={`inline-flex w-fit items-center justify-self-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-center text-10px font-black ${productStockStatus.className}`}
        >
          <span
            className={`size-1.5 rounded-full ${productStockStatus.dotClassName}`}
          />
          {productStockStatus.label}
        </span>

        <div data-label="Precio" className="justify-self-stretch text-center">
          <p className="text-base font-bold tabular-nums text-white">
            {formatProductPrice(producto.precio)}
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

                    {editing ? (
                      <input
                        type="text"
                        data-label="SKU"
                        value={editVariantSku}
                        maxLength={120}
                        placeholder="Sin SKU"
                        aria-label={`Editar SKU de ${variante.nombre}`}
                        onChange={(event) => setEditVariantSku(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveVariant(variante)
                          }
                          if (event.key === "Escape") cancelEditVariant()
                        }}
                        className="h-9 min-w-0 justify-self-stretch rounded-xl border border-beyonix-blue-light/20 bg-black/25 px-2 text-center text-xs font-bold text-white outline-none transition-colors placeholder:text-white/28 hover:border-beyonix-sky/40 focus:border-beyonix-sky/55"
                      />
                    ) : (
                      <span
                        data-label="SKU"
                        className="justify-self-stretch truncate text-center text-xs font-bold text-white/70"
                        title={variante.sku?.trim() || "Sin SKU"}
                      >
                        {variante.sku?.trim() || "—"}
                      </span>
                    )}

                    {editing ? (
                      <div
                        data-label="Color"
                        className="flex h-9 min-w-0 items-center gap-1.5 rounded-xl border border-beyonix-blue-light/20 bg-black/25 px-2 transition-colors hover:border-beyonix-sky/40 focus-within:border-beyonix-sky/55"
                      >
                        <label
                          title={`Seleccionar color (${editColor})`}
                          className="relative flex size-5 shrink-0 cursor-pointer items-center justify-center"
                        >
                          <span
                            className="size-4 rounded-full border border-white/28"
                            style={{ backgroundColor: editColor }}
                          />
                          <input
                            type="color"
                            value={editColor}
                            aria-label={`Seleccionar color de ${variante.nombre}`}
                            onChange={(event) => setEditColor(event.target.value)}
                            className="absolute inset-0 size-full cursor-pointer opacity-0"
                          />
                        </label>
                        <input
                          type="text"
                          value={editVariantName}
                          maxLength={160}
                          placeholder="Nombre del color"
                          title={`${editVariantName || "Sin nombre"} · ${editColor}`}
                          aria-label={`Editar nombre del color de ${variante.nombre}`}
                          onChange={(event) =>
                            setEditVariantName(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              void saveVariant(variante)
                            }
                            if (event.key === "Escape") cancelEditVariant()
                          }}
                          className="h-full w-full min-w-0 border-0 bg-transparent p-0 text-center text-xs font-bold text-white outline-none placeholder:text-white/28"
                        />
                      </div>
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
                        {formatProductPrice(producto.precio)}
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
                      {!editing && (
                        <button
                          type="button"
                          aria-label={`Ver variante ${variante.nombre}`}
                          onClick={() => viewVariant(variante)}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-blue-400/30 hover:text-blue-400"
                        >
                          <Eye className="size-3.5" />
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={savingVariantId === variante.id}
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
                        } disabled:cursor-wait disabled:opacity-50`}
                      >
                        {editing ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Pencil className="size-3.5" />
                        )}
                      </button>

                      {editing ? (
                        <button
                          type="button"
                          disabled={savingVariantId === variante.id}
                          aria-label={`Cancelar edición de ${variante.nombre}`}
                          title="Cancelar edición"
                          onClick={cancelEditVariant}
                          className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/55 transition-colors hover:border-white/20 hover:text-white disabled:cursor-wait disabled:opacity-50"
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : (
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
                      )}
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
              ) ?? (
                item.variant_id == null && variantes.length === 1
                  ? variantes[0]
                  : undefined
              )
              const conditionedName =
                item.conditioned_name?.trim() ||
                `${linkedVariant?.nombre || "Variante"} · Con descuento`
              const conditionedColorName =
                linkedVariant?.nombre?.trim() ||
                conditionedName.split("·", 1)[0]?.trim() ||
                "Sin color"
              const conditionedSku =
                item.conditioned_sku?.trim() || "SKU pendiente"
              const conditionedColor =
                item.conditioned_color_hex || linkedVariant?.color_hex || "#000000"
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
                          title={`${conditionedName} · ${item.reason || "Motivo pendiente"}`}
                        >
                          {conditionedName}
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
                    title={conditionedSku}
                  >
                    {conditionedSku}
                  </span>

                  <div
                    data-label="Color"
                    className="flex min-w-0 items-center justify-center gap-2"
                  >
                    <span
                      className="size-4 shrink-0 rounded-full border border-white/25"
                      style={{ backgroundColor: conditionedColor }}
                    />
                    <span
                      className="truncate text-xs font-bold text-white/70"
                      title={conditionedColorName}
                    >
                      {conditionedColorName}
                    </span>
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
                      {formatProductPrice(producto.precio)}
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
            key={editingConditionedStock.id}
            item={editingConditionedStock}
            productName={producto.nombre}
            productPrice={producto.precio}
            variants={variantes}
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
  productName,
  productPrice,
  variants,
  saving,
  error,
  onClose,
  onSave,
}: {
  item: SupabaseConditionedStock
  productName: string
  productPrice: number
  variants: SupabaseProductoVariante[]
  saving: boolean
  error: string
  onClose: () => void
  onSave: (values: {
    active: boolean
    discountPercent: number
    discountReason: string
    nonSellableReason: string
    sourceVariantId: number | null
    conditionedName: string
    conditionedSku: string
    conditionedColor: string
    conditionedImages: string[]
    newImages: File[]
  }) => Promise<void>
}) {
  const initialVariant =
    variants.find((variant) => variant.id === item.variant_id) ??
    (item.variant_id == null && variants.length === 1 ? variants[0] : null)
  const conditionedSuffix = item.id.replaceAll("-", "").slice(0, 8).toUpperCase()
  const suggestedSku = (variant: SupabaseProductoVariante | null) =>
    `${(variant?.sku?.trim() || "COND").slice(0, 96)}-DESC-${conditionedSuffix}`
  const [selectedVariantId, setSelectedVariantId] = useState(
    initialVariant ? String(initialVariant.id) : "",
  )
  const [conditionedName, setConditionedName] = useState(
    item.conditioned_name?.trim() ||
      `${initialVariant?.nombre || productName} · Con descuento`,
  )
  const [conditionedSku, setConditionedSku] = useState(
    item.conditioned_sku?.trim() || suggestedSku(initialVariant),
  )
  const [conditionedColor, setConditionedColor] = useState(
    item.conditioned_color_hex || initialVariant?.color_hex || "#000000",
  )
  const [conditionedImages, setConditionedImages] = useState<string[]>(
    item.conditioned_images.length
      ? item.conditioned_images
      : initialVariant?.imagenes ?? [],
  )
  const [newImages, setNewImages] = useState<File[]>([])
  const [active, setActive] = useState(item.active)
  const [discountPercent, setDiscountPercent] = useState(
    String(item.discount_percent),
  )
  const [discountReason, setDiscountReason] = useState(item.reason ?? "")
  const [nonSellableReason, setNonSellableReason] = useState(
    item.non_sellable_reason ?? "",
  )
  const parsedPercent = Number(discountPercent.replace(",", "."))
  const valid =
    Boolean(conditionedName.trim()) &&
    Boolean(conditionedSku.trim()) &&
    /^#[0-9A-F]{6}$/i.test(conditionedColor) &&
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

  const selectVariant = (value: string) => {
    setSelectedVariantId(value)
    const selected = variants.find((variant) => String(variant.id) === value)
    setConditionedName(
      `${selected?.nombre || productName} · Con descuento`,
    )
    setConditionedSku(suggestedSku(selected ?? null))
    setConditionedColor(selected?.color_hex ?? "#000000")
    setConditionedImages(selected?.imagenes ?? [])
    setNewImages([])
  }

  const submit = async () => {
    if (!valid || saving) return
    try {
      await onSave({
        active,
        discountPercent: parsedPercent,
        discountReason: discountReason.trim(),
        nonSellableReason: nonSellableReason.trim(),
        sourceVariantId: selectedVariantId
          ? Number(selectedVariantId)
          : null,
        conditionedName: conditionedName.trim(),
        conditionedSku: conditionedSku.trim(),
        conditionedColor: conditionedColor.toUpperCase(),
        conditionedImages,
        newImages,
      })
    } catch {
      // El mensaje se muestra dentro del modal.
    }
  }

  return (
    <AdminModal
      open
      wide
      eyebrow="Inventario con descuento"
      title="Editar variante con descuento"
      description="Es una oferta vendible separada, vinculada a la variante original y con stock condicionado propio."
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
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-amber-300/18 bg-amber-300/6 p-3">
            <p className="text-10px font-black uppercase tracking-wider text-amber-100/65">
              Stock propio
            </p>
            <p className="mt-1 text-xl font-black tabular-nums text-amber-200">
              {item.quantity}
            </p>
            {(item.sold_quantity > 0 ||
              item.original_quantity !== item.quantity) && (
              <p className="mt-1 text-9px font-semibold text-white/38">
                Inicial: {item.original_quantity} · Vendidas:{" "}
                {item.sold_quantity}
              </p>
            )}
          </div>
          <div className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
            <p className="text-10px font-black uppercase tracking-wider text-white/40">
              Precio original
            </p>
            <p className="mt-1 text-xl font-black tabular-nums text-white/65">
              {formatProductPrice(productPrice)}
            </p>
          </div>
          <div className="rounded-xl border border-emerald-300/16 bg-emerald-300/5 p-3">
            <p className="text-10px font-black uppercase tracking-wider text-emerald-100/55">
              Precio con descuento
            </p>
            <p className="mt-1 text-xl font-black tabular-nums text-emerald-300">
              {formatProductPrice(
                Math.max(
                  Math.round(
                    productPrice *
                      (1 -
                        (Number.isFinite(parsedPercent)
                          ? parsedPercent
                          : 0) /
                          100),
                  ),
                  0,
                ),
              )}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-beyonix-blue-light/16 bg-beyonix-blue/5 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-10px font-black uppercase tracking-wider text-beyonix-cyan/70">
              Identidad comercial condicionada
            </p>
            <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2 py-1 text-9px font-black uppercase tracking-wider text-amber-200">
              Variante con descuento
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label>
              <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-white/45">
                Vinculada a
              </span>
              <select
                value={selectedVariantId}
                onChange={(event) => selectVariant(event.target.value)}
                className={inputClass}
              >
                <option value="">Sin variante original</option>
                {variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.nombre}
                    {variant.sku?.trim() ? ` · ${variant.sku}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-white/45">
                Nombre / color
              </span>
              <input
                type="text"
                value={conditionedName}
                maxLength={160}
                onChange={(event) => setConditionedName(event.target.value)}
                placeholder="Negro · Con descuento"
                className={inputClass}
              />
            </label>

            <label>
              <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-white/45">
                SKU propio
              </span>
              <input
                type="text"
                value={conditionedSku}
                maxLength={120}
                onChange={(event) => setConditionedSku(event.target.value)}
                placeholder="AP01-DESC-..."
                className={inputClass}
              />
            </label>

            <label>
              <span className="mb-1.5 block text-10px font-black uppercase tracking-wider text-white/45">
                Color
              </span>
              <span className="flex h-11 items-center gap-2 rounded-xl border border-beyonix-blue-light/18 bg-[#07111B] px-2 focus-within:border-beyonix-sky/55">
                <span className="relative flex size-7 shrink-0 cursor-pointer items-center justify-center">
                  <span
                    className="size-5 rounded-full border border-white/25"
                    style={{ backgroundColor: conditionedColor }}
                  />
                  <input
                    type="color"
                    value={conditionedColor}
                    aria-label="Seleccionar color de la variante con descuento"
                    onChange={(event) => setConditionedColor(event.target.value)}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                  />
                </span>
                <span className="truncate text-xs font-bold uppercase text-white/65">
                  {conditionedColor}
                </span>
              </span>
            </label>
          </div>

          <p className="mt-2 text-10px font-semibold leading-4 text-white/38">
            Vincular copia los datos de referencia, pero esta oferta conserva su propio SKU, imágenes, precio y cantidad.
          </p>
        </div>

        <div className="rounded-xl border border-cyan-400/12 bg-cyan-400/3 p-3">
          <p className="mb-2 text-10px font-black uppercase tracking-wider text-cyan-100/55">
            Imágenes de la variante con descuento
          </p>
          {conditionedImages.length > 0 && (
            <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {conditionedImages.map((image, index) => (
                <div
                  key={`${image}-${index}`}
                  className="group relative aspect-square overflow-hidden rounded-xl border border-white/10 bg-black/30"
                >
                  <Image
                    src={image}
                    alt={`Imagen ${index + 1} de la variante con descuento`}
                    fill
                    sizes="(max-width: 640px) 33vw, 10rem"
                    className="object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Quitar imagen ${index + 1}`}
                    onClick={() =>
                      setConditionedImages((current) =>
                        current.filter((_, imageIndex) => imageIndex !== index),
                      )
                    }
                    className="absolute right-1.5 top-1.5 flex size-7 cursor-pointer items-center justify-center rounded-lg border border-red-400/25 bg-black/80 text-red-300 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <DraftImageUploader
            files={newImages}
            onChange={setNewImages}
            emptyMessage="Podés conservar las imágenes heredadas o cargar fotos específicas de la falla."
          />
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

        <button
          type="button"
          role="switch"
          aria-checked={active}
          onClick={() => setActive((current) => !current)}
          className={`flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left transition ${
            active
              ? "border-emerald-400/25 bg-emerald-400/9"
              : "border-white/10 bg-white/[0.025]"
          }`}
        >
          <span>
            <span className="block text-sm font-black text-white">
              Disponible para la venta
            </span>
            <span className="mt-0.5 block text-10px font-semibold leading-4 text-white/42">
              Al activarla se publica como una variante separada; no utiliza ni modifica el stock normal.
            </span>
          </span>
          <span
            className={`relative h-6 w-11 shrink-0 rounded-full border transition ${
              active
                ? "border-emerald-300/35 bg-emerald-400/30"
                : "border-white/15 bg-black/35"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4.5 rounded-full transition ${
                active
                  ? "left-5.5 bg-emerald-200"
                  : "left-0.5 bg-white/45"
              }`}
            />
          </span>
        </button>

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
                className="relative aspect-square overflow-hidden rounded-2xl border border-white/8 bg-white"
              >
                <Image
                  src={imagen}
                  alt={`${producto.nombre} ${variante.nombre} ${index + 1}`}
                  fill
                  sizes="(max-width: 768px) 33vw, 18rem"
                  className="object-cover"
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
