"use client"

import { useState } from "react"

import {
  ArrowLeft,
  Loader2,
  ToggleLeft,
  ToggleRight,
} from "lucide-react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import type {
  DraftProductoVariante,
} from "./types"

import { ProductVariantsEditor } from "./product-variants-editor"
import { useProductoForm } from "./use-producto-form"

interface ProductoFormProps {
  producto?: SupabaseProducto | null

  onSaved: () => void

  onCancel: () => void
}

const inputCls =
  "w-full rounded-2xl border border-white/8 bg-beyonix-surface px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-blue-light"

const labelCls =
  "mb-2 block text-xs font-semibold uppercase tracking-widest text-white/50"

export function ProductoForm({
  producto,
  onSaved,
  onCancel,
}: ProductoFormProps) {
  const [
    draftVariants,
    setDraftVariants,
  ] = useState<DraftProductoVariante[]>([])

  const {
    form,
    error,
    success,
    saving,
    savedId,
    categorias,

    setField,

    submit,

    handleNombreChange,
  } = useProductoForm({
    producto,
    onSaved,
  })

  const currentProductoId =
    producto?.id || savedId

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
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
          aria-label="Volver"
          onClick={onCancel}
          className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/8 px-4 text-white/70 transition-colors hover:text-white cursor-pointer"
        >
          <ArrowLeft className="size-4" />

          Volver
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()

          submit({
            draftVariants,
            onDraftSaved: () => {
              setDraftVariants([])
            },
          })
        }}
        className="space-y-6 rounded-3xl border border-white/7 bg-beyonix-surface p-6"
      >
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="nombre"
              className={labelCls}
            >
              Nombre *
            </label>

            <input
              id="nombre"
              type="text"
              title="Nombre"
              value={form.nombre}
              placeholder="Auriculares..."
              onChange={(e) =>
                handleNombreChange(
                  e.target.value
                )
              }
              className={inputCls}
            />
          </div>

          <div>
            <label
              htmlFor="slug"
              className={labelCls}
            >
              Slug
            </label>

            <input
              id="slug"
              type="text"
              title="Slug"
              value={form.slug}
              placeholder="auriculares..."
              onChange={(e) =>
                setField(
                  "slug",
                  e.target.value
                )
              }
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="descripcion"
            className={labelCls}
          >
            Descripción
          </label>

          <textarea
            id="descripcion"
            title="Descripción"
            value={form.descripcion}
            placeholder="Descripción del producto..."
            onChange={(e) =>
              setField(
                "descripcion",
                e.target.value
              )
            }
            className={`${inputCls} min-h-120px resize-none`}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {[
            {
              id: "precio",
              label: "Precio",
            },
            {
              id: "precio_anterior",
              label:
                "Precio anterior",
            },
          ].map((field) => (
            <div key={field.id}>
              <label
                htmlFor={field.id}
                className={labelCls}
              >
                {field.label}
              </label>

              <input
                min="0"
                type="number"
                id={field.id}
                title={field.label}
                placeholder="0"
                value={
                  form[
                    field.id as keyof typeof form
                  ] as string
                }
                onChange={(e) =>
                  setField(
                    field.id as keyof typeof form,
                    e.target.value
                  )
                }
                className={inputCls}
              />
            </div>
          ))}
        </div>

        <div>
          <label
            htmlFor="categoria"
            className={labelCls}
          >
            Categoría
          </label>

          <select
            id="categoria"
            title="Categoría"
            value={form.categoria_id}
            onChange={(e) =>
              setField(
                "categoria_id",
                e.target.value
              )
            }
            className={inputCls}
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

        <div>
          <label className={labelCls}>
            Variantes
          </label>

          <ProductVariantsEditor
            productoId={
              currentProductoId ||
              undefined
            }
            draftVariants={
              draftVariants
            }
            onDraftVariantsChange={
              setDraftVariants
            }
          />
        </div>

        <div className="flex gap-8">
          {[
            {
              key: "destacado",
              label:
                "Producto destacado",
              active:
                form.destacado,
              color:
                "text-beyonix-cyan",
            },
            {
              key: "activo",
              label:
                "Producto activo",
              active:
                form.activo,
              color:
                "text-green-400",
            },
          ].map((toggle) => (
            <button
              key={toggle.key}
              type="button"
              title={toggle.label}
              aria-label={
                toggle.label
              }
              onClick={() =>
                setField(
                  toggle.key as
                    | "destacado"
                    | "activo",
                  !toggle.active
                )
              }
              className="flex items-center gap-2 cursor-pointer"
            >
              {toggle.active ? (
                <ToggleRight
                  className={`size-6 ${toggle.color}`}
                />
              ) : (
                <ToggleLeft className="size-6 text-white/45" />
              )}

              <span className="text-sm text-white/80">
                {toggle.label}
              </span>
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
            <p className="text-sm text-red-400">
              {error}
            </p>
          </div>
        )}

        {success && (
          <div className="rounded-2xl border border-green-500/20 bg-green-500/8 px-4 py-3">
            <p className="text-sm text-green-300">
              {success}
            </p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            title="Guardar producto"
            aria-label="Guardar producto"
            className="flex h-12 flex-1 items-center justify-center rounded-2xl bg-white text-sm font-semibold text-black transition-all hover:bg-white/90 disabled:opacity-50 cursor-pointer"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : producto ? (
              "Guardar cambios"
            ) : savedId ? (
              "Finalizar producto"
            ) : (
              "Crear producto"
            )}
          </button>

          <button
            type="button"
            title="Cancelar"
            aria-label="Cancelar"
            onClick={onCancel}
            className="h-12 rounded-2xl border border-white/10 px-6 text-sm text-white/70 transition-colors hover:text-white cursor-pointer"
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
