"use client"

import { useState } from "react"

import {
  ArrowLeft,
  Loader2,
} from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import {
  createCategoria,
  updateCategoria,
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

      const payload = {
        nombre:
          nombre.trim(),

        slug:
          slug.trim() ||
          slugify(nombre),
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
    "w-full rounded-2xl border border-white/8 bg-[#0A0A0A] px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-[#1E4D7B]"

  const labelClass =
    "mb-2 block text-xs font-semibold uppercase tracking-[0.15em] text-white/40"

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <p className="mb-1 text-11px font-semibold uppercase tracking-[0.25em] text-[#4A90B8]">
            Categorías
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
          className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/8 px-4 text-white/60 transition-colors hover:text-white cursor-pointer"
        >
          <ArrowLeft className="size-4" />

          Volver
        </button>
      </div>

      <div className="rounded-3xl border border-white/7 bg-[#0A0A0A] p-6">
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
              placeholder="Auriculares..."
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
              placeholder="auriculares..."
              onChange={(e) =>
                setSlug(
                  e.target.value
                )
              }
              className={inputClass}
            />
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
              className="flex h-12 flex-1 items-center justify-center rounded-2xl bg-white text-sm font-semibold text-black transition-all hover:bg-white/90 disabled:opacity-50 cursor-pointer"
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
              className="h-12 rounded-2xl border border-white/10 px-6 text-sm text-white/60 transition-colors hover:text-white cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}