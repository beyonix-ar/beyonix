"use client"

import { useEffect, useState } from "react"

import { ArrowLeft, ImageIcon, Loader2, Star, Trash2 } from "lucide-react"

import type { SupabaseCategoria } from "@/lib/supabase/types"

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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [nombre, setNombre] = useState(categoria?.nombre || "")
  const [slug, setSlug] = useState(categoria?.slug || "")
  const [descripcion, setDescripcion] = useState(categoria?.descripcion || "")
  const [imagen, setImagen] = useState(categoria?.imagen || "")
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState("")
  const [destacado, setDestacado] = useState(categoria?.destacado ?? false)
  const [posicionDestacada, setPosicionDestacada] = useState<1 | 2 | 3 | null>(
    categoria?.posicion_destacada ?? null
  )

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl("")
      return
    }

    const url = URL.createObjectURL(imageFile)
    setPreviewUrl(url)

    return () => {
      URL.revokeObjectURL(url)
    }
  }, [imageFile])

  const handleNombreChange = (value: string) => {
    setNombre(value)

    if (!categoria) {
      setSlug(slugify(value))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (!nombre.trim()) {
      setError("El nombre es obligatorio.")
      return
    }

    try {
      setSaving(true)

      let nextImage = imagen || null

      if (imageFile) {
        nextImage = await uploadCategoriaImage(imageFile)
      }

      const payload = {
        nombre: nombre.trim(),
        slug: slug.trim() || slugify(nombre),
        descripcion: descripcion.trim() || null,
        imagen: nextImage,
        destacado,
        posicion_destacada: destacado ? posicionDestacada : null,
      }

      if (categoria) {
        await updateCategoria(categoria.id, payload)
      } else {
        await createCategoria(payload)
      }

      if (categoria?.imagen && categoria.imagen !== nextImage) {
        await deleteCategoriaImageByUrl(categoria.imagen)
      }

      onSaved()
    } catch (err) {
      console.error(err)
      setError("Error guardando categoría.")
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    "w-full rounded-2xl border border-white/8 bg-black px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-blue-light"
  const labelClass =
    "mb-2 block text-xs font-semibold uppercase tracking-widest text-white/50"
  const previewImage = previewUrl || imagen
  const previewName = nombre.trim() || "Nombre de categoría"
  const previewSlug = slug.trim() || slugify(previewName)

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-1 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
            Categorías
          </p>

          <h1 className="text-3xl font-bold text-white">
            {categoria ? "Editar categoría" : "Nueva categoría"}
          </h1>
        </div>

        <button
          type="button"
          title="Volver"
          aria-label="Volver"
          onClick={onCancel}
          className="inline-flex h-11 min-w-140px cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/8 px-5 text-white/70 transition-colors hover:text-white"
        >
          <ArrowLeft className="size-4" />
          Volver
        </button>
      </div>

      <form
        onSubmit={handleSubmit}
        className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.78fr)] 2xl:grid-cols-[minmax(0,0.95fr)_minmax(420px,0.72fr)]"
      >
        <section className="space-y-5 rounded-3xl border border-white/7 bg-black p-5">
          <div>
            <div>
              <label htmlFor="categoria-nombre" className={labelClass}>
                Nombre *
              </label>

              <input
                id="categoria-nombre"
                type="text"
                value={nombre}
                onChange={(e) => handleNombreChange(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="categoria-descripcion" className={labelClass}>
              Descripción
            </label>

            <textarea
              id="categoria-descripcion"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              className={`${inputClass} min-h-112px resize-none leading-6 xl:min-h-150px`}
            />
          </div>

          <div className="grid gap-5 2xl:grid-cols-[minmax(0,0.82fr)_minmax(320px,0.68fr)]">
            <section className="space-y-4 rounded-3xl border border-white/7 bg-black p-4">
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
                className={`flex min-h-48px w-full cursor-pointer items-center gap-3 rounded-2xl border px-4 text-left transition-colors ${
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
                  Posición destacada
                </label>

                <select
                  id="categoria-posicion-destacada"
                  value={posicionDestacada ?? ""}
                  disabled={!destacado}
                  onChange={(event) => {
                    const value = event.target.value

                    setPosicionDestacada(
                      value ? (Number(value) as 1 | 2 | 3) : null
                    )
                  }}
                  className={`${inputClass} cursor-pointer disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  <option value="">Sin posición</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              </div>
            </section>

            <section className="rounded-3xl border border-beyonix-blue-light/18 bg-beyonix-blue/15 p-4">
              <p className="mb-3 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                Vista previa
              </p>
              <div className="flex items-center gap-4">
                <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/8 bg-black">
                  {previewImage ? (
                    <img
                      src={previewImage}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="size-5 text-beyonix-cyan/45" />
                  )}
                </div>

                <div className="min-w-0">
                  <p className="truncate text-base font-bold text-white">
                    {previewName}
                  </p>
                  <p className="mt-1 truncate text-xs font-medium text-white/45">
                    /categorias/{previewSlug}
                  </p>
                </div>
              </div>
            </section>
          </div>

          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-end">
            <button
              type="button"
              title="Cancelar"
              aria-label="Cancelar"
              onClick={onCancel}
              className="h-12 min-w-140px cursor-pointer rounded-2xl border border-white/10 px-6 text-sm text-white/70 transition-colors hover:text-white"
            >
              Cancelar
            </button>

            <button
              type="submit"
              disabled={saving}
              title="Guardar categoría"
              aria-label="Guardar categoría"
              className="flex h-12 min-w-180px cursor-pointer items-center justify-center rounded-2xl bg-white px-6 text-sm font-semibold text-black transition-all hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : categoria ? (
                "Guardar cambios"
              ) : (
                "Crear categoría"
              )}
            </button>
          </div>
        </section>

        <aside className="rounded-3xl border border-white/7 bg-black p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                Imagen
              </p>
              <p className="mt-1 text-xs font-medium text-white/42">
                Formato horizontal para la portada de la categoría.
              </p>
            </div>

            {previewImage && (
              <button
                type="button"
                onClick={() => {
                  setImagen("")
                  setImageFile(null)
                }}
                className="flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-500/25 px-4 text-sm font-semibold text-red-300 transition-colors hover:border-red-400/45 hover:text-red-200"
              >
                <Trash2 className="size-4" />
                Eliminar
              </button>
            )}
          </div>

          <label
            htmlFor="categoria-imagen"
            className="group relative flex aspect-[16/10] min-h-[360px] cursor-pointer overflow-hidden rounded-2xl border border-dashed border-beyonix-blue-light/28 bg-beyonix-surface-3 transition-colors hover:border-beyonix-blue-light/60 xl:min-h-[500px] 2xl:min-h-[580px]"
          >
            {previewImage ? (
              <>
                <img
                  src={previewImage}
                  alt={nombre || "Imagen de categoría"}
                  className="h-full w-full object-cover"
                />
                <span className="absolute inset-x-4 bottom-4 flex h-12 items-center justify-center rounded-xl border border-white/10 bg-black/75 text-sm font-semibold text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                  Cambiar imagen
                </span>
              </>
            ) : (
              <span className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
                <span className="flex size-16 items-center justify-center rounded-2xl border border-beyonix-blue-light/25 bg-beyonix-blue/20 text-beyonix-cyan">
                  <ImageIcon className="size-7" />
                </span>
                <span className="mt-5 text-base font-bold text-white">
                  Subir imagen
                </span>
                <span className="mt-2 max-w-xs text-sm leading-6 text-white/45">
                  Arrastrá una portada visual o seleccioná un archivo desde tu
                  equipo.
                </span>
                <span className="mt-5 inline-flex h-11 items-center justify-center rounded-xl border border-beyonix-blue-light/35 bg-beyonix-blue/30 px-6 text-sm font-semibold text-beyonix-cyan transition-colors group-hover:border-beyonix-blue-light group-hover:bg-beyonix-blue">
                  Elegir archivo
                </span>
              </span>
            )}
          </label>

          <input
            id="categoria-imagen"
            type="file"
            accept="image/*"
            onChange={(e) => setImageFile(e.target.files?.[0] || null)}
            className="sr-only"
          />
        </aside>
      </form>
    </div>
  )
}
