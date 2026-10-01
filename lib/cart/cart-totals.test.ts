import assert from "node:assert/strict"
import test from "node:test"

import { calculateCartTotals } from "./cart-totals.ts"

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

test("la financiación no depende de cada producto: el subtotal del carrito es la suma de precios por cantidad", () => {
  const productoA = { id: 1, precio: 6_000 }
  const productoB = { id: 2, precio: 10_000 }
  const totals = calculateCartTotals([
    { product: productoA, quantity: 2 },
    { product: productoB, quantity: 1 },
  ])
  // Las cuotas se deciden sobre el TOTAL a cobrar (Admin → Financiación),
  // nunca con topes por producto.
  assert.equal(totals.productsTotal, 22_000)
})
