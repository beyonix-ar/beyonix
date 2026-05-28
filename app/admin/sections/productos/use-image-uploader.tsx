"use client"

import {
  useCallback,
  useEffect,
  useState,
} from "react"

import { supabase } from "@/lib/supabase/client"

import {
  PRODUCTO_IMAGES_BUCKET,
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import type {
  SupabaseImagenProducto,
} from "@/lib/supabase/types"

interface Props {
  productoId: number
}

export function useImageUploader({
  productoId,
}: Props) {
  const [imagenes, setImagenes] =
    useState<
      SupabaseImagenProducto[]
    >([])

  const [uploading, setUploading] =
    useState(false)

  const [dragging, setDragging] =
    useState(false)

  const [error, setError] =
    useState("")

  const loadImages =
    useCallback(async () => {
      const { data, error } =
        await supabase
          .from(
            "imagenes_producto"
          )
          .select("*")
          .eq(
            "producto_id",
            productoId
          )
          .order("orden")

      if (error) {
        setError(
          "Error cargando imágenes."
        )

        return
      }

      setImagenes(data || [])
    }, [productoId])

  useEffect(() => {
    loadImages()
  }, [loadImages])

  const uploadFiles =
    async (files: File[]) => {
      const validFiles =
        files.filter((file) =>
          file.type.startsWith(
            "image/"
          )
        )

      if (!validFiles.length) {
        setError(
          "Solo se aceptan imágenes."
        )

        return
      }

      try {
        setUploading(true)

        setError("")

        const maxOrden =
          imagenes.length
            ? Math.max(
                ...imagenes.map(
                  (img) =>
                    img.orden
                )
              )
            : 0

        await uploadProductoImages(
          productoId,
          validFiles,
          maxOrden
        )

        await loadImages()
      } catch (err) {
        console.error(err)

        setError(
          "Error subiendo imágenes."
        )
      } finally {
        setUploading(false)
      }
    }

  const deleteImage =
    async (
      image: SupabaseImagenProducto
    ) => {
      try {
        const path =
          image.url.split(
            `/${PRODUCTO_IMAGES_BUCKET}/`
          )[1]

        await Promise.all([
          supabase
            .from(
              "imagenes_producto"
            )
            .delete()
            .eq("id", image.id),

          path
            ? supabase.storage
                .from(PRODUCTO_IMAGES_BUCKET)
                .remove([path])
            : Promise.resolve(),
        ])

        loadImages()
      } catch (err) {
        console.error(err)

        setError(
          "Error eliminando imagen."
        )
      }
    }

  const setPrincipal =
    async (url: string) => {
      try {
        await supabase
          .from("productos")
          .update({
            imagen_principal:
              url,
          })
          .eq("id", productoId)
      } catch (err) {
        console.error(err)

        setError(
          "Error actualizando imagen principal."
        )
      }
    }

  return {
    error,
    dragging,
    uploading,
    imagenes,

    setDragging,

    uploadFiles,

    deleteImage,

    setPrincipal,
  }
}
