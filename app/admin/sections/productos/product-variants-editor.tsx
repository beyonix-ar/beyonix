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

    if (editingVariant?.kind !== "persisted") {
      return
    }

    try {
      setError("")

      const updated =
        await updateProductoVariante(
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
    if (editingVariant?.kind !== "persisted") {
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
        await deleteProductoVariante(created.id)
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
      try {
        setError("")
        await deleteProductoVariante(id)

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
    <div className="space-y-3">
      {productoId && distribution && (
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            ["Stock total", distribution.totalStock],
            ["Distribuido", distribution.allocatedQuantity],
            ["Sin distribuir", distribution.unassignedQuantity],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-xl border border-white/7 bg-black/22 px-3 py-2.5 text-center"
            >
              <p className="text-10px font-black uppercase tracking-widest text-white/38">
                {label}
              </p>
              <p className="mt-0.5 text-lg font-black text-white">
                {value}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(190px,1fr)_minmax(130px,0.65fr)]">
        <input
          type="text"
          value={nombre}
          placeholder="Negro, azul, rosa..."
          onChange={(e) =>
            setNombre(e.target.value)
          }
          className={inputCls}
        />

        <div className="flex gap-2">
          <input
            type="color"
            value={normalizeHex(colorHex)}
            onChange={(e) =>
              setColorHex(
                normalizeHex(
                  e.target.value
                )
              )
            }
            className="h-10 w-12 cursor-pointer rounded-xl border border-white/8 bg-[#181818] p-1 transition-colors hover:border-[#112A43]"
          />

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
            className={inputCls}
          />
        </div>

        <input
          type="text"
          inputMode="numeric"
          value={cantidad}
          placeholder="Unidades"
          aria-label="Unidades asignadas a la variante"
          onChange={(event) =>
            setCantidad(event.target.value.replace(/\D/g, ""))
          }
          className={`${inputCls} text-center`}
        />
      </div>

      <p className="text-center text-xs font-semibold leading-5 text-white/45">
        Distribuí únicamente las unidades recibidas en Costos reales. El total
        físico no se modifica.
      </p>

      <div className="rounded-xl border border-white/7 bg-[#101010] p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
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
        <div className="grid gap-2 border-t border-white/8 pt-3 xl:grid-cols-2">
          {productoId ? (
            variantes.length ? (
              variantes.map((variante) => (
                <VariantRow
                  key={variante.id}
                  nombre={variante.nombre}
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
  colorHex: string
  stock: number | null
  allocated: number
  imageCount: number
  onEdit: () => void
  onRemove: () => void
}

function VariantRow({
  nombre,
  colorHex,
  stock,
  allocated,
  imageCount,
  onEdit,
  onRemove,
}: VariantRowProps) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/7 bg-[#181818] px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className="size-6 rounded-full border border-white/20"
          style={{
            backgroundColor: colorHex,
          }}
        />

        <div>
          <p className="text-sm font-medium text-white">
            {nombre}
          </p>

          <p className="text-xs text-white/50">
            {colorHex}
            {` · Asignadas ${allocated}`}
            {typeof stock === "number" &&
              ` · Stock ${stock}`}
            {` · ${imageCount} imágenes`}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Editar variante ${nombre}`}
          onClick={onEdit}
          className="flex size-8 items-center justify-center rounded-lg border border-white/8 text-white/60 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white cursor-pointer"
        >
          <Pencil className="size-4" />
        </button>

        <button
          type="button"
          aria-label={`Eliminar variante ${nombre}`}
          onClick={onRemove}
          className="flex size-8 items-center justify-center rounded-lg border border-white/8 text-white/60 transition-colors hover:border-[#112A43] hover:bg-[#112A43] hover:text-white cursor-pointer"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  )
}
