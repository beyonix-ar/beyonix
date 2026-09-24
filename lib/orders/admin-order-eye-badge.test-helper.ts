import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createElement, isValidElement, type ReactElement } from "react"
import ts from "typescript"
import { formatAdminPendingActionCount, type AdminPendingOrderAction } from "./admin-pending-actions.ts"

// Ejecuta el componente real de presentación sin importar la pantalla ni su I/O.
const source = readFileSync(new URL("../../app/admin/sections/pedidos/admin-pedidos.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("admin-pedidos.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "OrderEyeAttentionBadge")
assert.ok(component, "falta el contador del ojo")
const compiled = ts.transpileModule(component.getText(ast), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText
const render = new Function("React", "formatAdminPendingActionCount", "actions", `${compiled}
  return OrderEyeAttentionBadge({ actions });`)

export function getOrderEyeBadge(actions: AdminPendingOrderAction[]): ReactElement<Record<string, unknown>> | null {
  const element: unknown = render({ createElement }, formatAdminPendingActionCount, actions)
  if (element === null) return null
  assert.ok(isValidElement<Record<string, unknown>>(element))
  return element
}
