import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(path, "utf8")
}

// --- Un único componente de teléfono en los 4 lugares donde se pide (ver
// auditoría: antes cada pantalla reimplementaba su propio onlyDigits/regex).

test("Registro (app/login/page.tsx) usa ArgentinaPhoneInput, no un <input> de teléfono suelto", () => {
  const page = source("app/login/page.tsx")

  assert.match(page, /import \{ ArgentinaPhoneInput \} from "@\/components\/phone\/argentina-phone-input"/)
  assert.match(page, /<ArgentinaPhoneInput/)
  // El viejo <Field name="phone" .../> con onlyDigits/FIELD_LIMITS.phone ya no existe.
  assert.doesNotMatch(page, /Field name="phone"/)
})

test("Registro alternativo desde Mi Cuenta (components/account/auth-forms.tsx RegisterForm) usa el mismo componente", () => {
  const authForms = source("components/account/auth-forms.tsx")

  assert.match(
    authForms,
    /import \{ ArgentinaPhoneInput \} from "@\/components\/phone\/argentina-phone-input"/,
  )
  assert.match(authForms, /<ArgentinaPhoneInput/)
  assert.doesNotMatch(authForms, /InputField label="Teléfono/)
})

test("Checkout (app/checkout/page.tsx) usa el mismo componente, no su propio replace(/\\D/g)", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.match(
    checkout,
    /import \{ ArgentinaPhoneInput \} from "@\/components\/phone\/argentina-phone-input"/,
  )
  assert.match(checkout, /<ArgentinaPhoneInput/)
  assert.match(
    checkout,
    /import \{\s*isValidArgentineNationalPhone,\s*normalizeArgentineNationalPhone,\s*\} from "@\/lib\/validation\/phone-ar"/,
  )
  // La validación de teléfono usa el validador compartido, no un largo hardcodeado propio.
  assert.match(checkout, /if \(!isValidArgentineNationalPhone\(telefono\)\) return "telefono"/)
})

test("Mi Cuenta (components/account/profile-sections.tsx) usa el mismo componente", () => {
  const profileSections = source("components/account/profile-sections.tsx")

  assert.match(
    profileSections,
    /import \{ ArgentinaPhoneInput \} from "@\/components\/phone\/argentina-phone-input"/,
  )
  assert.match(profileSections, /<ArgentinaPhoneInput/)
})

test("la validación central (lib/validation/account-fields.ts) usa isValidArgentineNationalPhone en Registro y Perfil, no una regex de teléfono propia duplicada", () => {
  const accountFields = source("lib/validation/account-fields.ts")

  assert.match(accountFields, /import \{ isValidArgentineNationalPhone \} from "\.\/phone-ar\.ts"/)

  const phoneChecks = [...accountFields.matchAll(/isValidArgentineNationalPhone\(data\.phone/g)]
  assert.equal(phoneChecks.length, 2, "validateRegisterPayload y validateProfilePayload deben usar el validador compartido")

  // La vieja regex /^\d{8,15}$/ (rango pensado para el string crudo con
  // +54/0 incluidos) ya no debe quedar en este archivo.
  assert.doesNotMatch(accountFields, /\\d\{8,15\}/)
})

test("backend: el PATCH de perfil normaliza al canónico server-side, nunca confía en que el cliente ya lo limpió", () => {
  const profileRoute = source("app/api/auth/profile/route.ts")

  assert.match(
    profileRoute,
    /import \{ normalizeArgentineNationalPhone \} from "@\/lib\/validation\/phone-ar"/,
  )
  assert.match(
    profileRoute,
    /payload\.telefono = normalizeArgentineNationalPhone\(optionalText\(body\.phone\)\) \|\| null/,
  )
})

test("registro (context/auth-context.tsx): el teléfono que viaja en el payload de signUp también pasa por el normalizador canónico antes de guardarse", () => {
  const authContext = source("context/auth-context.tsx")

  assert.match(
    authContext,
    /import \{ normalizeArgentineNationalPhone \} from "@\/lib\/validation\/phone-ar"/,
  )
  assert.match(authContext, /telefono: normalizeArgentineNationalPhone\(form\.phone\) \|\| null/)
})

test("checkout nunca reimplementa la normalización propia de Andreani (lib/andreani/order-shipment.ts normalizePhoneNumber) -- el campo teléfono sólo usa el validador compartido de phone-ar", () => {
  const checkout = source("app/checkout/page.tsx")

  assert.doesNotMatch(checkout, /normalizePhoneNumber/)
})
