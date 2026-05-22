"use client"

import { useRef, useState, useCallback } from "react"

import {
  Upload,
  Loader2,
  Trash2,
  Star,
  ImageIcon,
} from "lucide-react"

import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseImagenProducto,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ImageUploaderProps {
  productoId: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function ImageUploader({
  productoId,
}: ImageUploaderProps) {
  const [imagenes, setImagenes] =
    useState<SupabaseImagenProducto[]>([])

  const [uploading, setUploading] =
    useState(false)

  const [dragging, setDragging] =
    useState(false)

  const [error, setError] =
    useState("")

  const inputRef =
    useRef<HTMLInputElement>(null)

  // ───────────────────────────────────────────────────────────────────────────
  // Load imágenes
  // ───────────────────────────────────────────────────────────────────────────

  const loadImagenes =
    useCallback(async () => {
      const { data } = await supabase
        .from("imagenes_producto")
        .select("*")
        .eq("producto_id", productoId)
        .order("orden")

      setImagenes(data ?? [])
    }, [productoId])

  // ───────────────────────────────────────────────────────────────────────────
  // First load
  // ───────────────────────────────────────────────────────────────────────────

  useState(() => {
    loadImagenes()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Upload
  // ───────────────────────────────────────────────────────────────────────────

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter(
        (f) =>
          f.type.startsWith("image/")
      )

      if (!imageFiles.length) {
        setError(
          "Solo se aceptan imágenes."
        )
        return
      }

      setUploading(true)
      setError("")

      for (const file of imageFiles) {
        const ext =
          file.name.split(".").pop()

        const path = `productos/${productoId}/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}.${ext}`

        // Upload storage
        const {
          data: uploadData,
          error: uploadError,
        } = await supabase.storage
          .from("imagenes-productos")
          .upload(path, file, {
            upsert: false,
          })

        if (uploadError) {
          setError(
            "Error subiendo imagen."
          )
          continue
        }

        // Public URL
        const {
          data: { publicUrl },
        } = supabase.storage
          .from("imagenes-productos")
          .getPublicUrl(
            uploadData.path
          )

        // Orden
        const maxOrden =
          imagenes.length > 0
            ? Math.max(
                ...imagenes.map(
                  (i) => i.orden
                )
              )
            : 0

        // Insert DB
        await supabase
          .from("imagenes_producto")
          .insert({
            producto_id: productoId,
            url: publicUrl,
            orden: maxOrden + 1,
          })
      }

      setUploading(false)
      loadImagenes()
    },
    [
      productoId,
      imagenes,
      loadImagenes,
    ]
  )

  // ───────────────────────────────────────────────────────────────────────────
  // Drop
  // ───────────────────────────────────────────────────────────────────────────

  const onDrop = (
    e: React.DragEvent
  ) => {
    e.preventDefault()

    setDragging(false)

    uploadFiles(
      Array.from(
        e.dataTransfer.files
      )
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Delete image
  // ───────────────────────────────────────────────────────────────────────────

  const handleDelete = async (
    image: SupabaseImagenProducto
  ) => {
    // DB
    await supabase
      .from("imagenes_producto")
      .delete()
      .eq("id", image.id)

    // Storage
    const path =
      image.url.split(
        "/imagenes-productos/"
      )[1]

    if (path) {
      await supabase.storage
        .from("imagenes-productos")
        .remove([path])
    }

    loadImagenes()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Set principal
  // ───────────────────────────────────────────────────────────────────────────

  const handleSetPrincipal =
    async (url: string) => {
      await supabase
        .from("productos")
        .update({
          imagen_principal: url,
        })
        .eq("id", productoId)

      loadImagenes()
    }

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() =>
          setDragging(false)
        }
        onDrop={onDrop}
        onClick={() =>
          inputRef.current?.click()
        }
        className={`relative flex flex-col items-center justify-center gap-3 h-36 rounded-3xl border-2 border-dashed transition-colors cursor-pointer ${
          dragging
            ? "border-[#4A90B8] bg-[#112A43]/30"
            : "border-white/10 bg-white/2 hover:border-white/20"
        }`}
      >
        {uploading ? (
          <Loader2 className="size-7 text-white/40 animate-spin" />
        ) : (
          <>
            <Upload className="size-6 text-white/25" />

            <div className="text-center">
              <p className="text-sm font-medium text-white/65">
                Arrastrá imágenes acá
              </p>

              <p className="text-xs text-white/30 mt-1">
                o hacé click para
                seleccionar
              </p>
            </div>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          aria-label="Seleccionar imágenes"
          title="Seleccionar imágenes"
          className="hidden"
          onChange={(e) =>
            e.target.files &&
            uploadFiles(
              Array.from(
                e.target.files
              )
            )
          }
        />
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">
            {error}
          </p>
        </div>
      )}

      {/* Empty */}
      {!uploading &&
        imagenes.length === 0 && (
          <div className="rounded-2xl border border-white/6 bg-white/2 px-5 py-10 text-center">
            <ImageIcon className="size-8 text-white/15 mx-auto mb-3" />

            <p className="text-sm text-white/45">
              No hay imágenes cargadas.
            </p>
          </div>
        )}

      {/* Grid */}
      {imagenes.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {imagenes.map((img) => (
            <div
              key={img.id}
              className="relative group aspect-square rounded-2xl overflow-hidden border border-white/7 bg-[#111]"
            >
              <img
                src={img.url}
                alt=""
                className="w-full h-full object-cover"
              />

              {/* Overlay */}
              <div className="absolute inset-0 bg-black/65 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                {/* Principal */}
                <button
                  type="button"
                  title="Imagen principal"
                  onClick={() =>
                    handleSetPrincipal(
                      img.url
                    )
                  }
                  className="size-9 rounded-xl bg-amber-500/90 hover:bg-amber-500 transition-colors flex items-center justify-center cursor-pointer"
                >
                  <Star className="size-4 text-white" />
                </button>

                {/* Delete */}
                <button
                  type="button"
                  title="Eliminar"
                  onClick={() =>
                    handleDelete(img)
                  }
                  className="size-9 rounded-xl bg-red-500/90 hover:bg-red-500 transition-colors flex items-center justify-center cursor-pointer"
                >
                  <Trash2 className="size-4 text-white" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}