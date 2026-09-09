"use client"

/**
 * Selector Provincia -> Localidad -> Código postal reutilizable fuera de
 * Checkout (hoy: registro en `app/login/page.tsx`). Deliberadamente NO
 * reimplementa la resolución territorial: delega en las mismas funciones
 * compartidas que usa `app/checkout/page.tsx`
 * (`lib/andreani/checkout-quote-client.ts`, que a su vez cachea contra
 * `/api/andreani/destinos` -- Georef + catálogo de Andreani), así que ambos
 * flujos quedan atados a una única fuente de verdad territorial y no pueden
 * divergir en qué provincia/localidad/CP se consideran válidos.
 *
 * Es un subconjunto intencional del efecto de Checkout: no conoce cotización
 * de envío ni compone una dirección completa (eso es responsabilidad de
 * quien consuma el hook), sólo resuelve el trío provincia/localidad/CP con
 * el mismo comportamiento (caché, fallback manual, canonicalización).
 */

import { useEffect, useRef, useState } from "react"

import {
  ARGENTINA_PROVINCES,
  normalizeArgentineLocality,
} from "@/lib/validation/account-fields"
import {
  findCanonicalLocality,
  getLocalitiesForProvince,
  getPostalCodesForLocality,
  peekLocalitiesForProvince,
  peekPostalCodesForLocality,
  resolvePostalCodeFromCatalog,
  type CheckoutLocalityOption,
  type CheckoutPostalCodeResult,
} from "@/lib/andreani/checkout-quote-client"

export interface TerritorialSelectOption {
  value: string
  label: string
}

export const TERRITORIAL_PROVINCE_OPTIONS: TerritorialSelectOption[] =
  ARGENTINA_PROVINCES.map((province) => {
    const value = province.toLocaleUpperCase("es-AR")
    return { value, label: value }
  })

