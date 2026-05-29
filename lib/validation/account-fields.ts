import { hasBlockedWords, validateUsername } from "@/lib/validation/content-filter"

export const ARGENTINA_PROVINCES = [
  "Buenos Aires",
  "CABA",
  "Catamarca",
  "Chaco",
  "Chubut",
  "Córdoba",
  "Corrientes",
  "Entre Ríos",
  "Formosa",
  "Jujuy",
  "La Pampa",
  "La Rioja",
  "Mendoza",
  "Misiones",
  "Neuquén",
  "Río Negro",
  "Salta",
  "San Juan",
  "San Luis",
  "Santa Cruz",
  "Santa Fe",
  "Santiago del Estero",
  "Tierra del Fuego",
  "Tucumán",
]

export const FIELD_LIMITS = {
  username: 24,
  name: 60,
  email: 120,
  address: 90,
  province: 30,
  postalCode: 8,
  phone: 15,
  password: 20,
  loginIdentifier: 120,
  references: 180,
}

export type RegisterValidationPayload = {
  username: string
  name: string
  email: string
  address: string
  province: string
  postalCode: string
  phone: string
  password: string
  references?: string
}

export type ProfileValidationPayload = {
  name: string
  address: string
  province: string
  postalCode: string
  phone: string
  references?: string
}

export function onlyDigits(value: string, maxLength: number) {
  return value.replace(/\D/g, "").slice(0, maxLength)
}

function hasCommonAllowedChars(value: string) {
  return /^[a-zA-ZÀ-ÿ0-9\s.,'°/-]+$/.test(value)
}

function validateCleanText(
  value: string,
  label: string,
  maxLength: number,
  options?: {
    minLength?: number
    pattern?: RegExp
    allowedHint?: string
  }
) {
  const trimmed = value.trim()

  if (!trimmed) {
    return `Ingresá ${label}.`
  }

  if (options?.minLength && trimmed.length < options.minLength) {
    return `${label} debe tener al menos ${options.minLength} caracteres.`
  }

  if (trimmed.length > maxLength) {
    return `${label} no puede superar los ${maxLength} caracteres.`
  }

  if (hasBlockedWords(trimmed)) {
    return `${label} contiene texto no permitido.`
  }

  if (options?.pattern && !options.pattern.test(trimmed)) {
    return options.allowedHint ?? `${label} contiene caracteres no permitidos.`
  }

  return ""
}

export function validateEmail(email: string) {
  const trimmed = email.trim()

  if (!trimmed) {
    return "Ingresá tu email."
  }

  if (trimmed.length > FIELD_LIMITS.email) {
    return "El email no puede superar los 120 caracteres."
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "Ingresá un email válido."
  }

  if (hasBlockedWords(trimmed)) {
    return "El email contiene texto no permitido."
  }

  return ""
}

export function validatePassword(password: string) {
  if (password.length < 6) {
    return "La contraseña debe tener al menos 6 caracteres."
  }

  if (password.length > FIELD_LIMITS.password) {
    return "La contraseña no puede superar los 20 caracteres."
  }

  return ""
}

export function validateRegisterPayload(data: RegisterValidationPayload) {
  const usernameError = validateUsername(data.username)
  if (usernameError) return usernameError

  const nameError = validateCleanText(
    data.name,
    "tu nombre y apellido",
    FIELD_LIMITS.name,
    {
      minLength: 3,
      pattern: /^[a-zA-ZÀ-ÿ\s'-]+$/,
      allowedHint: "Usá solo letras, espacios, apóstrofe o guion en el nombre.",
    }
  )
  if (nameError) return nameError

  const emailError = validateEmail(data.email)
  if (emailError) return emailError

  const addressError = validateCleanText(
    data.address,
    "tu dirección",
    FIELD_LIMITS.address,
    {
      minLength: 5,
      pattern: /^[a-zA-ZÀ-ÿ0-9\s.,'°/-]+$/,
      allowedHint: "Usá solo letras, números y signos comunes de dirección.",
    }
  )
  if (addressError) return addressError

  if (!ARGENTINA_PROVINCES.includes(data.province)) {
    return "Seleccioná una provincia válida."
  }

  if (!/^\d{4,8}$/.test(data.postalCode)) {
    return "El código postal debe tener entre 4 y 8 números."
  }

  if (!/^\d{8,15}$/.test(data.phone)) {
    return "El teléfono móvil debe tener entre 8 y 15 números."
  }

  const passwordError = validatePassword(data.password)
  if (passwordError) return passwordError

  if (data.references?.trim()) {
    const referencesError = validateCleanText(
      data.references,
      "las referencias",
      FIELD_LIMITS.references,
      {
        pattern: /^[a-zA-ZÀ-ÿ0-9\s.,'°/-]+$/,
        allowedHint:
          "Usá solo letras, números y signos comunes en las referencias.",
      }
    )
    if (referencesError) return referencesError
  }

  if (!hasCommonAllowedChars(data.address)) {
    return "La dirección contiene caracteres no permitidos."
  }

  return ""
}

export function validateProfilePayload(data: ProfileValidationPayload) {
  const nameError = validateCleanText(
    data.name,
    "tu nombre y apellido",
    FIELD_LIMITS.name,
    {
      minLength: 3,
      pattern: /^[a-zA-ZÀ-ÿ\s'-]+$/,
      allowedHint: "Usá solo letras, espacios, apóstrofe o guion en el nombre.",
    }
  )
  if (nameError) return nameError

  const addressError = validateCleanText(
    data.address,
    "tu dirección",
    FIELD_LIMITS.address,
    {
      minLength: 5,
      pattern: /^[a-zA-ZÀ-ÿ0-9\s.,'°/-]+$/,
      allowedHint: "Usá solo letras, números y signos comunes de dirección.",
    }
  )
  if (addressError) return addressError

  if (!ARGENTINA_PROVINCES.includes(data.province)) {
    return "Seleccioná una provincia válida."
  }

  if (!/^\d{4,8}$/.test(data.postalCode)) {
    return "El código postal debe tener entre 4 y 8 números."
  }

  if (!/^\d{8,15}$/.test(data.phone)) {
    return "El teléfono móvil debe tener entre 8 y 15 números."
  }

  if (data.references?.trim()) {
    const referencesError = validateCleanText(
      data.references,
      "las referencias",
      FIELD_LIMITS.references,
      {
        pattern: /^[a-zA-ZÀ-ÿ0-9\s.,'°/-]+$/,
        allowedHint:
          "Usá solo letras, números y signos comunes en las referencias.",
      }
    )
    if (referencesError) return referencesError
  }

  return ""
}
