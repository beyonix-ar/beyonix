import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const COMPONENT_SOURCE = readFileSync("components/phone/argentina-phone-input.tsx", "utf8")

test("único punto de normalización: reutiliza lib/validation/phone-ar.ts, no reimplementa su propio regex/replace de teléfono", () => {
  assert.match(
    COMPONENT_SOURCE,
    /import \{\s*ARGENTINA_PHONE_PREFIX,\s*normalizeArgentineNationalPhone,\s*\} from "@\/lib\/validation\/phone-ar"/,
  )
  assert.doesNotMatch(COMPONENT_SOURCE, /replace\(\/\\D/)
})

test("el maxLength nativo del <input> NUNCA usa el largo canónico -- eso trunca los caracteres crudos (+, espacios, guiones) antes de poder normalizarlos; el largo final ya lo acota normalizeArgentineNationalPhone", () => {
  const inputIndex = COMPONENT_SOURCE.indexOf("<input")
  const inputBlock = COMPONENT_SOURCE.slice(inputIndex, COMPONENT_SOURCE.indexOf("/>", inputIndex))

  assert.doesNotMatch(inputBlock, /maxLength=\{ARGENTINA_NATIONAL_PHONE_MAX_LENGTH\}/)
})

test("el +54 es fijo y no editable -- se renderiza en un <span>, nunca dentro del <input>", () => {
  const spanIndex = COMPONENT_SOURCE.indexOf("<span")
  const inputIndex = COMPONENT_SOURCE.indexOf("<input")
  assert.ok(spanIndex >= 0 && spanIndex < inputIndex, "el prefijo +54 debe ser un <span> antes del <input>")
  assert.match(COMPONENT_SOURCE, /\{ARGENTINA_PHONE_PREFIX\}/)

  const inputBlock = COMPONENT_SOURCE.slice(inputIndex, COMPONENT_SOURCE.indexOf("/>", inputIndex))
  assert.doesNotMatch(inputBlock, /ARGENTINA_PHONE_PREFIX/)
})

test("helper \"No agregues el 0\" siempre visible salvo que se pida explícitamente ocultarlo", () => {
  assert.match(COMPONENT_SOURCE, /No agregues el 0\./)
  assert.match(COMPONENT_SOURCE, /hideHelper/)
})

test("nunca hardcodea un ancho/estilo dark-only: por default usa los tokens --account-* (theme-aware en Light/Dark), pero admite override por página (login/checkout con su propio esquema)", () => {
  assert.match(COMPONENT_SOURCE, /--account-input/)
  assert.match(COMPONENT_SOURCE, /--account-border/)
  assert.match(COMPONENT_SOURCE, /--account-text-primary/)
  assert.match(COMPONENT_SOURCE, /outerClassName/)
  assert.match(COMPONENT_SOURCE, /prefixClassName/)
  assert.match(COMPONENT_SOURCE, /inputClassName/)
})

test("value/onChange siempre trabajan en el canónico: el valor mostrado se deriva con normalizeArgentineNationalPhone, nunca se muestra el raw crudo tal cual llega", () => {
  assert.match(COMPONENT_SOURCE, /const displayValue = normalizeArgentineNationalPhone\(value\)/)
  assert.match(COMPONENT_SOURCE, /value=\{displayValue\}/)
})

test("autocorrección al cargar: si el valor recibido no está en formato canónico (teléfono viejo con +54/0/guiones), se empuja la versión limpia hacia el padre sin esperar a que el usuario edite", () => {
  const effectIndex = COMPONENT_SOURCE.indexOf("useEffect")
  assert.ok(effectIndex >= 0)
  const effectBlock = COMPONENT_SOURCE.slice(effectIndex, COMPONENT_SOURCE.indexOf("}, [value])") + 20)
  assert.match(effectBlock, /displayValue !== value/)
  assert.match(effectBlock, /onChange\(displayValue\)/)
})
