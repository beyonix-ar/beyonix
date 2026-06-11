"use client"

import { useEffect, useState } from "react"

import {
  ImageIcon,
  ArrowLeft,
  Loader2,
  Star,
  Trash2,
} from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import {
  createCategoria,
  deleteCategoriaImageByUrl,
  updateCategoria,
  uploadCategoriaImage,
} from "@/lib/supabase/queries/categorias"

import { slugify } from "../productos/helpers"

interface CategoriaFormProps {
  categoria?: SupabaseCategoria | null

  onSaved: () => void

  onCancel: () => void
}

export function CategoriaForm({
  categoria,
  onSaved,
  onCancel,
}: CategoriaFormProps) {
  const [saving, setSaving] =
    useState(false)

  const [error, setError] =
    useState("")

  const [nombre, setNombre] =
    useState(
      categoria?.nombre || ""
    )

  const [slug, setSlug] =
    useState(
      categoria?.slug || ""
    )

  const [descripcion, setDescripcion] =
    useState(
      categoria?.descripcion || ""
    )

  const [imagen, setImagen] =
    useState(
      categoria?.imagen || ""
    )

  const [imageFile, setImageFile] =
    useState<File | null>(null)

  const [previewUrl, setPreviewUrl] =
    useState("")

  const [destacado, setDestacado] =
    useState(
      categoria?.destacado ?? false
    )

  const [
    posicionDestacada,
    setPosicionDestacada,
  ] = useState<1 | 2 | 3 | null>(
    categoria?.posicion_destacada ?? null
  )

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl("")
      return
    }

    const url =
      URL.createObjectURL(imageFile)

    setPreviewUrl(url)

    return () => {
      URL.revokeObjectURL(url)
    }
  }, [imageFile])

  const handleNombreChange = (
    value: string
  ) => {
    setNombre(value)

    if (!categoria) {
      setSlug(slugify(value))
    }
  }

  const handleSubmit = async (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    setError("")

    if (!nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    try {
      setSaving(true)

      let nextImage = imagen || null

      if (imageFile) {
        nextImage =
          await uploadCategoriaImage(
            imageFile
          )
      }

      const payload = {
        nombre:
          nombre.trim(),

        slug:
          slug.trim() ||
          slugify(nombre),

        descripcion:
          descripcion.trim() ||
          null,

        imagen:
          nextImage,

        destacado,

        posicion_destacada:
          destacado
            ? posicionDestacada
            : null,
      }

      if (categoria) {
        await updateCategoria(
          categoria.id,
          payload
        )
      } else {
        await createCategoria(
          payload
        )
      }

      if (categoria?.imagen && categoria.imagen !== nextImage) {
        await deleteCategoriaImageByUrl(
          categoria.imagen
        )
      }

      onSaved()
    } catch (err) {
      console.error(err)

      setError(
        "Error guardando categoría."
      )
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
  "w-full rounded-2xl border border-white/8 bg-black px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-blue-light"

  const labelClass =
    "mb-2 block text-xs font-semibold uppercase tracking-widest text-white/50"

  const previewImage =
    previewUrl || imagen

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Categorias
          </p>

          <h1 className="text-3xl font-bold text-white">
            {categoria
              ? "Editar categoría"
              : "Nueva categoría"}
          </h1>
        </div>

        <button
          type="button"
          title="Volver"
          aria-label="Volver"
          onClick={onCancel}
          className="inline-flex h-12 min-w-140px items-center justify-center gap-2 rounded-2xl border border-white/8 px-6 text-white/70 transition-colors hover:text-white cursor-pointer"
        >
          <ArrowLeft className="size-4" />

          Volver
        </button>
      </div>

      <div className="rounded-3xl border border-white/7 bg-black p-6">
        <form
          onSubmit={handleSubmit}
          className="space-y-6"
        >
          <div>
            <label
              htmlFor="categoria-nombre"
              className={labelClass}
            >
              Nombre *
            </label>

            <input
              id="categoria-nombre"
              type="text"
              value={nombre}
              onChange={(e) =>
                handleNombreChange(
                  e.target.value
                )
              }
              className={inputClass}
            />
          </div>

          <div>
            <label
              htmlFor="categoria-slug"
              className={labelClass}
            >
              Slug
            </label>

            <input
              id="categoria-slug"
              type="text"
              value={slug}
              onChange={(e) =>
                setSlug(
                  e.target.value
                )
              }
              className={inputClass}
            />
          </div>

          <div>
            <label
              htmlFor="categoria-descripcion"
              className={labelClass}
            >
              Descripcion
            </label>

            <textarea
              id="categoria-descripcion"
              value={descripcion}
              onChange={(e) =>
                setDescripcion(
                  e.target.value
                )
              }
              className={`${inputClass} min-h-112px resize-none leading-6`}
            />
          </div>

          <div>
            <label
              htmlFor="categoria-imagen"
              className={labelClass}
            >
              Imagen
            </label>

            <div className="overflow-hidden rounded-2xl border border-white/8 bg-beyonix-surface">
              <div className="relative aspect-video bg-beyonix-surface-3">
                {previewImage ? (
                  <img
                    src={previewImage}
                    alt={nombre || "Imagen de categoría"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-beyonix-surface-3">
                    <ImageIcon className="size-8 text-beyonix-cyan/45" />
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 p-4 sm:flex-row">
                <label
                  htmlFor="categoria-imagen"
                  className="flex h-11 flex-1 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/35 bg-beyonix-blue/30 px-4 text-sm font-semibold text-beyonix-cyan transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue"
                >
                  {previewImage ? "Cambiar imagen" : "Subir imagen"}
                </label>

                {previewImage && (
                  <button
                    type="button"
                    onClick={() => {
                      setImagen("")
                      setImageFile(null)
                    }}
                    className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-500/25 px-4 text-sm font-semibold text-red-300 transition-colors hover:border-red-400/45 hover:text-red-200"
                  >
                    <Trash2 className="size-4" />
                    Eliminar
                  </button>
                )}
              </div>

              <input
                id="categoria-imagen"
                type="file"
                accept="image/*"
                onChange={(e) =>
                  setImageFile(
                    e.target.files?.[0] || null
                  )
                }
                className="sr-only"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              setDestacado((value) => {
                if (value) {
                  setPosicionDestacada(null)
                }

                return !value
              })
            }
            className={`flex min-h-48px cursor-pointer items-center gap-3 rounded-2xl border px-4 text-left transition-colors ${
              destacado
                ? "border-beyonix-blue-light/35 bg-beyonix-blue/25 text-beyonix-cyan"
                : "border-white/8 bg-black text-white/65 hover:border-beyonix-blue-light/35 hover:text-white"
            }`}
          >
            <Star
              className={`size-5 ${
                destacado
                  ? "fill-beyonix-cyan/70 text-beyonix-cyan"
                  : "text-white/38"
              }`}
            />
            <span className="text-sm font-semibold">
              Categoría destacada
            </span>
          </button>

          <div>
            <label
              htmlFor="categoria-posicion-destacada"
              className={labelClass}
            >
              Posicion destacada
            </label>

            <select
              id="categoria-posicion-destacada"
              value={
                posicionDestacada ?? ""
              }
              disabled={!destacado}
              onChange={(event) => {
                const value =
                  event.target.value

                setPosicionDestacada(
                  value
                    ? (Number(value) as 1 | 2 | 3)
                    : null
                )
              }}
              className={`${inputClass} cursor-pointer disabled:cursor-not-allowed disabled:opacity-45`}
            >
              <option value="">
                Sin posicion
              </option>
              <option value="1">
                1
              </option>
              <option value="2">
                2
              </option>
              <option value="3">
                3
              </option>
            </select>
          </div>

          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
              <p className="text-sm text-red-400">
                {error}
              </p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              title="Guardar categoría"
              aria-label="Guardar categoría"
              className="flex h-12 flex-1 items-center justify-center rounded-2xl bg-white px-6 text-sm font-semibold text-black transition-all hover:bg-white/90 disabled:opacity-50 cursor-pointer"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : categoria ? (
                "Guardar cambios"
              ) : (
                "Crear categoría"
              )}
            </button>

            <button
              type="button"
              title="Cancelar"
              aria-label="Cancelar"
              onClick={onCancel}
              className="h-12 min-w-140px rounded-2xl border border-white/10 px-6 text-sm text-white/70 transition-colors hover:text-white cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
