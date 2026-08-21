"use client"

import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useState,
} from "react"
import { createPortal } from "react-dom"
import Image from "next/image"

import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  GripVertical,
  ImageIcon,
  Merge,
  Pencil,
  SlidersHorizontal,
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
  firstUsableImage,
} from "@/lib/products/admin-product-visuals"
import {
  getVariantValue,
} from "@/lib/products/product-variants"
import {
  buildDiscountedSkuSuggestion,
  getColorName,
} from "@/lib/products/variant-color"

import {
  deleteProductoVariante,
  reorderProductoVariantes,
  setProductoVarianteActivo,
  updateProductoVariante,
} from "@/lib/supabase/queries/producto-variantes"

import {
  deleteConditionedStock,
  updateConditionedStock,
} from "@/lib/supabase/queries/productos"
import {
  deleteProductoImageByUrl,
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import { AdminProductPreviewModal } from "./admin-product-preview-modal"
import { DraftImageUploader } from "./draft-image-uploader"
import { AdminVariantItem } from "./admin-variant-item"
import { useStockAdjustment } from "./use-stock-adjustment"
import {
  AdminModal,
  AdminRowMenu,
  AdminSecondaryButton,
  type AdminRowMenuEntry,
} from "../../components/admin-controls"

interface ProductosRowProps {
  producto: SupabaseProducto
  stockSettings: StockSettings
  visualIndex: number
  isLast?: boolean
  isSuperAdmin: boolean
  onEdit: (
    producto: SupabaseProducto
  ) => void
  onDelete: (id: number) => void
  onMerge: (producto: SupabaseProducto) => void
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

const formatProductPrice = (value: number | null | undefined) => {
  const price = Number(value)
  const safePrice = Number.isFinite(price) ? Math.max(0, price) : 0
  return `$${safePrice.toLocaleString("es-AR")}`
}

function ProductThumbnail({
  image,
  alt,
  size = "md",
  tone = "normal",
}: {
  image: string | null
  alt: string
  size?: "sm" | "md"
  tone?: "normal" | "conditioned"
}) {
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-black/30 ${
        size === "sm" ? "size-9" : "size-10"
      } ${
        tone === "conditioned"
          ? "border-amber-300/25"
          : "border-white/10"
      }`}
    >
      {image ? (
        <Image
          src={image}
          alt={alt}
          fill
          sizes={size === "sm" ? "36px" : "40px"}
          className="object-cover"
        />
      ) : (
        <ImageIcon className="size-4 text-white/22" aria-hidden="true" />
      )}
    </span>
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

export function ProductosRow({
  producto,
  stockSettings,
  visualIndex,
  isLast,
  isSuperAdmin,
  onEdit,
  onDelete,
  onMerge,
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


  const [previewTarget, setPreviewTarget] =
    useState<{
      product: SupabaseProducto
      initialVariantValue?: string
    } | null>(null)

  const [editColor, setEditColor] =
    useState("")
  const [editColorName, setEditColorName] =
    useState("")
  const [editVariantSku, setEditVariantSku] =
    useState("")
  const [editBarcode, setEditBarcode] =
    useState("")
  const [pendingBarcodeConfirm, setPendingBarcodeConfirm] =
    useState<SupabaseProductoVariante | null>(null)

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
  const hasDetails = variantes.length > 0 || conditionedStock.length > 0
  const productImage = firstUsableImage(
    localPrincipalImage,
    [...(producto.imagenes_producto ?? [])]
      .sort((left, right) => left.orden - right.orden || left.id - right.id)
      .map((image) => image.url),
  )
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
  const categoryLabel = producto.categorias?.nombre?.trim() || "Sin categoría"
  const installmentsLabel =
    producto.cuotas_sin_interes && producto.cuotas_maximas
      ? `${producto.cuotas_maximas} cuotas sin interés`
      : "Sin cuotas"
  const commercialSubtitle = `${categoryLabel} · ${installmentsLabel}`
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

  const syncProductSummary = (
    nextVariantes: SupabaseProductoVariante[]
  ) => {
    const imagenPrincipal =
      getPrincipalVariantImage(
        nextVariantes
      )

    setLocalPrincipalImage(
      imagenPrincipal
    )

  }

  const startEditVariant = (
    variante: SupabaseProductoVariante
  ) => {
    setVariantError("")
    setEditingVariantId(variante.id)
    setEditColor(variante.color_hex)
    setEditColorName((variante.nombre ?? "").toUpperCase())
    setEditVariantSku((variante.sku ?? "").toUpperCase())
    setEditBarcode(variante.codigo_barra ?? "")
  }

  const cancelEditVariant = () => {
    setEditingVariantId(null)
    setEditColor("")
    setEditColorName("")
    setEditVariantSku("")
    setEditBarcode("")
    setPendingBarcodeConfirm(null)
  }

  const saveVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    const sku = editVariantSku.trim() || null
    const color = editColor.trim().toUpperCase()
    const colorName = editColorName.trim()
    const barcode = editBarcode.trim() || null

    if (!/^#[0-9A-F]{6}$/.test(color)) {
      setVariantError("El color hexadecimal no es válido.")
      return
    }
    if (!colorName) {
      setVariantError("El nombre del color no puede quedar vacío.")
      return
    }

    if (
      (variante.sku?.trim() || null) === sku &&
      variante.color_hex.toUpperCase() === color &&
      variante.nombre.trim() === colorName &&
      (variante.codigo_barra?.trim() || null) === barcode
    ) {
      cancelEditVariant()
      return
    }

    try {
      setSavingVariantId(variante.id)
      setVariantError("")
      const updated = await updateProductoVariante(
        producto.id,
        variante.id,
        {
          sku,
          codigo_barra: barcode,
          color_hex: color,
          nombre: colorName,
        },
      )

      const nextVariantes = variantes.map((item) =>
        item.id === updated.id
          ? updated
          : item,
      )

      setLocalVariantes(nextVariantes)
      syncProductSummary(nextVariantes)
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

  const requestSaveVariant = (variante: SupabaseProductoVariante) => {
    const barcode = editBarcode.trim() || null
    if (barcode !== (variante.codigo_barra?.trim() || null)) {
      setPendingBarcodeConfirm(variante)
      return
    }
    void saveVariant(variante)
  }

  const toggleVariant = async (
    variante: SupabaseProductoVariante
  ) => {
    const nextActive = variante.activo === false

    if (nextActive && !producto.activo) {
      setVariantError("No podés activar esta variante porque el producto está inactivo.")
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
      await deleteProductoVariante(producto.id, variante.id, {
        force: isSuperAdmin,
      })
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

    syncProductSummary(nextVariantes)
  }

  const { openStockAdjustment, stockAdjustmentModal } = useStockAdjustment(
    producto.id,
    (updated) => {
      const nextVariantes = localVariantes.map((item) =>
        item.id === updated.id ? updated : item
      )
      setLocalVariantes(nextVariantes)
      syncProductSummary(nextVariantes)
    },
  )

  const currentPreviewProduct = (
    previewVariants = variantes,
    previewConditionedStock = conditionedStock,
  ): SupabaseProducto => ({
    ...producto,
    imagen_principal: localPrincipalImage,
    producto_variantes: previewVariants,
    conditioned_stock: previewConditionedStock,
  })

  const viewProduct = () => {
    setPreviewTarget({ product: currentPreviewProduct() })
  }

  const viewVariant = (variante: SupabaseProductoVariante) => {
    const previewVariant = { ...variante, activo: true, orden: 1 }

    setPreviewTarget({
      product: currentPreviewProduct([previewVariant], []),
      initialVariantValue: getVariantValue(variante),
    })
  }

  const viewConditionedVariant = (
    item: SupabaseConditionedStock,
    linkedVariant?: SupabaseProductoVariante,
  ) => {
    const previewVariant: SupabaseProductoVariante = {
      id: linkedVariant?.id ?? producto.id,
      producto_id: producto.id,
      nombre:
        item.conditioned_name?.trim() || "Con descuento",
      sku:
        item.conditioned_sku?.trim() || linkedVariant?.sku?.trim() || "SKU pendiente",
      color_hex:
        item.conditioned_color_hex || linkedVariant?.color_hex || "#000000",
      stock: item.quantity,
      imagenes: item.conditioned_images.length
        ? item.conditioned_images
        : linkedVariant?.imagenes || [],
      activo: true,
      orden: 1,
      created_at: linkedVariant?.created_at || producto.created_at,
    }
    const discountPercent =
      item.discount_percent > 0 && item.discount_percent < 100
        ? item.discount_percent
        : 0
    const previewPrice = discountPercent
      ? Math.max(Math.round(producto.precio * (1 - discountPercent / 100)), 0)
      : producto.precio

    setPreviewTarget({
      product: {
        ...currentPreviewProduct([previewVariant], []),
        precio: previewPrice,
        precio_anterior: discountPercent ? producto.precio : producto.precio_anterior,
        descuento: discountPercent || producto.descuento,
      },
      initialVariantValue: getVariantValue(previewVariant),
    })
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
      const persistedOrder = await reorderProductoVariantes(
        producto.id,
        nextVariantes.map((item) => item.id),
      )
      setLocalVariantes(persistedOrder)
      syncProductSummary(persistedOrder)
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
      <div className="admin-product-row-grid admin-product-summary-row relative z-[1] grid grid-cols-admin-product-parent items-center gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label={
              hasDetails
                ? `Ver detalle de ${producto.nombre}`
                : `${producto.nombre} no tiene detalles`
            }
            title={hasDetails ? (open ? "Ocultar variantes" : "Mostrar variantes") : "Este producto todavía no tiene variantes"}
            disabled={!hasDetails}
            onClick={() => {
              if (hasDetails) setOpen((value) => !value)
            }}
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors cursor-pointer ${
              open
                ? "border-blue-400/60 bg-blue-400/10 text-white"
                : "border-white/20 bg-white/5 text-white/90 hover:border-blue-400/50 hover:bg-blue-400/10"
            } disabled:cursor-default disabled:border-white/7 disabled:text-white/20 disabled:hover:bg-white/5`}
          >
            {open ? (
              <ChevronDown className="size-5" />
            ) : (
              <ChevronRight className="size-5" />
            )}
          </button>

          <ProductThumbnail
            image={productImage}
            alt={`Imagen principal de ${producto.nombre}`}
          />

          <div className="min-w-0">
            <p
              className="truncate text-sm font-bold text-white"
              title={producto.nombre}
            >
              {producto.nombre}
            </p>

            <p className="mt-1 truncate text-10px text-white/38">
              {commercialSubtitle}
            </p>
          </div>
        </div>

        <span data-label="SKU" aria-hidden="true" />

        <span
          data-label="Cantidad"
          title={stockBreakdownTitle}
          aria-label={stockBreakdownTitle}
          className="inline-flex min-w-14 items-center justify-center justify-self-center text-center"
        >
          <span
            className={`text-base font-black leading-none tabular-nums ${stockColor(
              physicalStockTotal,
              stockSettings,
            )}`}
          >
            {physicalStockTotal}
          </span>
        </span>

        <span data-label="Color" aria-hidden="true" />

        <span
          data-label="Precio"
          className="justify-self-center text-center text-sm font-black tabular-nums text-white/82"
        >
          {formatProductPrice(producto.precio)}
        </span>

        <button
          type="button"
          data-label="Estado"
          title={producto.activo ? "Desactivar producto" : "Activar producto"}
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

        <div className="admin-product-actions flex items-center justify-center gap-1.5">
          <button
            type="button"
            aria-label={`Editar ${producto.nombre}`}
            title={`Editar ${producto.nombre}`}
            onClick={() =>
              onEdit(producto)
            }
            className="flex size-9 items-center justify-center rounded-xl border border-beyonix-sky/25 bg-beyonix-blue/10 text-beyonix-sky transition-colors hover:border-beyonix-sky/50 hover:bg-beyonix-blue/20 hover:text-white cursor-pointer"
          >
            <Pencil className="size-3.5" />
          </button>

          <AdminRowMenu
            ariaLabel={`Más acciones para ${producto.nombre}`}
            items={[
              {
                key: "ver",
                label: "Ver detalle",
                icon: <Eye className="size-3.5" />,
                onSelect: viewProduct,
              },
              ...(isSuperAdmin
                ? ([
                    {
                      key: "fusionar",
                      label: "Fusionar con otro producto",
                      icon: <Merge className="size-3.5" />,
                      onSelect: () => onMerge(producto),
                    },
                  ] satisfies AdminRowMenuEntry[])
                : []),
              { key: "divider-eliminar", divider: true },
              {
                key: "eliminar",
                label: "Eliminar",
                icon: <Trash2 className="size-3.5" />,
                tone: "danger",
                onSelect: () => onDelete(producto.id),
              },
            ]}
          />
        </div>
      </div>

      {open && (
        <div className="admin-product-details border-t border-white/5 bg-black py-3">
          {variantes.length > 0 && (
            <p className="mb-2 px-4 text-9px font-black uppercase tracking-widest text-white/28">
              Variantes de este producto
            </p>
          )}
          <div className="grid gap-1.5">
            {variantes.length ? (
              variantes.map((variante, index) => {
                const stock = variante.stock ?? 0
                const isPrincipal = index === 0
                const editing = editingVariantId === variante.id
                const commerciallyActive = producto.activo && variante.activo !== false

                if (!editing) {
                  return (
                    <AdminVariantItem
                      key={variante.id}
                      image={firstUsableImage(variante.imagenes, productImage)}
                      imageCount={variante.imagenes?.length ?? 0}
                      name={producto.nombre}
                      subtitle={isPrincipal ? "Variante principal" : undefined}
                      sku={variante.sku}
                      colorHex={variante.color_hex}
                      colorLabel={getColorName(variante.color_hex, variante.nombre)}
                      accentColor={variante.color_hex}
                      stock={stock}
                      stateLabel={
                        savingVariantId === variante.id
                          ? "Guardando…"
                            : commerciallyActive
                              ? "Activa"
                              : "Inactiva"
                      }
                      stateTone={commerciallyActive ? "active" : "inactive"}
                      stateDisabled={savingVariantId === variante.id}
                      onToggleState={() => void toggleVariant(variante)}
                      dropId={variante.id}
                      leadingAccessory={
                        variantes.length > 1 ? (
                          <button
                            type="button"
                            title="Arrastrar para cambiar el orden"
                            aria-label={`Reordenar variante ${variante.nombre}`}
                            data-variant-drop-id={variante.id}
                            onPointerDown={(event) => handleVariantPointerDown(event, variante.id)}
                            onPointerUp={handleVariantPointerUp}
                            onPointerCancel={stopVariantReorder}
                            className={`flex size-9 shrink-0 cursor-grab items-center justify-center rounded-lg border text-white/34 transition active:cursor-grabbing ${
                              draggedVariantId === variante.id
                                ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200"
                                : "border-white/7 hover:border-cyan-300/25 hover:text-cyan-200"
                            }`}
                          >
                            <GripVertical className="size-3.5" />
                          </button>
                        ) : (
                          <span aria-hidden="true" className="size-9 shrink-0" />
                        )
                      }
                      actions={
                        <>
                          <button
                            type="button"
                            title={`Editar únicamente ${variante.nombre}`}
                            aria-label={`Editar variante ${variante.nombre}`}
                            onClick={() => startEditVariant(variante)}
                            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-beyonix-sky/22 bg-beyonix-blue/8 text-beyonix-sky transition hover:border-beyonix-sky/45 hover:text-white"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <AdminRowMenu
                            ariaLabel={`Más acciones para la variante ${variante.nombre}`}
                            triggerClassName="size-8 rounded-lg"
                            items={[
                              {
                                key: "ver",
                                label: "Ver vista previa",
                                icon: <Eye className="size-3.5" />,
                                onSelect: () => viewVariant(variante),
                              },
                              {
                                key: "ajustar-stock",
                                label: "Ajustar stock",
                                icon: <SlidersHorizontal className="size-3.5" />,
                                onSelect: () => openStockAdjustment(variante),
                              },
                              { key: "divider-eliminar", divider: true },
                              {
                                key: "eliminar",
                                label: "Eliminar",
                                icon: <Trash2 className="size-3.5" />,
                                tone: "danger",
                                onSelect: () => {
                                  setVariantError("")
                                  setPendingVariantDelete(variante)
                                },
                              },
                            ]}
                          />
                        </>
                      }
                    />
                  )
                }

                const editKeyDown = (event: KeyboardEvent) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    requestSaveVariant(variante)
                  }
                  if (event.key === "Escape") cancelEditVariant()
                }

                return (
                  <div
                    key={variante.id}
                    data-variant-drop-id={variante.id}
                    style={{ borderLeftColor: editColor, borderLeftWidth: 3 }}
                    className="mx-4 rounded-lg border border-beyonix-sky/30 bg-beyonix-blue/[0.06] px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="min-w-0 w-28">
                        <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/40">
                          SKU
                        </span>
                        <input
                          type="text"
                          value={editVariantSku}
                          maxLength={120}
                          placeholder="Sin SKU"
                          aria-label={`Editar SKU de ${variante.nombre}`}
                          onChange={(event) => setEditVariantSku(event.target.value.toUpperCase())}
                          onKeyDown={editKeyDown}
                          className="h-9 w-full min-w-0 rounded-lg border border-beyonix-blue-light/20 bg-black/30 px-2.5 text-xs font-bold text-white outline-none transition-colors placeholder:text-white/28 hover:border-beyonix-sky/40 focus:border-beyonix-sky/55"
                        />
                      </label>

                      <label className="min-w-0 w-36">
                        <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/40">
                          Color
                        </span>
                        <span className="relative block">
                          <input
                            type="text"
                            value={editColorName}
                            maxLength={160}
                            placeholder="Nombre del color"
                            aria-label={`Editar nombre del color de ${variante.nombre}`}
                            onChange={(event) => setEditColorName(event.target.value.toUpperCase())}
                            onKeyDown={editKeyDown}
                            className="h-9 w-full min-w-0 rounded-lg border border-beyonix-blue-light/20 bg-black/30 py-0 pl-8 pr-2.5 text-xs font-bold text-white outline-none transition-colors placeholder:text-white/28 hover:border-beyonix-sky/40 focus:border-beyonix-sky/55"
                          />
                          <span
                            className="absolute left-2 top-1/2 size-4 -translate-y-1/2 cursor-pointer overflow-hidden rounded-full border border-white/28"
                            style={{ backgroundColor: editColor }}
                          >
                            <input
                              type="color"
                              value={editColor}
                              aria-label={`Seleccionar color de ${variante.nombre}`}
                              onChange={(event) => setEditColor(event.target.value)}
                              className="absolute inset-0 size-full cursor-pointer opacity-0"
                            />
                          </span>
                        </span>
                      </label>

                      <label className="min-w-40 flex-1">
                        <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/40">
                          Código de barra
                        </span>
                        <input
                          type="text"
                          value={editBarcode}
                          maxLength={64}
                          placeholder="Sin código de barra"
                          aria-label={`Editar código de barra de ${variante.nombre}`}
                          onChange={(event) => setEditBarcode(event.target.value)}
                          onKeyDown={editKeyDown}
                          className="h-9 w-full min-w-0 rounded-lg border border-beyonix-blue-light/20 bg-black/30 px-2.5 text-xs font-bold text-white outline-none transition-colors placeholder:text-white/28 hover:border-beyonix-sky/40 focus:border-beyonix-sky/55"
                        />
                      </label>

                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={savingVariantId === variante.id}
                          onClick={cancelEditVariant}
                          className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg border border-white/10 px-3 text-11px font-black text-white/60 transition hover:border-white/20 hover:text-white disabled:cursor-wait disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={savingVariantId === variante.id}
                          aria-label={`Guardar variante ${variante.nombre}`}
                          onClick={() => requestSaveVariant(variante)}
                          className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 text-11px font-black text-emerald-300 transition hover:bg-emerald-400/18 disabled:cursor-wait disabled:opacity-50"
                        >
                          <Check className="size-3.5" />
                          {savingVariantId === variante.id ? "Guardando…" : "Guardar"}
                        </button>
                      </div>
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
                item.conditioned_name?.trim() || "Con descuento"
              const conditionedSku =
                item.conditioned_sku?.trim() || "SKU pendiente"
              const conditionedColor =
                item.conditioned_color_hex || linkedVariant?.color_hex || "#000000"
              const conditionedColorName = getColorName(
                conditionedColor,
                linkedVariant?.nombre,
              )
              const conditionedImage = firstUsableImage(
                item.conditioned_images,
                linkedVariant?.imagenes,
                productImage,
              )
              return (
                <AdminVariantItem
                  key={`conditioned-${item.id}`}
                  image={conditionedImage}
                  imageCount={item.conditioned_images?.length ?? 0}
                  name={producto.nombre}
                  subtitle={`${item.discount_percent}% de descuento · ${item.reason || "Detalle por revisar"}`}
                  sku={conditionedSku}
                  colorHex={conditionedColor}
                  colorLabel={conditionedColorName}
                  stock={item.quantity}
                  tone="discounted"
                  stateLabel={savingConditionedId === item.id ? "Guardando…" : item.active ? "Activa" : "Inactiva"}
                  stateTone={item.active ? "active" : "inactive"}
                  stateDisabled={savingConditionedId === item.id}
                  onToggleState={() => void toggleConditionedStock(item)}
                  leadingAccessory={<span aria-hidden="true" className="size-10 shrink-0" />}
                  actions={
                    <>
                      <button
                        type="button"
                        title={`Ver vista previa de ${conditionedName}`}
                        aria-label={`Ver variante ${conditionedName}`}
                        onClick={() => viewConditionedVariant(item, linkedVariant)}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/55 transition hover:border-blue-400/30 hover:text-blue-300"
                      >
                        <Eye className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Editar esta unidad con descuento"
                        aria-label="Editar unidad con descuento"
                        disabled={savingConditionedId === item.id}
                        onClick={() => {
                          setConditionedError("")
                          setEditingConditionedStock(item)
                        }}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-white/8 text-white/60 transition hover:border-white/20 hover:text-white disabled:cursor-wait disabled:opacity-40"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Quitar esta unidad del inventario con descuento"
                        aria-label="Eliminar unidad con descuento"
                        disabled={savingConditionedId === item.id}
                        onClick={() => void removeConditionedStock(item)}
                        className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-red-400/18 text-red-200/65 transition hover:border-red-400/35 hover:text-red-300 disabled:cursor-wait disabled:opacity-40"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </>
                  }
                />
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
            description={
              isSuperAdmin
                ? "Acción permanente de SUPER ADMIN: se elimina aunque tenga stock, compras, ventas o devoluciones asociadas. El historial se conserva desvinculado."
                : "Esta acción es permanente."
            }
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

      {stockAdjustmentModal}

      {pendingBarcodeConfirm &&
        createPortal(
          <AdminModal
            open
            compact
            title="Cambiar código de barra"
            description="Vas a cambiar el código con el que se identifica esta variante al escanearla."
            onClose={() => {
              if (savingVariantId === null) setPendingBarcodeConfirm(null)
            }}
            footer={
              <div className="flex items-center justify-end gap-2">
                <AdminSecondaryButton
                  disabled={savingVariantId !== null}
                  onClick={() => setPendingBarcodeConfirm(null)}
                >
                  No
                </AdminSecondaryButton>
                <button
                  type="button"
                  disabled={savingVariantId !== null}
                  onClick={() => {
                    const target = pendingBarcodeConfirm
                    setPendingBarcodeConfirm(null)
                    void saveVariant(target)
                  }}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 text-sm font-black text-emerald-300 transition hover:bg-emerald-400/18 disabled:cursor-wait disabled:opacity-50"
                >
                  <Check className="size-4" />
                  Sí
                </button>
              </div>
            }
          >
            <p className="text-center text-sm text-white/60">
              ¿Estás seguro de que querés modificar el código de barra de{" "}
              <span className="font-bold text-white">
                {pendingBarcodeConfirm.nombre}
              </span>
              ?
            </p>
          </AdminModal>,
          document.body,
        )}

      {editingConditionedStock &&
        createPortal(
          <ConditionedStockEditModal
            key={editingConditionedStock.id}
            item={editingConditionedStock}
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

      {previewTarget &&
        createPortal(
          <AdminProductPreviewModal
            key={previewTarget.initialVariantValue || "product"}
            product={previewTarget.product}
            initialVariantValue={previewTarget.initialVariantValue}
            onClose={() => setPreviewTarget(null)}
          />,
          document.body,
        )}
    </div>
  )
}

function ConditionedStockEditModal({
  item,
  productPrice,
  variants,
  saving,
  error,
  onClose,
  onSave,
}: {
  item: SupabaseConditionedStock
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
  const [selectedVariantId, setSelectedVariantId] = useState(
    initialVariant ? String(initialVariant.id) : "",
  )
  const [conditionedName, setConditionedName] = useState(
    (item.conditioned_name?.trim() || "Con descuento").toUpperCase(),
  )
  const [conditionedSku, setConditionedSku] = useState(
    (item.conditioned_sku?.trim() || "").toUpperCase(),
  )
  // El SKU se sugiere automáticamente mientras el administrador no lo haya
  // tocado a mano. Si ya existía uno guardado, se respeta y no se
  // sobrescribe con la sugerencia.
  const [skuManuallyEdited, setSkuManuallyEdited] = useState(
    Boolean(item.conditioned_sku?.trim()),
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
  const selectedVariant = variants.find(
    (variant) => String(variant.id) === selectedVariantId,
  )

  useEffect(() => {
    if (skuManuallyEdited) return

    setConditionedSku(
      buildDiscountedSkuSuggestion({
        originalSku: selectedVariant?.sku,
        colorHex: conditionedColor,
        colorName: selectedVariant?.nombre,
        discountPercent: parsedPercent,
      }),
    )
  }, [skuManuallyEdited, selectedVariant, conditionedColor, parsedPercent])

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
    setConditionedName("CON DESCUENTO")
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
                Nombre
              </span>
              <input
                type="text"
                value={conditionedName}
                maxLength={160}
                onChange={(event) => setConditionedName(event.target.value.toUpperCase())}
                placeholder="Con descuento"
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
                onChange={(event) => {
                  setConditionedSku(event.target.value.toUpperCase())
                  setSkuManuallyEdited(true)
                }}
                placeholder="AP01-Neg-30"
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
