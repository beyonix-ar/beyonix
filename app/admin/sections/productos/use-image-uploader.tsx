"use client"

import {
  useCallback,
  useEffect,
  useState,
} from "react"

import { supabase } from "@/lib/supabase/client"

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
      const { data } =
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

        await Promise.all(
          validFiles.map(
            async (
              file,
              index
            ) => {
              const ext =
                file.name
                  .split(".")
                  .pop()

              const path = `productos/${productoId}/${crypto.randomUUID()}.${ext}`

              const {
                data,
                error,
              } =
                await supabase.storage
                  .from(
                    "imagenes-productos"
                  )
                  .upload(
                    path,
                    file
                  )

              if (error) {
                throw error
              }

              const {
                data: {
                  publicUrl,
                },
              } =
                supabase.storage
                  .from(
                    "imagenes-productos"
                  )
                  .getPublicUrl(
                    data.path
                  )

              await supabase
                .from(
                  "imagenes_producto"
                )
                .insert({
                  producto_id:
                    productoId,

                  url: publicUrl,

                  orden:
                    maxOrden +
                    index +
                    1,
                })
            }
          )
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
      await supabase
        .from(
          "imagenes_producto"
        )
        .delete()
        .eq("id", image.id)

      const path =
        image.url.split(
          "/imagenes-productos/"
        )[1]

      if (path) {
        await supabase.storage
          .from(
            "imagenes-productos"
          )
          .remove([path])
      }

      loadImages()
    }

  const setPrincipal =
    async (url: string) => {
      await supabase
        .from("productos")
        .update({
          imagen_principal:
            url,
        })
        .eq("id", productoId)

      loadImages()
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