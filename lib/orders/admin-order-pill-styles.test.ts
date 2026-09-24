import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import postcss from "postcss"
import { getOrderEyeBadge } from "./admin-order-eye-badge.test-helper.ts"

const source = readFileSync(new URL("../../app/admin/sections/pedidos/admin-pedidos.tsx", import.meta.url), "utf8")
const css = postcss.parse(readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8"))
const ast = ts.createSourceFile("admin-pedidos.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const classes: string[] = []
function visit(node: ts.Node) {
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === "className") {
    classes.push(node.initializer?.getText(ast) ?? "")
  }
  ts.forEachChild(node, visit)
}
visit(ast)

test("pills de pedidos: ningún elemento nuevo queda expuesto a la heurística global", () => {
  const exposed = classes.filter((value) => value.includes("rounded-full") && value.includes("border"))
  assert.equal(exposed.length, 0)
  assert.equal(classes.filter((value) => value.includes("admin-order-pill")).length, 11)
})

test("contador del ojo: cero acciones no renderiza badge", () => {
  assert.equal(getOrderEyeBadge([]), null)
})

test("contador del ojo: cualquier acción urgente conserva el tono crítico", () => {
  const badge = getOrderEyeBadge([
    { kind: "invoice", label: "Emitir factura", urgent: false },
    { kind: "refund", label: "Reintegrar pago", urgent: true },
  ])
  assert.ok(badge)
  assert.ok(typeof badge.props.className === "string")
  assert.match(badge.props.className, /admin-order-eye-attention-badge--critical/)
  assert.doesNotMatch(badge.props.className, /admin-order-eye-attention-badge--warning/)
})

test("contador del ojo: acciones no urgentes conservan el tono ámbar", () => {
  const badge = getOrderEyeBadge([{ kind: "invoice", label: "Emitir factura", urgent: false }])
  assert.ok(badge)
  assert.ok(typeof badge.props.className === "string")
  assert.match(badge.props.className, /admin-order-eye-attention-badge--warning/)
  assert.doesNotMatch(badge.props.className, /admin-order-eye-attention-badge--critical/)
})

test("contador del ojo: muestra el count real sin truncarlo y preserva el tooltip", () => {
  for (const count of [1, 2, 12]) {
    const badge = getOrderEyeBadge(Array.from({ length: count }, () => ({
      kind: "claim" as const, label: "Revisar reclamo", urgent: true,
    })))
    assert.ok(badge)
    assert.equal(badge.props["data-pending-action-count"], count)
    assert.equal(badge.props.children, count)
    assert.equal(badge.props.role, "status")
    assert.ok(typeof badge.props.title === "string")
    assert.match(badge.props.title, /Revisar reclamo/)
  }
})

test("estado, despacho y pills: la forma semántica no depende de utilidades interceptadas", () => {
  for (const name of ["admin-order-status-badge", "admin-order-dispatch-badge", "admin-order-pill"]) {
    const usages = classes.filter((value) => value.includes(name))
    assert.ok(usages.length > 0, name)
    for (const usage of usages) assert.doesNotMatch(usage, /rounded-full/, name)
    const declarations = new Map<string, string>()
    css.walkRules((rule) => {
      if (rule.selector === `.${name}` || rule.selector === `.admin-order-detail-scope .${name}`) {
        rule.walkDecls((declaration) => { declarations.set(declaration.prop, declaration.value) })
      }
    })
    assert.equal(declarations.get("border-radius"), "9999px", name)
    assert.equal(declarations.get("border"), "1px solid transparent", name)
  }
})

test("tonos reutilizados: texto, fondo y borde definidos para detalle claro y filas oscuras", () => {
  for (const tone of ["danger", "success", "warning", "info", "muted"]) {
    for (const prefix of [
      ".beyonix-admin-main",
      'html[data-admin-theme="light"] .beyonix-admin-main',
      'html[data-admin-theme="light"] .beyonix-admin-main .admin-orders-list-row',
    ]) {
      const selector = `${prefix} .admin-order-tone-${tone}`
      const properties = new Set<string>()
      css.walkRules((rule) => {
        if (rule.selectors.includes(selector)) {
          rule.walkDecls((declaration) => { properties.add(declaration.prop) })
        }
      })
      assert.ok(properties.has("color"), selector)
      assert.ok(properties.has("border-color"), selector)
      assert.ok(properties.has("background") || properties.has("background-color"), selector)
    }
  }
})

test("recordatorio de despacho: identidad turquesa propia sin nuevos important", () => {
  for (const selector of [".admin-order-pill", ".admin-order-shipping-reminder", ".admin-order-shipping-reminder:hover"]) {
    let found = false
    css.walkRules((rule) => {
      if (rule.selector !== selector) return
      found = true
      rule.walkDecls((declaration) => { assert.ok(!declaration.important, selector) })
    })
    assert.ok(found, selector)
  }
  const reminder = classes.find((value) => value.includes("admin-order-shipping-reminder"))
  assert.ok(reminder)
  assert.doesNotMatch(reminder, /border-\[|text-\[|bg-\[/)
})
