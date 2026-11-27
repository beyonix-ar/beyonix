import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  validateEmail,
  validateNamePart,
  validateProfilePayload,
  validateRegisterPayload,
  type ProfileValidationPayload,
  type RegisterValidationPayload,
} from "./account-fields.ts"
import { validatePublicText, validateUsername } from "./content-filter.ts"
import {
  buildDeliveryAddressDraft,
  validateDeliveryAddress,
} from "../account/account-utils.ts"

/**
 * Regresión del P1 de la auditoría de registro (2026-11-27): la moderación de
 * contenido buscaba raíces ofensivas como substring sobre el texto compactado
 * (sin espacios, dígitos y "@" convertidos en letras) y la aplicaba a
 * identidad y domicilio. Rechazaba "Mariano" (ano), "Ortiz" (ort),
 * "Tomás Sánchez" (ass), "Ana López" (anal), "Belgrano", "juan07@…", etc.
 * Esos campos no son contenido público: sólo se valida formato y longitud.
 */

const BASE_REGISTER: RegisterValidationPayload = {
  username: "cliente01",
  name: "Laura Pérez",
  email: "laura.perez@gmail.com",
  dni: "30123456",
  address: "Mitre 1234, ROSARIO, Santa Fe, CP 2000",
  street: "Mitre",
  streetNumber: "1234",
  locality: "ROSARIO",
  province: "Santa Fe",
  postalCode: "2000",
  phone: "3415551234",
  password: "Clave1234",
}

const BASE_PROFILE: ProfileValidationPayload = {
  name: "Laura Pérez",
  calle: "Mitre",
  numero: "1234",
  localidad: "ROSARIO",
  province: "Santa Fe",
  postalCode: "2000",
  phone: "3415551234",
  dni: "30123456",
}

const FIRST_NAMES = ["Mariano", "Luciano", "Emiliano", "Penélope", "Analía", "Gilda", "Stefano"]
const LAST_NAMES = [
  "Ortiz", "Ortega", "Cortés", "Romano", "Serrano", "Lozano", "Solano", "Galeano",
  "Vergara", "Gil", "Massa", "Medrano", "Soriano", "Toscano", "Portillo",
]
const FULL_NAMES = [
  "Tomás Sánchez", "Lucas Sosa", "Nicolás Suárez", "Matías Silva", "Ana López",
  "Ana Laura Gómez", "Juan Ojeda", "Julián Olivera", "Sebastián Ortiz",
]
const STREETS = ["Belgrano", "Mariano Moreno", "Portugal", "Ortiz de Ocampo", "Italiano"]
const STREETS_WITH_NUMBER: Array<[string, string]> = [
  ["Rioja", "557"], ["Paraguay", "455"], ["Mendoza", "5500"],
]
const LOCALITIES = ["BELGRANO", "TORTUGUITAS", "MARIANO ACOSTA"]
const EMAILS = [
  "mariano.lopez@gmail.com", "juan07@gmail.com", "tomassosa@hotmail.com",
  "ana.lopez@gmail.com", "jortiz@yahoo.com.ar", "victor7@gmail.com",
]
const USERNAMES = ["mariano.lopez", "juan07", "tomassosa", "ana.lopez", "jortiz", "victor7", "gil_massa"]

function registerAddress(street: string, number: string, locality = "ROSARIO") {
  return `${street} ${number}, ${locality}, Santa Fe, CP 2000`
}

test("registro: nombres y apellidos legítimos de la auditoría se aceptan por separado", () => {
  for (const name of FIRST_NAMES) assert.equal(validateNamePart(name, "tu nombre"), "", name)
  for (const name of LAST_NAMES) assert.equal(validateNamePart(name, "tu apellido"), "", name)
})

test("registro: nombres completos que cruzaban la frontera entre palabras se aceptan", () => {
  for (const name of [...FULL_NAMES, ...FIRST_NAMES.map((first) => `${first} Ortiz`)]) {
    assert.equal(validateRegisterPayload({ ...BASE_REGISTER, name }), "", name)
  }
})

test("registro: calles, calle+número y localidades legítimas se aceptan", () => {
  for (const street of STREETS) {
    assert.equal(
      validateRegisterPayload({ ...BASE_REGISTER, street, address: registerAddress(street, "1234") }),
      "",
      street,
    )
  }
  for (const [street, streetNumber] of STREETS_WITH_NUMBER) {
    assert.equal(
      validateRegisterPayload({
        ...BASE_REGISTER,
        street,
        streetNumber,
        address: registerAddress(street, streetNumber),
      }),
      "",
      `${street} ${streetNumber}`,
    )
  }
  for (const locality of LOCALITIES) {
    assert.equal(
      validateRegisterPayload({ ...BASE_REGISTER, locality, address: registerAddress("Mitre", "1234", locality) }),
      "",
      locality,
    )
  }
})

