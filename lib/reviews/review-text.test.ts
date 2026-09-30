import assert from "node:assert/strict"
import test from "node:test"

import {
  isMeaningfulReviewText,
  REVIEW_COMMENT_MIN_LENGTH,
  validateReviewComment,
} from "./review-text.ts"
import { validatePublicText } from "../validation/content-filter.ts"

const VALID = [
  "Excelente producto",
  "Todo bien, llegó rápido",
  "Muy bueno!!!",
  "10 puntos, me encantó",
  "Buenísimo",
  "Muy bueno, muy bueno",
  "Perfecto",
  "El transporte fue rápido y el soporte, importante: atención impecable.",
  "Se lo regalé a mi hermano, lo usa hace un año con el mismo cariño",
  "Llegó anoche, súper ágil el envío",
  "La computadora llegó perfecta, está a la altura de lo esperado",
  "Lo uso en casa todos los días",
  "Pequeño, cómodo y ñoño en el mejor sentido",
]

const GARBAGE = [
  "aaaaaaaaaaaa",
  "aaaaaaaaaaaaaaaa",
  "jajajajajajajajaj",
  "111111111111",
  "asdfasdfasdfasdf",
  "asdfasdfasdf",
  "qwertyqwerty",
  "asdfghjkl",
  ".................",
  "!!!!!!!!!!!!!!",
  "?? ?? ?? ?? ?? ??",
  "123456789 123",
  "jejeje jijiji jajaja",
  "buenooooooooooooooooo",
]

test("F. comentario vacío o ausente se rechaza", () => {
  for (const value of ["", undefined, null, 42]) {
    const result = validateReviewComment(value)
    assert.equal(result.comment, "")
    assert.match(result.error, /Escribí un comentario/)
  }
})

test("G. comentario con solo espacios se rechaza", () => {
  for (const value of ["     ", "\n\t  \n", "   "]) {
    assert.match(validateReviewComment(value).error, /Escribí un comentario/)
  }
})

test("mínimo de caracteres útiles: 'bien', 'ok' y textos cortos se rechazan", () => {
  assert.equal(REVIEW_COMMENT_MIN_LENGTH, 8)
  for (const value of ["bien", "ok", "   ok   ", "Genial", "b i e n !!!!!!!", "Lindo!!!!!!!!"]) {
    assert.match(validateReviewComment(value).error, /al menos 8 letras o números/, value)
  }
})

test("H/I. basura evidente se rechaza con un mensaje claro", () => {
  for (const value of GARBAGE) {
    assert.equal(isMeaningfulReviewText(value), false, value)
    assert.notEqual(validateReviewComment(value).error, "", value)
  }
  assert.match(validateReviewComment("aaaaaaaaaaaa").error, /Contanos con palabras/)
  assert.match(validateReviewComment("asdfasdfasdfasdf").error, /Contanos con palabras/)
})

test("J. comentarios reales válidos se aceptan (Unicode, tildes y ñ incluidos)", () => {
  for (const value of VALID) {
    const result = validateReviewComment(value)
    assert.equal(result.error, "", `${value} -> ${result.error}`)
    assert.equal(result.comment, value)
  }
})

test("normaliza espacios y respeta el máximo de 150 caracteres", () => {
  assert.equal(validateReviewComment("  Excelente    producto  ").comment, "Excelente producto")
  assert.match(validateReviewComment(`Excelente producto ${"muy bueno ".repeat(20)}`).error, /hasta 150/)
})

test("K. la moderación existente sigue bloqueando insultos (incluso con evasiones)", () => {
  for (const value of [
    "Son unos pelotudos, nunca más",
    "Una mierda de atención",
    "Qué forros, tardaron un montón",
    "Esto es una m1erda total",
    "p u t o s los del envío",
    "son unos boludos todos",
    "hijos de puta, no respondieron",
  ]) {
    assert.equal(validatePublicText(value), "El texto contiene palabras no permitidas.", value)
    assert.equal(validateReviewComment(value).error, "El texto contiene palabras no permitidas.", value)
  }
})

test("datos privados: emails, teléfonos y direcciones con número se rechazan", () => {
  for (const value of [
    "Escribime a cliente@example.com por dudas",
    "Llamame al 341 555 1234 cuando quieras",
    "Entreguen en calle 123 por favor",
    "Mi DNI es 30123456 para la factura",
  ]) {
    assert.match(validateReviewComment(value).error, /No incluyas emails, teléfonos ni direcciones/, value)
  }
})
