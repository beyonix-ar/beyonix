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
  updateProductoCatalog,
} from "@/lib/supabase/queries/productos"

import { slugify } from "./helpers"
import {
  isPlayableProductVideo,
  isValidHttpsVideoUrl,
} from "@/lib/products/product-video"
import {
  parseOptionalProductLogistics,
  parseRequiredProductLogistics,
  ProductLogisticsValidationError,
  type ProductLogisticsField,
} from "@/lib/shipping/logistics-validation"

interface Props {
  producto?: SupabaseProducto | null
  onSaved: () => void
}

interface SubmitOptions {
  draftVariants?: DraftProductoVariante[]
  draftSpecifications?: DraftProductoEspecificacion[]
  primarySku?: string
  variantStates?: Record<number, boolean>
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
    details.code === "23514" &&
    /peso_empaquetado|alto_paquete|ancho_paquete|largo_paquete/i.test(
      `${details.message ?? ""} ${details.details ?? ""}`,
    )
  ) {
    return "Los datos de envío deben ser números positivos dentro de los límites permitidos."
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

  const [logisticsFieldError, setLogisticsFieldError] =
    useState<{ field: ProductLogisticsField; message: string } | null>(null)

  const [success, setSuccess] =
    useState("")

  const [savedId, setSavedId] =
    useState<number | null>(
      producto?.id ?? null
    )

  const [form, setForm] = useState<ProductoFormState>({
    nombre: (producto?.nombre ?? "").toUpperCase(),
    sku: (
      [...(producto?.producto_variantes ?? [])]
        .sort((left, right) => left.orden - right.orden || left.id - right.id)[0]
        ?.sku ?? producto?.sku ?? ""
    ).toUpperCase(),
    slug: producto?.slug ?? "",
    descripcion:
      producto?.descripcion ?? "",
    video_url:
      producto?.video_url ?? "",
    precio:
      Number(producto?.precio ?? 0) > 0
        ? String(producto?.precio)
        : "",
    precio_anterior:
      Number(producto?.precio_anterior ?? 0) > 0
        ? String(producto?.precio_anterior)
        : "",
    cuotas2: producto?.cuotas_2_habilitadas ?? false,
    cuotas3: producto?.cuotas_3_habilitadas ?? false,
    cuotas6: producto?.cuotas_6_habilitadas ?? false,
    categoria_id: String(
      producto?.categoria_id ?? ""
    ),
    destacado:
      producto?.destacado ?? false,
    activo:
      producto?.activo ?? false,
    peso_empaquetado_kg:
      producto?.peso_empaquetado_kg == null
        ? ""
        : String(producto.peso_empaquetado_kg),
    alto_paquete_cm:
      producto?.alto_paquete_cm == null ? "" : String(producto.alto_paquete_cm),
    ancho_paquete_cm:
      producto?.ancho_paquete_cm == null
        ? ""
        : String(producto.ancho_paquete_cm),
    largo_paquete_cm:
      producto?.largo_paquete_cm == null
        ? ""
        : String(producto.largo_paquete_cm),
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

  const showError = (message: string) => {
    setSuccess("")
    setError(message)
    setLogisticsFieldError(null)
  }

  const handleNombreChange = (
    value: string
  ) => {
    const upperValue = value.toUpperCase()
    setField("nombre", upperValue)

    if (!producto) {
      setField(
        "slug",
        slugify(upperValue)
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
    let logistics
    try {
      logistics = parseOptionalProductLogistics(form)
    } catch {
      logistics = {
        peso_empaquetado_kg: null,
        alto_paquete_cm: null,
        ancho_paquete_cm: null,
        largo_paquete_cm: null,
      }
    }

    return {
      nombre:
        form.nombre.trim(),

      sku:
        producto?.producto_variantes?.length
          ? null
          : form.sku.trim() || null,

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

      cuotas_2_habilitadas:
        form.cuotas2,

      cuotas_3_habilitadas:
        form.cuotas3,

      cuotas_6_habilitadas:
        form.cuotas6,

      promo_event_id:
        null,

      promo_original_precio:
        null,

      promo_original_precio_anterior:
        null,

      promo_original_descuento:
        null,

      promo_original_cuotas_2_habilitadas:
        null,

      promo_original_cuotas_3_habilitadas:
        null,

      promo_original_cuotas_6_habilitadas:
        null,

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

      ...logistics,
    }
  }, [form, producto?.producto_variantes?.length])

  const submit = async ({
    draftVariants = [],
    draftSpecifications = [],
    primarySku = form.sku,
    variantStates = {},
    onDraftSaved,
  }: SubmitOptions = {}) => {
    setError("")
    setSuccess("")
    setLogisticsFieldError(null)

    if (!form.nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    if (!Number.isFinite(payload.precio) || payload.precio < 0) {
      setError(
        "El precio no es válido."
      )

      return
    }

    if (form.activo && payload.precio <= 0) {
      setError(
        "Ingresá un precio mayor que cero antes de activar el producto."
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

    let logistics
    try {
      logistics = parseRequiredProductLogistics(form)
      for (const variant of draftVariants) {
        parseOptionalProductLogistics(variant)
      }
    } catch (validationError) {
      if (validationError instanceof ProductLogisticsValidationError) {
        setLogisticsFieldError({
          field: validationError.field,
          message: validationError.message,
        })
        setError(validationError.message)
      } else {
        setError("El peso y las dimensiones del producto son obligatorios.")
      }
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

    const hasInvalidDraftVariant =
      draftVariants.some(
        (variant) =>
          !/^#[0-9A-F]{6}$/i.test(
            variant.color_hex
          )
      )

    if (hasInvalidDraftVariant) {
      setError(
        "Completá correctamente el color de todas las variantes."
      )

      return
    }

    try {
      setSaving(true)

      const nextPayload = { ...payload, ...logistics }

      if (producto) {
        await updateProductoCatalog(
          producto.id,
          nextPayload,
          primarySku.trim() || null,
          variantStates,
        )

        setSuccess(
          "Producto actualizado correctamente."
        )
        onSaved()

        return
      }

      if (savedId) {
        await updateProductoCatalog(
          savedId,
          nextPayload,
          primarySku.trim() || null,
          variantStates,
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

      let principalImage: string | null =
        null
      const uploadedImageUrls: string[] = []
      const variantes: Array<{
        nombre: string
        sku: string | null
        color_hex: string
        imagenes: string[]
        activo: boolean
        orden: number
        peso_empaquetado_kg: number | null
        alto_paquete_cm: number | null
        ancho_paquete_cm: number | null
        largo_paquete_cm: number | null
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

        variantes.push({
          nombre:
            variant.nombre.trim(),
          sku:
            (index === 0 ? form.sku : variant.sku).trim() ||
            null,
          color_hex:
            variant.color_hex,
          imagenes: urls,
          activo: false,
          orden: index + 1,
          ...parseOptionalProductLogistics(variant),
        })
      }

      try {
        const created =
          await createProductoCompleto({
            producto: {
              ...nextPayload,
              sku: variantes.length ? null : nextPayload.sku,
              imagen_principal:
                principalImage,
            },
            // Las variantes ya contienen sus propias URLs. No se copian a
            // imagenes_producto, que queda reservada para productos simples.
            imagenes: [],
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

      setError(message)
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
    logisticsFieldError,

    setField,
    showError,

    submit,

    handleNombreChange,
  }
}