test("registro: emails y usuarios derivados de nombres reales se aceptan", () => {
  for (const email of EMAILS) {
    assert.equal(validateEmail(email), "", email)
    assert.equal(validateRegisterPayload({ ...BASE_REGISTER, email }), "", email)
  }
  for (const username of USERNAMES) {
    assert.equal(validateUsername(username), "", username)
    assert.equal(validateRegisterPayload({ ...BASE_REGISTER, username }), "", username)
  }
})

test("registro: referencias de entrega con nombres de calles se aceptan", () => {
  assert.equal(
    validateRegisterPayload({ ...BASE_REGISTER, references: "Portón negro, entre Ortiz y Belgrano" }),
    "",
  )
})

test("perfil: edición con los mismos nombres y domicilios se acepta", () => {
  for (const name of [...FULL_NAMES, ...LAST_NAMES.map((last) => `Mariano ${last}`)]) {
    assert.equal(validateProfilePayload({ ...BASE_PROFILE, name }), "", name)
  }
  for (const calle of STREETS) {
    assert.equal(validateProfilePayload({ ...BASE_PROFILE, calle }), "", calle)
  }
  for (const localidad of LOCALITIES) {
    assert.equal(validateProfilePayload({ ...BASE_PROFILE, localidad }), "", localidad)
  }
  assert.equal(
    validateProfilePayload({ ...BASE_PROFILE, references: "Portón negro, entre Ortiz y Belgrano" }),
    "",
  )
})

test("direcciones de Mi Cuenta: calles y localidades legítimas se aceptan", () => {
  const cases: Array<[string, string, string]> = [
    ...STREETS.map((street): [string, string, string] => [street, "1234", "ROSARIO"]),
    ...STREETS_WITH_NUMBER.map(([street, number]): [string, string, string] => [street, number, "ROSARIO"]),
    ...LOCALITIES.map((locality): [string, string, string] => ["Mitre", "1234", locality]),
  ]
  for (const [street, streetNumber, locality] of cases) {
    const draft = buildDeliveryAddressDraft({
      postalCode: "2000",
      street,
      streetNumber,
      floor: "",
      apartment: "",
      locality,
      province: "Santa Fe",
    })
    assert.equal(validateDeliveryAddress(draft), "", `${street} ${streetNumber}, ${locality}`)
  }
})

test("checkout: el pago no vuelve a filtrar la dirección con moderación de contenido", () => {
  const source = readFileSync(new URL("../../app/checkout/page.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /content-filter|hasBlockedWords|texto no permitido/)
})

test("ningún módulo de identidad o domicilio vuelve a usar la moderación por substring", () => {
  const contentFilter = readFileSync(new URL("./content-filter.ts", import.meta.url), "utf8")
  const accountFields = readFileSync(new URL("./account-fields.ts", import.meta.url), "utf8")
  assert.doesNotMatch(contentFilter, /export function hasBlockedWords/)
  assert.doesNotMatch(accountFields, /hasBlockedWords|validatePublicText|texto no permitido/)
})

test("se mantienen las validaciones legítimas de formato y longitud", () => {
  assert.notEqual(validateNamePart("Juan3", "tu nombre"), "")
  assert.notEqual(validateNamePart("<script>", "tu nombre"), "")
  assert.notEqual(validateNamePart("J", "tu nombre"), "")
  assert.notEqual(validateNamePart("a".repeat(61), "tu nombre"), "")
  assert.notEqual(validateEmail("mariano.lopez"), "")
  assert.notEqual(validateEmail("mariano lopez@gmail.com"), "")
  assert.notEqual(validateEmail(`${"a".repeat(115)}@gmail.com`), "")
  assert.notEqual(validateUsername("ab"), "")
  assert.notEqual(validateUsername("mariano lopez"), "")
  assert.notEqual(validateUsername("mariano<b>"), "")
  assert.notEqual(validateRegisterPayload({ ...BASE_REGISTER, street: "Belgrano<script>" }), "")
  assert.notEqual(validateRegisterPayload({ ...BASE_REGISTER, streetNumber: "12A" }), "")
  assert.notEqual(validateRegisterPayload({ ...BASE_REGISTER, dni: "123" }), "")
})

test("la moderación de contenido público (reseñas) sigue activa", () => {
  for (const insult of ["sos un pelotudo", "qué mierda de producto", "p u t o"]) {
    assert.equal(validatePublicText(insult), "El texto contiene palabras no permitidas.", insult)
  }
  assert.equal(validatePublicText("Llegó rápido a Belgrano, gracias Mariano"), "")
})
