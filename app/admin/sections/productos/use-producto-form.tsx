"use client"

import {
  useEffect,
  useMemo,
  useState,
} from "react"

import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"

import type {
  DraftProductoEspecificacion,
  DraftProductoVariante,
  ProductoFormState,
} from "./types"

import {
  saveDraftProductoEspecificaciones,
} from "@/lib/supabase/queries/producto-especificaciones"
import { isAllowedLucideIcon } from "./lucide-icon-picker"

import {
  uploadProductoDraftImages,
  deleteProductoImagesByUrls,
} from "@/lib/supabase/queries/producto-imagenes"

import {
  createProductoCompleto,
  getCategorias,
  updateProducto,
} from "@/lib/supabase/queries/productos"

import { slugify } from "./helpers"
import {
  isPlayableProductVideo,
  isValidHttpsVideoUrl,
} from "@/lib/products/product-video"

interface Props {
  producto?: SupabaseProducto | null
  onSaved: () => void
}

interface SubmitOptions {
  draftVariants?: DraftProductoVariante[]
  draftSpecifications?: DraftProductoEspecificacion[]
  onDraftSaved?: () => void
}

type SupabaseLikeError = {
  message?: string
  details?: string
  hint?: string
  code?: string
}

const getErrorDetails = (
  err: unknown
): SupabaseLikeError => {
  if (err instanceof Error) {
    return {
      message: err.message,
    }
  }

  if (
    err &&
    typeof err === "object"
  ) {
    const candidate =
      err as Record<string, unknown>

    return {
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : undefined,
      details:
        typeof candidate.details === "string"
          ? candidate.details
          : undefined,
      hint:
        typeof candidate.hint === "string"
          ? candidate.hint
          : undefined,
      code:
        typeof candidate.code === "string"
          ? candidate.code
          : undefined,
    }
  }

  return {
    message:
      typeof err === "string"
        ? err
        : undefined,
  }
}

const getErrorMessage = (
  err: unknown
) => {
  const details = getErrorDetails(err)
  const normalizedMessage =
    details.message?.toLowerCase() ?? ""

  if (details.code === "23505") {
    return "Ya existe un producto con ese slug. Modificá el nombre o el slug e intentá nuevamente."
  }

  if (
    normalizedMessage.includes(
      "tenes que iniciar sesion"
    ) ||
    normalizedMessage.includes(
      "jwt expired"
    )
  ) {
    return "Tu sesión venció. Volvé a iniciar sesión antes de guardar el producto."
  }

  if (
    normalizedMessage.includes(
      "solo un administrador"
    ) ||
    details.code === "42501"
  ) {
    return "Tu usuario no tiene permisos para crear productos."
  }

  const parts = [
    details.message,
    details.details,
    details.hint,
    details.code
      ? `Código: ${details.code}`
      : null,
  ].filter(Boolean)

  return parts.length
    ? parts.join(" | ")
    : "Error desconocido al guardar el producto."
}

