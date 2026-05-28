"use client"

import {
  useCallback,
  useEffect,
  useState,
} from "react"
import {
  Loader2,
  Pencil,
  Pipette,
  Plus,
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
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import {
  createProductoVariante,
  deleteProductoVariante,
  getProductoVariantes,
  updateProductoVariante,
} from "@/lib/supabase/queries/producto-variantes"

import {
  updateProducto,
} from "@/lib/supabase/queries/productos"

interface ProductVariantsEditorProps {
  productoId?: number
  draftVariants?: DraftProductoVariante[]
  onDraftVariantsChange?: (
    variants: DraftProductoVariante[]
  ) => void
}

type EyeDropperResult = {
  sRGBHex: string
}

type EyeDropperApi = {
  open: () => Promise<EyeDropperResult>
}

type EyeDropperWindow = Window & {
  EyeDropper?: new () => EyeDropperApi
}

const inputCls =
  "w-full rounded-2xl border border-white/8 bg-black px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-blue-400"

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
}: ProductVariantsEditorProps) {
  const [variantes, setVariantes] =
    useState<SupabaseProductoVariante[]>([])

  const [nombre, setNombre] =
    useState("")

  const [colorHex, setColorHex] =
    useState("#000000")

  const [stock, setStock] =
    useState("")

  const [variantImages, setVariantImages] =
    useState<File[]>([])

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

  const [notice, setNotice] =
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

        const data =
          await getProductoVariantes(
            productoId
          )

        setVariantes(data)
      } catch (err) {
        console.error(err)
        setError(
          "No se pudieron cargar las variantes. Revisá que exista la tabla producto_variantes."
        )
      } finally {
        setLoading(false)
      }
    }, [productoId])

  useEffect(() => {
    loadVariantes()
  }, [loadVariantes])

  const resetFields = () => {
    setNombre("")
    setColorHex("#000000")
    setStock("")
    setVariantImages([])
    setEditingVariant(null)
  }

  const syncProductoStock = async (
    nextVariantes: SupabaseProductoVariante[]
  ) => {
    if (!productoId) {
      return
    }

    const total = nextVariantes.reduce(
      (acc, variante) =>
        acc + (variante.stock ?? 0),
      0
    )

    await updateProducto(productoId, {
      stock: total,
    })
  }

  const pickColor = async () => {
    setNotice("")
    setError("")

    const EyeDropper = (
      window as EyeDropperWindow
    ).EyeDropper

    if (!EyeDropper) {
      setNotice(
        "Tu navegador no soporta cuenta gotas. Usá el selector manual de color."
      )

      return
    }

    try {
      const result =
        await new EyeDropper().open()

      setColorHex(
        normalizeHex(result.sRGBHex)
      )
    } catch {
      setNotice(
        "Selección de color cancelada."
      )
    }
  }

  const addVariant = async () => {
    setError("")
    setNotice("")

    const cleanName =
      nombre.trim()

    if (!cleanName) {
      setError(
        "El nombre de la variante es obligatorio."
      )
      return
    }

    if (!stock) {
      setError(
        "El stock de la variante es obligatorio."
      )
      return
    }

    const nextVariant = {
      nombre: cleanName,
      color_hex:
        normalizeHex(colorHex),
      stock: Number(stock),
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
                ...editingVariant.imagenes,
                ...urls,
              ],
            }
          )

        const nextVariantes =
          variantes.map((variante) =>
            variante.id === updated.id
              ? updated
              : variante
          )

        setVariantes(nextVariantes)
        await syncProductoStock(
          nextVariantes
        )
        resetFields()
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

      await syncProductoStock([
        ...variantes,
        created,
      ])
      resetFields()
      await loadVariantes()
    } catch (err) {
      console.error(err)
      setError(
        "No se pudo crear la variante."
      )
    } finally {
      setSaving(false)
    }
  }

  const removePersistedVariant =
    async (id: number) => {
      try {
        setError("")
        setNotice("")

        await deleteProductoVariante(id)

        const nextVariantes =
          variantes.filter(
            (variante) =>
              variante.id !== id
          )

        setVariantes(nextVariantes)
        await syncProductoStock(
          nextVariantes
        )
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
    setStock(String(variant.stock ?? ""))
    setVariantImages(variant.imagenes)
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
    setStock(String(variant.stock ?? ""))
    setVariantImages([])
    setEditingVariant({
      kind: "persisted",
      id: variant.id,
      imagenes:
        variant.imagenes || [],
    })
  }

  return (
    <div className="space-y-5 rounded-2xl border border-white/8 bg-white/2 p-4">
      <div>
        <h2 className="text-sm font-semibold text-white">
          Variante
        </h2>

        <p className="mt-1 text-xs text-white/55">
          Seleccioná color, stock e imágenes para esta variante.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <input
          type="text"
          title="Nombre de variante"
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
            title="Color"
            value={normalizeHex(colorHex)}
            onChange={(e) =>
              setColorHex(
                normalizeHex(
                  e.target.value
                )
              )
            }
            className="h-12 w-16 cursor-pointer rounded-2xl border border-white/8 bg-black p-1"
          />

          <input
            type="text"
            title="Color hexadecimal"
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
          min="0"
          type="number"
          title="Stock de variante"
          value={stock}
          placeholder="Stock"
          onChange={(e) =>
            setStock(e.target.value)
          }
          className={inputCls}
        />
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
          Imágenes de esta variante
        </p>

        <DraftImageUploader
          files={variantImages}
          onChange={setVariantImages}
        />
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          title="Usar cuenta gotas"
          aria-label="Usar cuenta gotas"
          onClick={pickColor}
          className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 px-4 text-sm text-white/75 transition-colors hover:text-white cursor-pointer"
        >
          <Pipette className="size-4" />
          Cuenta gotas
        </button>

        <button
          type="button"
          title="Crear variante"
          aria-label="Crear variante"
          onClick={addVariant}
          disabled={saving}
          className="inline-flex h-11 items-center gap-2 rounded-2xl bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-white/90 cursor-pointer disabled:opacity-50"
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
            title="Cancelar edición"
            aria-label="Cancelar edición"
            onClick={resetFields}
            className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 px-4 text-sm text-white/70 transition-colors hover:text-white cursor-pointer"
          >
            <X className="size-4" />
            Cancelar
          </button>
        )}
      </div>

      {notice && (
        <p className="text-xs text-white/55">
          {notice}
        </p>
      )}

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
        <div className="space-y-2 border-t border-white/8 pt-4">
          {productoId ? (
            variantes.length ? (
              variantes.map((variante) => (
                <VariantRow
                  key={variante.id}
                  nombre={variante.nombre}
                  colorHex={variante.color_hex}
                  stock={variante.stock}
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
                stock={variant.stock}
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
    <div className="rounded-2xl border border-white/7 bg-black px-5 py-6 text-center">
      <p className="text-sm text-white/55">
        Todavía no hay variantes cargadas.
      </p>
    </div>
  )
}

interface VariantRowProps {
  nombre: string
  colorHex: string
  stock: number | null
  imageCount: number
  onEdit: () => void
  onRemove: () => void
}

function VariantRow({
  nombre,
  colorHex,
  stock,
  imageCount,
  onEdit,
  onRemove,
}: VariantRowProps) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/7 bg-black px-4 py-3">
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
            {typeof stock === "number" &&
              ` · Stock ${stock}`}
            {` · ${imageCount} imágenes`}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          title="Editar variante"
          aria-label={`Editar variante ${nombre}`}
          onClick={onEdit}
          className="flex size-9 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-white/20 hover:text-white cursor-pointer"
        >
          <Pencil className="size-4" />
        </button>

        <button
          type="button"
          title="Eliminar variante"
          aria-label={`Eliminar variante ${nombre}`}
          onClick={onRemove}
          className="flex size-9 items-center justify-center rounded-xl border border-white/8 text-white/60 transition-colors hover:border-red-500/30 hover:text-red-400 cursor-pointer"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  )
}
