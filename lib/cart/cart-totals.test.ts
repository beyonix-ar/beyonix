import assert from "node:assert/strict"
import test from "node:test"

import { calculateCartTotals } from "./cart-totals.ts"
import { getCartInstallmentEligibility } from "../products/installments.ts"

// CASO H (informe de precio único): carrito multiproducto, cada producto con
// su propio precio público y su propio tope de cuotas habilitado.
test("CASO H: calculateCartTotals nunca recibe ni usa la modalidad de cuotas -- el subtotal es siempre la suma de precios públicos, constante entre 1/2/3/6", () => {
  const productoA = { id: 1, precio: 6_000 }
  const productoB = { id: 2, precio: 10_000 }

  const items = [
    { product: productoA, quantity: 1 },
    { product: productoB, quantity: 1 },
  ]

  const totals = calculateCartTotals(items)

  // $6.000 + $10.000 = $16.000, sin importar qué cuota se vaya a elegir en
  // Checkout después -- calculateCartTotals ni siquiera acepta un parámetro
  // de cuotas: estructuralmente no puede grossear el total.
  assert.equal(totals.subtotal, 16_000)
  assert.equal(totals.productsTotal, 16_000)

  // Repetir el cálculo N veces (simulando que el cliente cambia de cuota en
  // el checkout, lo que NO dispara ningún recálculo de carrito) da siempre
  // el mismo resultado.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(calculateCartTotals(items).productsTotal, 16_000)
  }
})

test("CASO H: disponibilidad de cuotas del carrito -- intersección entre productos con distinto tope, el subtotal no depende de cuál quede habilitada", () => {
  // Producto A: $6.000, hasta 6 cuotas. Producto B: $10.000, hasta 3 cuotas.
  const productoA = {
    id: 1,
    precio: 6_000,
    cuotas_2_habilitadas: true,
    cuotas_3_habilitadas: true,
    cuotas_6_habilitadas: true,
  }
  const productoB = {
    id: 2,
    precio: 10_000,
    cuotas_2_habilitadas: true,
    cuotas_3_habilitadas: true,
    cuotas_6_habilitadas: false,
  }

  // El carrito sólo ofrece 2 y 3 (6 queda afuera porque B no lo permite).
  assert.deepEqual(getCartInstallmentEligibility([productoA, productoB]), [2, 3])

  const totals = calculateCartTotals([
    { product: productoA, quantity: 1 },
    { product: productoB, quantity: 1 },
  ])
  // El subtotal ($16.000) es el mismo sin importar cuál de las dos
  // modalidades ofrecidas termine eligiendo el cliente.
  assert.equal(totals.productsTotal, 16_000)
})
