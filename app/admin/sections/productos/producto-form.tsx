"use client"

import { useEffect, useState } from "react"

import {
  ArrowLeft,
  Loader2,
  ToggleLeft,
  ToggleRight,
} from "lucide-react"

import type {
  SupabaseProducto,
  SupabaseCategoria,
} from "@/lib/supabase/types"

import {
  createProducto,
  updateProducto,
  getCategorias,
} from "@/lib/supabase/queries/productos"

import { slugify } from "./helpers"

import { ImageUploader } from "./image-uploader"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ProductoFormProps {
  producto?: SupabaseProducto | null

  onSaved: () => void

  onCancel: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface ProductoFormState {
  nombre: string
  slug: string
  descripcion: string
  precio: string
  precio_anterior: string
  stock: string
  categoria_id: string
  destacado: boolean
  activo: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function ProductoForm({
  producto,
  onSaved,
  onCancel,
}: ProductoFormProps) {
  const [categorias, setCategorias] =
    useState<SupabaseCategoria[]>([])

  const [saving, setSaving] =
    useState(false)

  const [error, setError] =
    useState("")

  const [savedId, setSavedId] =
    useState<number | null>(
      producto?.id ?? null
    )

  const [form, setForm] =
    useState<ProductoFormState>({
      nombre: producto?.nombre ?? "",
      slug: producto?.slug ?? "",
      descripcion:
        producto?.descripcion ?? "",
      precio: producto?.precio
        ? String(producto.precio)
        : "",
      precio_anterior:
        producto?.precio_anterior
          ? String(
              producto.precio_anterior
            )
          : "",
      stock: producto?.stock
        ? String(producto.stock)
        : "0",
      categoria_id:
        producto?.categoria_id
          ? String(producto.categoria_id)
          : "",
      destacado:
        producto?.destacado ?? false,
      activo: producto?.activo ?? true,
    })

  // ───────────────────────────────────────────────────────────────────────────
  // Load categorías
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const load = async () => {
      try {
        const data =
          await getCategorias()

        setCategorias(data)
      } catch (err) {
        console.error(err)
      }
    }

    load()
  }, [])

  // ───────────────────────────────────────────────────────────────────────────
  // Set helper
  // ───────────────────────────────────────────────────────────────────────────

  const set = <
    K extends keyof ProductoFormState
  >(
    key: K,
    value: ProductoFormState[K]
  ) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }))
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Nombre change
  // ───────────────────────────────────────────────────────────────────────────

  const handleNombreChange = (
    value: string
  ) => {
    set("nombre", value)

    if (!producto) {
      set(
        "slug",
        slugify(value)
      )
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Submit
  // ───────────────────────────────────────────────────────────────────────────

  const handleSubmit = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setError("")

    if (!form.nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    if (
      !form.precio ||
      isNaN(Number(form.precio))
    ) {
      setError(
        "El precio es obligatorio."
      )

      return
    }

    try {
      setSaving(true)

      const precio =
        Number(form.precio)

      const precioAnterior =
        form.precio_anterior
          ? Number(
              form.precio_anterior
            )
          : null

      const descuento =
        precioAnterior &&
        precioAnterior > precio
          ? Math.round(
              ((precioAnterior -
                precio) /
                precioAnterior) *
                100
            )
          : null

      const payload = {
        nombre:
          form.nombre.trim(),

        slug:
          form.slug.trim() ||
          slugify(form.nombre),

        descripcion:
          form.descripcion.trim() ||
          null,

        precio,

        precio_anterior:
          precioAnterior,

        descuento,

        stock:
          Number(form.stock) || 0,

        categoria_id:
          form.categoria_id
            ? Number(
                form.categoria_id
              )
            : null,

        destacado:
          form.destacado,

        activo:
          form.activo,
      }

      // Editar
      if (producto) {
        await updateProducto(
          producto.id,
          payload
        )
      }

      // Crear
      else {
        const created =
          await createProducto(
            payload
          )

        setSavedId(created.id)
      }

      onSaved()
    } catch (err) {
      console.error(err)

      setError(
        "Ocurrió un error guardando el producto."
      )
    } finally {
      setSaving(false)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Styles
  // ───────────────────────────────────────────────────────────────────────────

  const inputCls =
    "w-full bg-[#0A0A0A] border border-white/8 rounded-2xl px-4 py-3 text-sm text-white placeholder:text-white/25 outline-none focus:border-[#1E4D7B] transition-colors"

  const labelCls =
    "block text-xs font-semibold uppercase tracking-[0.15em] text-white/40 mb-2"

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
            Productos
          </p>

          <h1 className="text-3xl font-bold text-white">
            {producto
              ? "Editar producto"
              : "Nuevo producto"}
          </h1>
        </div>

        <button
          type="button"
          title="Volver"
          onClick={onCancel}
          className="h-11 px-4 rounded-2xl border border-white/8 text-white/60 hover:text-white transition-colors inline-flex items-center gap-2 cursor-pointer"
        >
          <ArrowLeft className="size-4" />
          Volver
        </button>
      </div>

      {/* Card */}
      <div className="rounded-3xl border border-white/7 bg-[#0A0A0A] p-6">
        <form
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          {/* Nombre + slug */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="nombre-input"
                className={labelCls}
              >
                Nombre *
              </label>

              <input
                id="nombre-input"
                type="text"
                title="Nombre"
                placeholder="Auriculares..."
                className={inputCls}
                value={form.nombre}
                onChange={(e) =>
                  handleNombreChange(
                    e.target.value
                  )
                }
              />
            </div>

            <div>
              <label
                htmlFor="slug-input"
                className={labelCls}
              >
                Slug
              </label>

              <input
                id="slug-input"
                type="text"
                title="Slug"
                placeholder="auriculares..."
                className={inputCls}
                value={form.slug}
                onChange={(e) =>
                  set(
                    "slug",
                    e.target.value
                  )
                }
              />
            </div>
          </div>

          {/* Descripción */}
          <div>
            <label
              htmlFor="descripcion-input"
              className={labelCls}
            >
              Descripción
            </label>

            <textarea
              id="descripcion-input"
              title="Descripción"
              placeholder="Descripción del producto..."
              className={`${inputCls} resize-none min-h-120px`}
              value={form.descripcion}
              onChange={(e) =>
                set(
                  "descripcion",
                  e.target.value
                )
              }
            />
          </div>

          {/* Precio */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="precio-input"
                className={labelCls}
              >
                Precio
              </label>

              <input
                id="precio-input"
                type="number"
                title="Precio"
                placeholder="0"
                className={inputCls}
                value={form.precio}
                onChange={(e) =>
                  set(
                    "precio",
                    e.target.value
                  )
                }
              />
            </div>

            <div>
              <label
                htmlFor="precio-anterior-input"
                className={labelCls}
              >
                Precio anterior
              </label>

              <input
                id="precio-anterior-input"
                type="number"
                title="Precio anterior"
                placeholder="0"
                className={inputCls}
                value={
                  form.precio_anterior
                }
                onChange={(e) =>
                  set(
                    "precio_anterior",
                    e.target.value
                  )
                }
              />
            </div>

            <div>
              <label
                htmlFor="stock-input"
                className={labelCls}
              >
                Stock
              </label>

              <input
                id="stock-input"
                type="number"
                min="0"
                title="Stock"
                placeholder="0"
                className={inputCls}
                value={form.stock}
                onChange={(e) =>
                  set(
                    "stock",
                    e.target.value
                  )
                }
              />
            </div>
          </div>

          {/* Categoría */}
          <div>
            <label
              htmlFor="categoria-select"
              className={labelCls}
            >
              Categoría
            </label>

            <select
              id="categoria-select"
              className={inputCls}
              value={form.categoria_id}
              onChange={(e) =>
                set(
                  "categoria_id",
                  e.target.value
                )
              }
            >
              <option value="">
                Sin categoría
              </option>

              {categorias.map((cat) => (
                <option
                  key={cat.id}
                  value={cat.id}
                >
                  {cat.nombre}
                </option>
              ))}
            </select>
          </div>

          {/* Toggles */}
          <div className="flex items-center gap-8">
            <button
              type="button"
              title="Producto destacado"
              onClick={() =>
                set(
                  "destacado",
                  !form.destacado
                )
              }
              className="flex items-center gap-2 cursor-pointer"
            >
              {form.destacado ? (
                <ToggleRight className="size-6 text-[#4A90B8]" />
              ) : (
                <ToggleLeft className="size-6 text-white/35" />
              )}

              <span className="text-sm text-white/70">
                Producto destacado
              </span>
            </button>

            <button
              type="button"
              title="Producto activo"
              onClick={() =>
                set(
                  "activo",
                  !form.activo
                )
              }
              className="flex items-center gap-2 cursor-pointer"
            >
              {form.activo ? (
                <ToggleRight className="size-6 text-green-400" />
              ) : (
                <ToggleLeft className="size-6 text-white/35" />
              )}

              <span className="text-sm text-white/70">
                Producto activo
              </span>
            </button>
          </div>

          {/* Upload */}
          {savedId && (
            <div>
              <label className={labelCls}>
                Imágenes
              </label>

              <ImageUploader
                productoId={savedId}
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
              <p className="text-sm text-red-400">
                {error}
              </p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              title="Guardar producto"
              className="flex-1 h-12 rounded-2xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-50 transition-all cursor-pointer"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin mx-auto" />
              ) : producto ? (
                "Guardar cambios"
              ) : (
                "Crear producto"
              )}
            </button>

            <button
              type="button"
              title="Cancelar"
              onClick={onCancel}
              className="h-12 px-6 rounded-2xl border border-white/10 text-sm text-white/60 hover:text-white transition-colors cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}