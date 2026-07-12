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
import {
  adminControlClassName,
  AdminDangerButton,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSecondaryButton,
} from "../../components/admin-controls"

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
    adminControlClassName
  const labelClass =
    "mb-2 block text-xs font-semibold uppercase tracking-widest text-white/50"
  const previewImage = previewUrl || imagen
  const previewName = nombre.trim() || "Nombre de categoría"
  const previewSlug = slug.trim() || slugify(previewName)

  return (
    <div className="w-full">
      <AdminPageHeader
        eyebrow="Categorías"
        title={categoria ? "Editar categoría" : "Nueva categoría"}
        actions={
          <AdminSecondaryButton
            title="Volver"
            aria-label="Volver"
            onClick={onCancel}
            className="min-w-140px"
          >
            <ArrowLeft className="size-4" />
            Volver
          </AdminSecondaryButton>
        }
      />

      <form
        onSubmit={handleSubmit}
        className="mt-5 grid gap-5 xl:grid-cols-2"
      >
        <section className="admin-ds-surface space-y-5 p-5">
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

          <div className="grid gap-5 2xl:grid-cols-2">
            <section className="admin-ds-card space-y-4 p-4">
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
                  className={`${inputClass} admin-control-select cursor-pointer appearance-none disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  <option value="">Sin posición</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              </div>
            </section>

            <section className="admin-ds-card p-4">
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
            <AdminInfoBlock tone="danger">{error}</AdminInfoBlock>
          )}

          <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-end">
            <AdminSecondaryButton
              title="Cancelar"
              aria-label="Cancelar"
              onClick={onCancel}
              className="min-w-140px"
            >
              Cancelar
            </AdminSecondaryButton>

            <AdminPrimaryButton
              type="submit"
              disabled={saving}
              title="Guardar categoría"
              aria-label="Guardar categoría"
              className="min-w-180px"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : categoria ? (
                "Guardar cambios"
              ) : (
                "Crear categoría"
              )}
            </AdminPrimaryButton>
          </div>
        </section>

        <aside className="admin-ds-surface p-4">
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
              <AdminDangerButton
                onClick={() => {
                  setImagen("")
                  setImageFile(null)
                }}
                className="shrink-0"
              >
                <Trash2 className="size-4" />
                Eliminar
              </AdminDangerButton>
            )}
          </div>

          <label
            htmlFor="categoria-imagen"
            className="admin-category-image-dropzone group relative flex cursor-pointer overflow-hidden border border-dashed transition-colors"
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
