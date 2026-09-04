import assert from "node:assert/strict"
import test from "node:test"

import { createCartSessionId } from "./cart-session-id.ts"

test("createCartSessionId usa crypto.randomUUID cuando está disponible (128 bits reales)", () => {
  const id = createCartSessionId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})

test("dos mil llamadas nunca colisionan (entropía suficiente para que adivinar sea inviable)", () => {
  const ids = new Set(Array.from({ length: 2000 }, () => createCartSessionId()))
  assert.equal(ids.size, 2000)
})

test("sin crypto.randomUUID, cae a crypto.getRandomValues (sigue siendo CSPRNG, nunca Math.random)", () => {
  const originalCrypto = globalThis.crypto
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
      configurable: true,
    })

    const id = createCartSessionId()
    // 16 bytes de crypto.getRandomValues -> 32 caracteres hex.
    assert.match(id, /^cart-[0-9a-f]{32}$/)
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
    })
  }
})

test("sin ninguna Web Crypto API, el último recurso sigue devolviendo un id no vacío y único", () => {
  const originalCrypto = globalThis.crypto
  try {
    // @ts-expect-error -- se fuerza la ausencia total de crypto para probar el último fallback.
    delete globalThis.crypto
    const first = createCartSessionId()
    const second = createCartSessionId()
    assert.ok(first.startsWith("cart-"))
    assert.notEqual(first, second)
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
    })
  }
})
