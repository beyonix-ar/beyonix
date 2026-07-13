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
  username: 18,
  name: 60,
  email: 120,
  address: 180,
  province: 30,
  postalCode: 8,
  phone: 15,
  dni: 8,
  password: 20,
  loginIdentifier: 120,
  references: 80,
}

function isArgentinaProvince(value: string) {
  const normalized = value.trim().toLocaleUpperCase("es-AR")

  return ARGENTINA_PROVINCES.some(
    (province) => province.toLocaleUpperCase("es-AR") === normalized
  )
}

export type RegisterValidationPayload = {
  username: string
  name: string
  email: string
  address: string
  street: string
  streetNumber: string
  locality: string
  province: string
  postalCode: string
  phone: string
  password: string
  references?: string
}

export type ProfileValidationPayload = {
  name: string
  calle: string
  numero: string
  piso?: string
  departamento?: string
  localidad: string
  province: string
  postalCode: string
  phone: string
  dni: string
  references?: string
}

export function onlyDigits(value: string, maxLength: number) {
  return value.replace(/\D/g, "").slice(0, maxLength)
}

function hasCommonAllowedChars(value: string) {
  return /^[\p{L}\p{M}0-9\s.,'°/-]+$/u.test(value)
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

export function getPasswordRequirements(password: string) {
  return [
    {
      label: "Mínimo 8 caracteres",
      met: password.length >= 8,
    },
    {
      label: "Una letra mayúscula",
      met: /\p{Lu}/u.test(password),
    },
    {
      label: "Una letra minúscula",
      met: /\p{Ll}/u.test(password),
    },
    {
      label: "Un número",
      met: /[0-9]/.test(password),
    },
  ]
}

export function meetsPasswordRequirements(password: string) {
  return (
    password.length <= FIELD_LIMITS.password &&
    getPasswordRequirements(password).every((requirement) => requirement.met)
  )
}

export function validatePassword(password: string) {
  if (password.length < 8) {
    return "La contraseña debe tener al menos 8 caracteres."
  }

  if (password.length > FIELD_LIMITS.password) {
    return "La contraseña no puede superar los 20 caracteres."
  }

  if (!/\p{Lu}/u.test(password)) {
    return "La contraseña debe incluir al menos una mayúscula."
  }

  if (!/\p{Ll}/u.test(password)) {
    return "La contraseña debe incluir al menos una minúscula."
  }

  if (!/[0-9]/.test(password)) {
    return "La contraseña debe incluir al menos un número."
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
      pattern: /^[\p{L}\p{M}\s'-]+$/u,
      allowedHint: "Usá solo letras, espacios, apóstrofe o guion en el nombre.",
    }
  )
  if (nameError) return nameError

  const emailError = validateEmail(data.email)
  if (emailError) return emailError

  const streetError = validateCleanText(data.street, "la calle", 60, {
    minLength: 2,
    pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
    allowedHint: "Usá solo letras, números y signos comunes en la calle.",
  })
  if (streetError) return streetError

  if (!/^\d{1,8}$/.test(data.streetNumber.trim())) {
    return "El número de calle es obligatorio y debe tener hasta 8 números."
  }

  const addressError = validateCleanText(
    data.address,
    "tu dirección",
    FIELD_LIMITS.address,
    {
      minLength: 5,
      pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
      allowedHint: "Usá solo letras, números y signos comunes de dirección.",
    }
  )
  if (addressError) return addressError

  const localityError = validateCleanText(data.locality, "la localidad", 60, {
    minLength: 2,
    pattern: /^[\p{L}\p{M}0-9\s.,'-]+$/u,
    allowedHint: "Usá solo letras, números y signos comunes en la localidad.",
  })
  if (localityError) return localityError

  if (!data.province.trim() || !isArgentinaProvince(data.province)) {
    return "Seleccioná una provincia válida."
  }

  if (!/^\d{4,8}$/.test(data.postalCode.trim())) {
    return "El código postal debe tener entre 4 y 8 números."
  }

  if (!/^\d{8,15}$/.test(data.phone.trim())) {
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
        pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
        allowedHint:
          "Usá solo letras, números y signos comunes en las referencias.",
      }
    )
    if (referencesError) return referencesError
  }

  if (data.address.trim() && !hasCommonAllowedChars(data.address)) {
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
      pattern: /^[\p{L}\p{M}\s'-]+$/u,
      allowedHint: "Usá solo letras, espacios, apóstrofe o guion en el nombre.",
    }
  )
  if (nameError) return nameError

  if (!/^\d{7,8}$/.test(data.dni.trim())) {
    return "Ingresá un DNI válido de 7 u 8 números."
  }

  const streetError = validateCleanText(data.calle, "la calle", 60, {
    minLength: 2,
    pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
    allowedHint: "Usá solo letras, números y signos comunes en la calle.",
  })
  if (streetError) return streetError

  if (!/^\d{1,8}$/.test(data.numero.trim())) {
    return "Ingresá el número de calle."
  }

  if (data.piso?.trim()) {
    const floorError = validateCleanText(data.piso, "el piso", 12, {
      pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
      allowedHint: "Usá solo letras, números y signos comunes en el piso.",
    })
    if (floorError) return floorError
  }

  if (data.departamento?.trim()) {
    const apartmentError = validateCleanText(
      data.departamento,
      "el departamento",
      12,
      {
        pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
        allowedHint:
          "Usá solo letras, números y signos comunes en el departamento.",
      }
    )
    if (apartmentError) return apartmentError
  }

  const localityError = validateCleanText(data.localidad, "la localidad", 60, {
    minLength: 2,
    pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
    allowedHint: "Usá solo letras, números y signos comunes en la localidad.",
  })
  if (localityError) return localityError

  if (!isArgentinaProvince(data.province)) {
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
        pattern: /^[\p{L}\p{M}0-9\s.,'°/-]+$/u,
        allowedHint:
          "Usá solo letras, números y signos comunes en las referencias.",
      }
    )
    if (referencesError) return referencesError
  }

  return ""
}
