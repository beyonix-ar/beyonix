import assert from "node:assert/strict"
import test from "node:test"

import {
  getPublicFirstName,
  getPublicReviewerName,
  PUBLIC_REVIEWER_FALLBACK_NAME,
} from "./public-name.ts"

test("B. primer nombre con formato prolijo: mayúscula inicial y resto en minúscula", () => {
  const cases: Array<[string, string]> = [
    ["LUCAS", "Lucas"],
    ["lucas", "Lucas"],
    ["rOMINA", "Romina"],
    ["maría", "María"],
    ["LUCAS ALBERTO", "Lucas"],
    ["María José", "María"],
    ["  ágata   Pérez ", "Ágata"],
    ["ÑANDÚ", "Ñandú"],
    ["güemes", "Güemes"],
    ["ANA-LÍA Gómez", "Ana-Lía"],
    ["d'angelo", "D'Angelo"],
  ]
  for (const [input, expected] of cases) {
    assert.equal(getPublicFirstName(input), expected, input)
  }
})

test("B. nunca apellido, username, email ni valores inválidos", () => {
  assert.equal(getPublicFirstName("Lucas Espinosa"), "Lucas")
  for (const invalid of ["", "   ", "antares_99", "lucas@example.com", "12345", "Lu$as", null, undefined, 42]) {
    assert.equal(getPublicFirstName(invalid), null, String(invalid))
  }
  assert.equal(getPublicReviewerName("antares_99"), PUBLIC_REVIEWER_FALLBACK_NAME)
  assert.equal(getPublicReviewerName(null), "Cliente verificado")
  assert.equal(getPublicFirstName("A".repeat(30)), null, "nombres absurdamente largos no se publican")
})

test("las formas Unicode compuestas y descompuestas dan el mismo nombre", () => {
  assert.equal(getPublicFirstName("María"), "María")
  assert.equal(getPublicFirstName("MARÍA"), getPublicFirstName("María"))
})
