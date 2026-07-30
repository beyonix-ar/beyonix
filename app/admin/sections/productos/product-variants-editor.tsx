"use client"

import {
  useCallback,
  useEffect,
  useState,
} from "react"
import {
  Loader2,
  Pencil,
  Plus,
  GripVertical,
  ImageIcon,
  X,
  Trash2,
} from "lucide-react"

import type {
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

import type {
  DraftProductoVariante,
} from "./types"

import { DraftImageUploader } from "./draft-image-uploader"

import {
  deleteProductoImageByUrl,
  updateProductoImageOrder,
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import {
  createProductoVariante,
  deleteProductoVariante,
  getProductVariantDistribution,
  getProductoVariantes,
  saveProductVariantDistribution,
  updateProductoVariante,
  type ProductVariantDistribution,
} from "@/lib/supabase/queries/producto-variantes"

import {
  updateProducto,
} from "@/lib/supabase/queries/productos"
import { TransparencyAwareImage } from "@/components/transparency-aware-image"
import { adminControlClassName } from "../../components/admin-controls"

interface ProductVariantsEditorProps {
  productoId?: number
  draftVariants?: DraftProductoVariante[]
  onDraftVariantsChange?: (
    variants: DraftProductoVariante[]
  ) => void
  onPersistedVariantsChange?: (
    variants: SupabaseProductoVariante[]
  ) => void
}

const inputCls =
  adminControlClassName

const normalizeHex = (value: string) => {
  const clean = value.trim()

  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    return clean.toUpperCase()
  }

  return "#000000"
}

type EditingVariant =
  | {
      kind: "draft"
      id: string
    }
  | {
      kind: "persisted"
      id: number
      imagenes: string[]
    }
  | null

export function ProductVariantsEditor({
  productoId,
  draftVariants = [],
  onDraftVariantsChange,
  onPersistedVariantsChange,
}: ProductVariantsEditorProps) {
  const [variantes, setVariantes] =
    useState<SupabaseProductoVariante[]>([])

  const [nombre, setNombre] =
    useState("")
  const [sku, setSku] =
    useState("")

  const [colorHex, setColorHex] =
    useState("#000000")
  const [cantidad, setCantidad] =
    useState("0")
  const [distribution, setDistribution] =
    useState<ProductVariantDistribution | null>(null)
  const [allocations, setAllocations] =
    useState<Record<number, number>>({})

  const [variantImages, setVariantImages] =
    useState<File[]>([])
  const [persistedVariantImages, setPersistedVariantImages] =
    useState<string[]>([])
  const [draggedImageIndex, setDraggedImageIndex] =
    useState<number | null>(null)

  const [
    editingVariant,
    setEditingVariant,
  ] = useState<EditingVariant>(null)

  const [loading, setLoading] =
    useState(Boolean(productoId))

  const [saving, setSaving] =
    useState(false)

  const [error, setError] =
    useState("")

  const loadVariantes =
    useCallback(async () => {
      if (!productoId) {
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        setError("")

        const [data, stockDistribution] = await Promise.all([
          getProductoVariantes(productoId),
          getProductVariantDistribution(productoId),
        ])

        setVariantes(data)
        setDistribution(stockDistribution)
        setAllocations(
          Object.fromEntries(
            stockDistribution.variants.map((variant) => [
              variant.variant_id,
              variant.allocated_quantity,
            ]),
          ),
        )
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "No se pudieron cargar las variantes."
        )
      } finally {
        setLoading(false)
      }
    }, [productoId])

  useEffect(() => {
    loadVariantes()
  }, [loadVariantes])

  useEffect(() => {
    if (productoId && !loading) {
      onPersistedVariantsChange?.(variantes)
    }
  }, [loading, onPersistedVariantsChange, productoId, variantes])

  const resetFields = () => {
    setNombre("")
    setSku("")
    setColorHex("#000000")
    setCantidad("0")
    setVariantImages([])
    setPersistedVariantImages([])
    setDraggedImageIndex(null)
    setEditingVariant(null)
  }

  const syncPrincipalImage = async (
    nextVariantes: SupabaseProductoVariante[]
  ) => {
    if (!productoId) {
      return
    }

    const principalImage =
      [...nextVariantes]
        .sort((a, b) => {
          if (a.orden !== b.orden) return a.orden - b.orden
          return a.id - b.id
        })
        .flatMap((variante) => variante.imagenes || [])[0] || null
    const currentPrincipalImage =
      [...variantes]
        .sort((a, b) => {
          if (a.orden !== b.orden) return a.orden - b.orden
          return a.id - b.id
        })
        .flatMap((variante) => variante.imagenes || [])[0] || null

    if (principalImage === currentPrincipalImage) {
      return
    }

    await updateProducto(productoId, {
      imagen_principal: principalImage,
    })
  }

  const movePersistedImage = async (
    fromIndex: number,
    toIndex: number
  ) => {
    if (fromIndex === toIndex) {
      return
    }

    const nextImages = [...persistedVariantImages]
    const [image] = nextImages.splice(fromIndex, 1)
    nextImages.splice(toIndex, 0, image)
    setPersistedVariantImages(nextImages)

    if (!productoId || editingVariant?.kind !== "persisted") {
      return
    }

    try {
      setError("")

      const updated =
        await updateProductoVariante(
          productoId,
          editingVariant.id,
          {
            imagenes: nextImages,
          }
        )

      await updateProductoImageOrder(nextImages)

      const nextVariantes =
        variantes.map((variante) =>
          variante.id === updated.id
            ? updated
            : variante
        )

      setVariantes(nextVariantes)
      await syncPrincipalImage(nextVariantes)
    } catch (err) {
      console.error(err)
      setError(
        "No se pudo actualizar el orden de imágenes."
      )
      setPersistedVariantImages(
        editingVariant.imagenes
      )
    }
  }

  const removePersistedImage = async (
    imageUrl: string
  ) => {
    if (!productoId || editingVariant?.kind !== "persisted") {
      return
    }

    try {
      setSaving(true)
      setError("")

      const nextImages =
        persistedVariantImages.filter(
          (image) => image !== imageUrl
        )

      await deleteProductoImageByUrl(imageUrl)

      const updated =
        await updateProductoVariante(
          productoId,
          editingVariant.id,
          {
            imagenes: nextImages,
          }
        )

      const nextVariantes =
        variantes.map((variante) =>
          variante.id === updated.id
            ? updated
            : variante
        )

      setPersistedVariantImages(nextImages)
      setVariantes(nextVariantes)
      await syncPrincipalImage(nextVariantes)
    } catch (err) {
      console.error(err)
      setError(
        "No se pudo eliminar la imagen."
      )
    } finally {
      setSaving(false)
    }
  }

  const addVariant = async () => {
    setError("")
    const cleanName =
      nombre.trim()

    if (!cleanName) {
      setError(
        "El nombre de la variante es obligatorio."
      )
      return
    }
    const allocationQuantity = Number(cantidad)
    if (
      !Number.isInteger(allocationQuantity) ||
      allocationQuantity < 0
    ) {
      setError("La cantidad asignada debe ser un número entero positivo.")
      return
    }

    const nextVariant = {
      nombre: cleanName,
      sku: sku.trim() || null,
      color_hex:
        normalizeHex(colorHex),
    }

    if (editingVariant?.kind === "draft") {
      onDraftVariantsChange?.(
        draftVariants.map((variant) =>
          variant.tempId ===
          editingVariant.id
            ? {
                ...variant,
                ...nextVariant,
                sku: nextVariant.sku ?? "",
                imagenes:
                  variantImages,
              }
            : variant
        )
      )

      resetFields()
      return
    }

    if (!productoId) {
      onDraftVariantsChange?.([
        ...draftVariants,
        {
          ...nextVariant,
          sku: nextVariant.sku ?? "",
          tempId:
            crypto.randomUUID(),
          imagenes:
            variantImages,
        },
      ])

      resetFields()
      return
    }

    try {
      setSaving(true)

      if (editingVariant?.kind === "persisted") {
        const urls =
          variantImages.length
            ? await uploadProductoImages(
                productoId,
                variantImages,
                variantes.reduce(
                  (total, variante) =>
                    total +
                    (variante.imagenes?.length || 0),
                  0
                )
              )
            : []

        const updated =
          await updateProductoVariante(
            productoId,
            editingVariant.id,
            {
              ...nextVariant,
              imagenes: [
                ...persistedVariantImages,
                ...urls,
              ],
            }
          )

        await saveProductVariantDistribution(
          productoId,
          variantes.map((variant) => ({
            variant_id: variant.id,
            quantity:
              variant.id === updated.id
                ? allocationQuantity
                : allocations[variant.id] ?? 0,
          })),
        )

        await updateProductoImageOrder(updated.imagenes || [])

        const nextVariantes =
          variantes.map((variante) =>
            variante.id === updated.id
              ? updated
              : variante
          )

        setVariantes(nextVariantes)
        await syncPrincipalImage(
          nextVariantes
        )
        resetFields()
        await loadVariantes()
        return
      }

      const urls =
        variantImages.length
          ? await uploadProductoImages(
              productoId,
              variantImages,
              variantes.reduce(
                (total, variante) =>
                  total +
                  (variante.imagenes?.length || 0),
                0
              )
            )
          : []

      const created =
        await createProductoVariante({
        producto_id: productoId,
        ...nextVariant,
        imagenes: urls,
        activo: true,
        orden:
          variantes.length + 1,
      })

      await syncPrincipalImage([
        ...variantes,
        created,
      ])
      try {
        await saveProductVariantDistribution(
          productoId,
          [
            ...variantes.map((variant) => ({
              variant_id: variant.id,
              quantity: allocations[variant.id] ?? 0,
            })),
            {
              variant_id: created.id,
              quantity: allocationQuantity,
            },
          ],
        )
      } catch (allocationError) {
        await deleteProductoVariante(productoId, created.id)
        throw allocationError
      }
      resetFields()
      await loadVariantes()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "No se pudo guardar la variante."
      )
    } finally {
      setSaving(false)
    }
  }

  const removePersistedVariant =
    async (id: number) => {
      if (!productoId) return

      try {
        setError("")
        await deleteProductoVariante(productoId, id)

        const nextVariantes =
          variantes.filter(
            (variante) =>
              variante.id !== id
          )

        setVariantes(nextVariantes)
        await syncPrincipalImage(
          nextVariantes
        )
        await loadVariantes()
      } catch (err) {
        console.error(err)
        setError(
          "No se pudo eliminar la variante."
        )
      }
    }

  const removeDraftVariant = (
    tempId: string
  ) => {
    onDraftVariantsChange?.(
      draftVariants.filter(
        (variant) =>
          variant.tempId !== tempId
      )
    )
  }

  const editDraftVariant = (
    variant: DraftProductoVariante
  ) => {
    setNombre(variant.nombre)
    setSku(variant.sku)
    setColorHex(variant.color_hex)
    setCantidad("0")
    setVariantImages(variant.imagenes)
    setPersistedVariantImages([])
    setEditingVariant({
      kind: "draft",
      id: variant.tempId,
    })
  }

  const editPersistedVariant = (
    variant: SupabaseProductoVariante
  ) => {
    setNombre(variant.nombre)
    setSku(variant.sku ?? "")
    setColorHex(variant.color_hex)
    setCantidad(String(allocations[variant.id] ?? 0))
    setVariantImages([])
    setPersistedVariantImages(variant.imagenes || [])
    setEditingVariant({
      kind: "persisted",
      id: variant.id,
      imagenes:
        variant.imagenes || [],
    })
  }

  return (
    <div className="min-w-0 space-y-2.5">
      {productoId && distribution && (
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            {
              label: "Stock total",
              value: distribution.totalStock,
              className: "border-sky-400/20 bg-sky-400/8 text-sky-200",
            },
            {
              label: "Distribuido",
              value: distribution.allocatedQuantity,
              className: "border-emerald-400/20 bg-emerald-400/8 text-emerald-200",
            },
            {
              label: "Sin distribuir",
              value: distribution.unassignedQuantity,
              className: distribution.unassignedQuantity > 0
                ? "border-amber-400/25 bg-amber-400/8 text-amber-200"
                : "border-white/8 bg-white/3 text-white/65",
            },
          ].map(({ label, value, className }) => (
            <div
              key={label}
              className={`rounded-xl border px-2.5 py-2 text-center ${className}`}
            >
              <p className="truncate text-9px font-black uppercase tracking-wider text-white/45">
                {label}
              </p>
              <p className="mt-0.5 text-base font-black">
                {value}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="grid min-w-0 gap-2 sm:grid-cols-2 2xl:grid-cols-[minmax(140px,1fr)_minmax(115px,0.75fr)_minmax(150px,0.9fr)_80px]">
        <label className="min-w-0">
          <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/38">
            Nombre
          </span>
          <input
            type="text"
            value={nombre}
            placeholder="Negro, azul, rosa..."
            onChange={(e) =>
              setNombre(e.target.value)
            }
            className={inputCls}
          />
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/38">
            SKU
          </span>
          <input
            type="text"
            value={sku}
            placeholder="Opcional"
            aria-label="SKU de la variante"
            maxLength={120}
            onChange={(event) => setSku(event.target.value)}
            className={inputCls}
          />
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/38">
            Color
          </span>
          <span className="admin-variant-color-control flex h-11 min-w-0 items-center gap-2 rounded-xl border border-beyonix-blue-light/28 bg-[#07111b] px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:border-beyonix-sky/45 focus-within:border-beyonix-sky/60">
            <span
              className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 border-white/20 shadow-[0_0_0_3px_rgba(140,200,242,0.06)]"
              style={{ backgroundColor: normalizeHex(colorHex) }}
            >
              <input
                type="color"
                value={normalizeHex(colorHex)}
                aria-label="Elegir color de la variante"
                onChange={(e) =>
                  setColorHex(
                    normalizeHex(
                      e.target.value
                    )
                  )
                }
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </span>
            <input
              type="text"
              value={colorHex}
              placeholder="#000000"
              onChange={(e) =>
                setColorHex(e.target.value)
              }
              onBlur={() =>
                setColorHex(
                  normalizeHex(colorHex)
                )
              }
              className="admin-variant-hex-input min-w-0 flex-1 bg-transparent px-1 text-sm font-bold text-white outline-none"
            />
          </span>
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-9px font-black uppercase tracking-wider text-white/38">
            Unidades
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={cantidad}
            placeholder="0"
            aria-label="Unidades asignadas a la variante"
            onChange={(event) =>
              setCantidad(event.target.value.replace(/\D/g, ""))
            }
            className={`${inputCls} text-center`}
          />
        </label>
      </div>

      <p className="rounded-lg border border-amber-400/12 bg-amber-400/5 px-2.5 py-1.5 text-center text-10px font-semibold leading-4 text-amber-100/55">
        Distribuí solo unidades recibidas en Costos reales; el total físico no cambia.
      </p>

      <div className="rounded-xl border border-cyan-400/12 bg-cyan-400/3 p-2.5">
        <p className="mb-2 text-10px font-semibold uppercase tracking-wide text-cyan-100/55">
          Imágenes de esta variante
        </p>

        {editingVariant?.kind === "persisted" && (
          <PersistedVariantImages
            images={persistedVariantImages}
            draggedIndex={draggedImageIndex}
            onDragStart={setDraggedImageIndex}
            onMove={movePersistedImage}
            onDragEnd={() => setDraggedImageIndex(null)}
            onRemove={removePersistedImage}
          />
        )}

        <DraftImageUploader
          files={variantImages}
          onChange={setVariantImages}
          emptyMessage={
            editingVariant?.kind === "persisted"
              ? "Agregá imágenes nuevas para esta variante."
              : "Cargá imágenes antes de crear el producto."
          }
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Crear variante"
          onClick={addVariant}
          disabled={saving}
          className="inline-flex h-10 min-w-150px items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-black transition-colors hover:bg-[#112A43] hover:text-white cursor-pointer disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          {editingVariant
            ? "Guardar variante"
            : "Crear variante"}
        </button>

        {editingVariant && (
          <button
            type="button"
            aria-label="Cancelar edición"
            onClick={resetFields}
            className="inline-flex h-10 min-w-120px items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#181818] px-5 text-sm text-white/70 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white cursor-pointer"
          >
            <X className="size-4" />
            Cancelar
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">
            {error}
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex h-20 items-center justify-center text-white/45">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="grid gap-2 border-t border-white/8 pt-2.5 sm:grid-cols-2">
          {productoId ? (
            variantes.length ? (
              variantes.map((variante) => (
                <VariantRow
                  key={variante.id}
                  nombre={variante.nombre}
                  sku={variante.sku}
                  colorHex={variante.color_hex}
                  stock={variante.stock}
                  allocated={allocations[variante.id] ?? 0}
                  imageCount={
                    variante.imagenes?.length || 0
                  }
                  onEdit={() =>
                    editPersistedVariant(
                      variante
                    )
                  }
                  onRemove={() =>
                    removePersistedVariant(
                      variante.id
                    )
                  }
                />
              ))
            ) : (
              <EmptyVariants />
            )
          ) : draftVariants.length ? (
            draftVariants.map((variant) => (
              <VariantRow
                key={variant.tempId}
                nombre={variant.nombre}
                sku={variant.sku}
                colorHex={variant.color_hex}
                stock={0}
                allocated={0}
                imageCount={
                  variant.imagenes.length
                }
                onEdit={() =>
                  editDraftVariant(
                    variant
                  )
                }
                onRemove={() =>
                  removeDraftVariant(
                    variant.tempId
                  )
                }
              />
            ))
          ) : (
            <EmptyVariants />
          )}
        </div>
      )}
    </div>
  )
}

function EmptyVariants() {
  return (
    <div className="rounded-xl border border-white/7 bg-[#181818] px-4 py-4 text-center xl:col-span-2">
      <p className="text-sm text-white/55">
        Todavía no hay variantes cargadas.
      </p>
    </div>
  )
}

interface PersistedVariantImagesProps {
  images: string[]
  draggedIndex: number | null
  onDragStart: (index: number) => void
  onMove: (
    fromIndex: number,
    toIndex: number
  ) => void
  onDragEnd: () => void
  onRemove: (imageUrl: string) => void
}

function PersistedVariantImages({
  images,
  draggedIndex,
  onDragStart,
  onMove,
  onDragEnd,
  onRemove,
}: PersistedVariantImagesProps) {
  if (!images.length) {
    return (
      <div className="mb-3 rounded-xl border border-white/6 bg-[#181818] px-4 py-4 text-center">
        <ImageIcon className="mx-auto mb-2 size-7 text-white/15" />

        <p className="text-sm text-white/55">
          Esta variante no tiene imágenes cargadas.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
      {images.map((image, index) => (
        <div
          key={`${image}-${index}`}
          draggable
          onDragStart={(event) => {
            onDragStart(index)
            event.dataTransfer.effectAllowed = "move"
          }}
          onDragOver={(event) => {
            event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()

            if (draggedIndex !== null) {
              onMove(draggedIndex, index)
            }

            onDragEnd()
          }}
          onDragEnd={onDragEnd}
          className="group relative aspect-square cursor-grab overflow-hidden rounded-xl border border-white/8 bg-beyonix-surface-3 p-1 transition-colors hover:border-[#112A43] active:cursor-grabbing"
        >
          <TransparencyAwareImage
            src={image}
            alt={`Imagen ${index + 1}`}
            className="h-full w-full rounded-xl object-contain"
          />

          {index === 0 && (
            <span className="absolute left-2 top-2 rounded-full border border-beyonix-sky/25 bg-beyonix-blue/70 px-2 py-1 text-10px font-semibold uppercase tracking-wide text-beyonix-sky">
              Principal
            </span>
          )}

          <div className="absolute inset-0 flex items-center justify-center bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="absolute bottom-2 left-2 flex size-7 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-white/60">
              <GripVertical className="size-4" />
            </span>

            <button
              type="button"
              aria-label={`Eliminar imagen ${index + 1}`}
              onClick={() => onRemove(image)}
              className="flex size-9 cursor-pointer items-center justify-center rounded-xl bg-red-500/90 transition-colors hover:bg-[#112A43]"
            >
              <Trash2 className="size-4 text-white" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

interface VariantRowProps {
  nombre: string
  sku?: string | null
  colorHex: string
  stock: number | null
  allocated: number
  imageCount: number
  onEdit: () => void
  onRemove: () => void
}

function VariantRow({
  nombre,
  sku,
  colorHex,
  stock,
  allocated,
  imageCount,
  onEdit,
  onRemove,
}: VariantRowProps) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-cyan-400/12 bg-cyan-400/4 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="size-5 shrink-0 rounded-full border border-white/25 shadow-[0_0_0_3px_rgba(255,255,255,0.035)]"
          style={{
            backgroundColor: colorHex,
          }}
        />

        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-xs font-bold text-white">
              {nombre}
            </p>
            <span className="shrink-0 rounded-md border border-beyonix-sky/15 bg-beyonix-blue/35 px-1.5 py-0.5 text-9px font-bold text-beyonix-sky/75">
              {sku?.trim() || "Sin SKU"}
            </span>
          </div>

          <p className="mt-0.5 truncate text-10px text-white/42">
            {`Asignadas ${allocated}`}
            {typeof stock === "number" &&
              ` · Stock ${stock}`}
            {` · ${imageCount} imágenes`}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={`Editar variante ${nombre}`}
          onClick={onEdit}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-sky-400/15 bg-sky-400/5 text-sky-200/65 transition-colors hover:border-sky-400/35 hover:bg-sky-400/12 hover:text-white"
        >
          <Pencil className="size-4" />
        </button>

        <button
          type="button"
          aria-label={`Eliminar variante ${nombre}`}
          onClick={onRemove}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-red-400/15 bg-red-400/5 text-red-200/65 transition-colors hover:border-red-400/35 hover:bg-red-400/12 hover:text-white"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  )
}