export function useTerritorialSelector() {
  const [province, setProvinceValue] = useState("")
  const [locality, setLocalityValue] = useState("")
  const [postalCode, setPostalCodeValue] = useState("")

  const provinceRef = useRef(province)
  const localityRef = useRef(locality)
  const postalCodeRef = useRef(postalCode)

  const setProvince = (value: string) => {
    provinceRef.current = value
    setProvinceValue(value)
  }
  const setLocality = (value: string) => {
    localityRef.current = value
    setLocalityValue(value)
  }
  const setPostalCode = (value: string) => {
    postalCodeRef.current = value
    setPostalCodeValue(value)
  }

  const [localityOptions, setLocalityOptions] = useState<
    CheckoutLocalityOption[]
  >([])
  const [localitiesLoading, setLocalitiesLoading] = useState(false)
  const [localityLoadError, setLocalityLoadError] = useState("")

  const [postalCodeOptions, setPostalCodeOptions] = useState<string[]>([])
  const [postalCodesLoading, setPostalCodesLoading] = useState(false)
  const [postalCodeLoadError, setPostalCodeLoadError] = useState("")
  const [postalCodeRetryNonce, setPostalCodeRetryNonce] = useState(0)

  const [manualLocalityMode, setManualLocalityMode] = useState(false)
  const [manualPostalCodeMode, setManualPostalCodeMode] = useState(false)

  const localityRequestIdRef = useRef(0)
  const postalCodeRequestIdRef = useRef(0)

  // Provincia -> catálogo de localidades.
  useEffect(() => {
    const currentProvince = province.trim()
    if (!currentProvince) {
      setLocalityOptions([])
      setLocalitiesLoading(false)
      setLocalityLoadError("")
      return
    }
    if (manualLocalityMode) {
      setLocalitiesLoading(false)
      return
    }

    const requestId = ++localityRequestIdRef.current
    const isStale = () => localityRequestIdRef.current !== requestId

    const applyLocalities = (localities: CheckoutLocalityOption[]) => {
      setLocalityOptions(localities)

      const prevLocality = localityRef.current
      const prevPostalCode = postalCodeRef.current
      if (!prevLocality) return

      const canonical = findCanonicalLocality(localities, prevLocality)
      if (
        (canonical?.name ?? "") === prevLocality &&
        (canonical || !prevPostalCode)
      ) {
        return
      }

      setLocality(canonical?.name ?? "")
      if (!canonical) setPostalCode("")
    }

    const cached = peekLocalitiesForProvince(currentProvince)
    if (cached) {
      setLocalityLoadError("")
      applyLocalities(cached)
      setLocalitiesLoading(false)
      return
    }

    setLocalitiesLoading(true)
    setLocalityLoadError("")
    getLocalitiesForProvince(currentProvince)
      .then((localities) => {
        if (isStale()) return
        setLocalityLoadError("")
        applyLocalities(localities)
      })
      .catch(() => {
        if (isStale()) return
        setLocalityOptions([])
        setLocalityLoadError(
          "No pudimos cargar las localidades. Intentá nuevamente.",
        )
      })
      .finally(() => {
        if (!isStale()) setLocalitiesLoading(false)
      })
  }, [province, manualLocalityMode])

  // Provincia + localidad -> catálogo de códigos postales.
  useEffect(() => {
    const currentProvince = province.trim()
    const currentLocality = locality.trim()
    if (!currentProvince || !currentLocality) {
      setPostalCodeOptions([])
      setPostalCodesLoading(false)
      setPostalCodeLoadError("")
      return
    }
    if (manualLocalityMode || manualPostalCodeMode) {
      setPostalCodesLoading(false)
      return
    }

    const requestId = ++postalCodeRequestIdRef.current
    const isStale = () => postalCodeRequestIdRef.current !== requestId

    const applyPostalCodes = (result: CheckoutPostalCodeResult) => {
      const postalCodes = result.postalCodes.filter((code) =>
        /^\d{4}$/.test(code),
      )
      setPostalCodeOptions(postalCodes)

      const nextPostalCode = resolvePostalCodeFromCatalog(
        postalCodes,
        postalCodeRef.current,
      )
      const canonicalLocality = normalizeArgentineLocality(result.locality)

      if (
        canonicalLocality !== localityRef.current ||
        nextPostalCode !== postalCodeRef.current
      ) {
        setLocality(canonicalLocality)
        setPostalCode(nextPostalCode)
      }
    }

    const cached = peekPostalCodesForLocality(currentProvince, currentLocality)
    if (cached) {
      setPostalCodeLoadError("")
      applyPostalCodes(cached)
      setPostalCodesLoading(false)
      return
    }

    setPostalCodesLoading(true)
    setPostalCodeLoadError("")
    getPostalCodesForLocality(currentProvince, currentLocality)
      .then((result) => {
        if (isStale()) return
        setPostalCodeLoadError("")
        applyPostalCodes(result)
      })
      .catch((error: unknown) => {
        if (isStale()) return
        setPostalCodeOptions([])
        setPostalCodeLoadError(
          error instanceof Error
            ? error.message
            : "No pudimos cargar los códigos postales.",
        )
      })
      .finally(() => {
        if (!isStale()) setPostalCodesLoading(false)
      })
  }, [
    postalCodeRetryNonce,
    province,
    locality,
    manualLocalityMode,
    manualPostalCodeMode,
  ])

  const handleProvinceChange = (value: string) => {
    const normalizedValue = value.toLocaleUpperCase("es-AR")

    setLocalityOptions([])
    setLocalityLoadError("")
    setPostalCodeOptions([])
    setPostalCodeLoadError("")
    setManualLocalityMode(false)
    setManualPostalCodeMode(false)

    setProvince(normalizedValue)
    setLocality("")
    setPostalCode("")
  }

  const handleLocalityChange = (value: string) => {
    const normalizedValue = normalizeArgentineLocality(value)

    setPostalCodeOptions([])
    setPostalCodeLoadError("")
    setManualPostalCodeMode(false)

    setLocality(normalizedValue)
    setPostalCode("")
  }

  const handlePostalCodeChange = (value: string) => {
    setPostalCode(value)
  }

  const enableManualLocality = () => {
    setManualLocalityMode(true)
    setLocalityLoadError("")
    setLocalitiesLoading(false)
    setLocalityOptions([])
    setPostalCodesLoading(false)
    setPostalCodeOptions([])
    setPostalCodeLoadError("")
  }

  const disableManualLocality = () => {
    setManualLocalityMode(false)
    setManualPostalCodeMode(false)
    setLocality("")
    setPostalCode("")
  }

  const enableManualPostalCode = () => {
    setManualPostalCodeMode(true)
  }

  const retryPostalCodes = () => {
    setPostalCodeRetryNonce((current) => current + 1)
  }

  const localitySelectOptions: TerritorialSelectOption[] = localityOptions.map(
    (option) => ({ value: option.name, label: option.name }),
  )
  const postalCodeSelectOptions: TerritorialSelectOption[] =
    postalCodeOptions.map((code) => ({ value: code, label: code }))

  const cpEntryIsManual = manualLocalityMode || manualPostalCodeMode
  // "Sin códigos postales disponibles" es sólo para el resultado real de
  // cero CP -- si la request falló, `postalCodeLoadError` lo intercepta antes
  // (mismo criterio que Checkout).
  const showManualPostalCodeOption =
    !cpEntryIsManual &&
    Boolean(locality) &&
    !postalCodesLoading &&
    !postalCodeLoadError &&
    postalCodeOptions.length === 0

  return {
    province,
    locality,
    postalCode,
    provinceOptions: TERRITORIAL_PROVINCE_OPTIONS,
    localityOptions: localitySelectOptions,
    postalCodeOptions: postalCodeSelectOptions,
    localitiesLoading,
    localityLoadError,
    postalCodesLoading,
    postalCodeLoadError,
    manualLocalityMode,
    manualPostalCodeMode,
    cpEntryIsManual,
    showManualPostalCodeOption,
    handleProvinceChange,
    handleLocalityChange,
    handlePostalCodeChange,
    enableManualLocality,
    disableManualLocality,
    enableManualPostalCode,
    retryPostalCodes,
    setLocality,
  }
}

export type TerritorialSelector = ReturnType<typeof useTerritorialSelector>