export function useProductoForm({
  producto,
  onSaved,
}: Props) {
  const [categorias, setCategorias] =
    useState<SupabaseCategoria[]>([])

  const [saving, setSaving] =
    useState(false)

  const [error, setError] =
    useState("")

  const [success, setSuccess] =
    useState("")

  const [savedId, setSavedId] =
    useState<number | null>(
      producto?.id ?? null
    )

  const [form, setForm] = useState<ProductoFormState>({
    nombre: producto?.nombre ?? "",
    slug: producto?.slug ?? "",
    descripcion:
      producto?.descripcion ?? "",
    video_url:
      producto?.video_url ?? "",
    precio:
      String(producto?.precio ?? ""),
    precio_anterior: String(
      producto?.precio_anterior ?? ""
    ),
    cuotas:
      producto?.cuotas_sin_interes &&
      producto.cuotas_maximas
        ? String(producto.cuotas_maximas) as "3" | "6"
        : "sin_cuotas",
    stock: String(
      producto?.stock ?? 0
    ),
    categoria_id: String(
      producto?.categoria_id ?? ""
    ),
    destacado:
      producto?.destacado ?? false,
    activo:
      producto?.activo ?? false,
  })

  useEffect(() => {
    getCategorias()
      .then(setCategorias)
      .catch((err) => {
        console.error(
          "Error cargando categorías:",
          err
        )
      })
  }, [])

  const setField = (
    key: keyof typeof form,
    value:
      | string
      | boolean
  ) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }))
  }

  const handleNombreChange = (
    value: string
  ) => {
    setField("nombre", value)

    if (!producto) {
      setField(
        "slug",
        slugify(value)
      )
    }
  }

  const payload = useMemo(() => {
    const precio =
      Number(form.precio)

    const precioAnterior =
      form.precio_anterior
        ? Number(
            form.precio_anterior
          )
        : null
    const cuotasMaximas: 3 | 6 | null =
      form.cuotas === "3"
        ? 3
        : form.cuotas === "6"
          ? 6
          : null

    return {
      nombre:
        form.nombre.trim(),

      slug:
        form.slug.trim() ||
        slugify(form.nombre),

      descripcion:
        form.descripcion.trim() ||
        null,

      video_url:
        form.video_url.trim() ||
        null,

      precio,

      precio_anterior:
        precioAnterior,

      descuento:
        precioAnterior &&
        precioAnterior > precio
          ? Math.round(
              ((precioAnterior -
                precio) /
                precioAnterior) *
                100
            )
          : null,

      cuotas_sin_interes:
        cuotasMaximas !== null,

      cuotas_maximas:
        cuotasMaximas,

      promo_event_id:
        null,

      promo_original_precio:
        null,

      promo_original_precio_anterior:
        null,

      promo_original_descuento:
        null,

      promo_original_cuotas_sin_interes:
        null,

      promo_original_cuotas_maximas:
        null,

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
  }, [form])

  const submit = async ({
    draftVariants = [],
    draftSpecifications = [],
    onDraftSaved,
  }: SubmitOptions = {}) => {
    setError("")
    setSuccess("")

    if (!form.nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    if (
      !Number.isFinite(payload.precio) ||
      payload.precio <= 0
    ) {
      setError(
        "El precio es obligatorio."
      )

      return
    }

    if (!payload.slug) {
      setError(
        "El slug es obligatorio."
      )

      return
    }

    if (
      form.video_url.trim() &&
      !isValidHttpsVideoUrl(form.video_url)
    ) {
      setError(
        "El video del producto debe ser una URL HTTPS válida."
      )

      return
    }

    if (
      form.video_url.trim() &&
      !isPlayableProductVideo(form.video_url)
    ) {
      setError(
        "Usá YouTube, Vimeo o un enlace directo a un archivo de video compatible."
      )

      return
    }

    const hasInvalidDraftSpecification =
      draftSpecifications.some(
        (specification) =>
          !specification.icono.trim() ||
          !isAllowedLucideIcon(
            specification.icono.trim()
          ) ||
          !specification.texto.trim() ||
          !Number.isFinite(
            Number(specification.orden)
          )
      )

    if (hasInvalidDraftSpecification) {
      setError(
        "Completá ícono, texto y orden en todas las especificaciones."
      )

      return
    }

    if (
      !producto &&
      !savedId &&
      !draftVariants.length
    ) {
      setError(
        "Agregá al menos una variante con su stock."
      )

      return
    }

    const hasInvalidDraftVariant =
      draftVariants.some(
        (variant) =>
          !variant.nombre.trim() ||
          !/^#[0-9A-F]{6}$/i.test(
            variant.color_hex
          ) ||
          !Number.isFinite(
            Number(variant.stock)
          ) ||
          Number(variant.stock) < 0
      )

    if (hasInvalidDraftVariant) {
      setError(
        "Completá correctamente el nombre, el color y el stock de todas las variantes."
      )

      return
    }

    try {
      setSaving(true)

      const variantsStock =
        draftVariants.reduce(
          (total, variant) =>
            total +
            (Number(
              variant.stock
            ) || 0),
          0
        )

      const nextPayload = {
        ...payload,
        stock:
          draftVariants.length
            ? variantsStock
            : payload.stock,
      }

      if (producto) {
        await updateProducto(
          producto.id,
          nextPayload
        )

        setSuccess(
          "Producto actualizado correctamente."
        )
        onSaved()

        return
      }

      if (savedId) {
        await updateProducto(
          savedId,
          nextPayload
        )

        if (draftSpecifications.length) {
          await saveDraftProductoEspecificaciones(
            savedId,
            draftSpecifications
          )
        }

        setSuccess(
          "Producto actualizado correctamente."
        )
        onSaved()

        return
      }

      let imageOrder = 0
      let principalImage: string | null =
        null
      const uploadedImageUrls: string[] = []
      const imagenes: Array<{
        url: string
        orden: number
      }> = []
      const variantes: Array<{
        nombre: string
        color_hex: string
        stock: number
        imagenes: string[]
        activo: boolean
        orden: number
      }> = []

      for (const [
        index,
        variant,
      ] of draftVariants.entries()) {
        const urls =
          variant.imagenes.length
            ? await uploadProductoDraftImages(
                variant.imagenes
              )
            : []

        uploadedImageUrls.push(...urls)

        if (!principalImage && urls[0]) {
          principalImage = urls[0]
        }

        imagenes.push(
          ...urls.map((url) => {
            imageOrder += 1

            return {
              url,
              orden: imageOrder,
            }
          })
        )

        variantes.push({
          nombre:
            variant.nombre.trim(),
          color_hex:
            variant.color_hex,
          stock:
            Number(
              variant.stock
            ) || 0,
          imagenes: urls,
          activo: true,
          orden: index + 1,
        })
      }

      try {
        const created =
          await createProductoCompleto({
            producto: {
              ...nextPayload,
              imagen_principal:
                principalImage,
            },
            imagenes,
            variantes,
            especificaciones:
              draftSpecifications.map(
                (specification) => ({
                  icono:
                    specification.icono,
                  texto:
                    specification.texto,
                  orden:
                    specification.orden,
                  activo:
                    specification.activo,
                })
              ),
          })

        setSavedId(created.id)
        onDraftSaved?.()
        setSuccess(
          "Producto creado correctamente."
        )
        onSaved()
      } catch (err) {
        if (uploadedImageUrls.length) {
          try {
            await deleteProductoImagesByUrls(
              uploadedImageUrls
            )
          } catch (cleanupErr) {
            console.error(
              "No se pudieron limpiar las imágenes de borrador:",
              cleanupErr
            )
          }
        }

        throw err
      }
    } catch (err) {
      const message =
        getErrorMessage(err)
      const errorDetails =
        getErrorDetails(err)

      console.warn(
        "Error guardando producto:",
        errorDetails
      )

      setError(
        `Error guardando producto: ${message}`
      )
    } finally {
      setSaving(false)
    }
  }

  return {
    form,
    error,
    success,
    saving,
    savedId,
    categorias,

    setField,

    submit,

    handleNombreChange,
  }
}
