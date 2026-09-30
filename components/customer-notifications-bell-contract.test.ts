import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
const bell = read("./customer-notifications-bell.tsx")
const css = read("../app/globals.css")

test("campana del navbar: botón compartido del header, negra sobre blanco en Light y #0D1117 en Dark; tamaño sin cambios", () => {
  assert.match(bell, /<Bell className="size-4\.5" \/>/)
  assert.match(bell, /className="beyonix-header-icon-button relative flex size-11 [^"]*rounded-full border/)
  // Sin colores en utilidades: los remapeos de Light por página no la alcanzan.
  assert.doesNotMatch(bell, /beyonix-header-icon-button[^"]*(bg-\[#|text-white|border-\[#)/)
  assert.match(
    css,
    /\.beyonix-header-icon-button \{\n  background-color: #0d1117;\n  border-color: #303846;\n  color: rgba\(255, 255, 255, 0\.8\);\n\}/,
  )
  assert.match(
    css,
    /html\[data-account-theme="light"\]\[data-account-scope\] \.beyonix-header-icon-button \{\n  background-color: #ffffff;\n  border-color: #303846;\n  color: #000000;\n\}/,
  )
})

test("badge de notificaciones: rojo con número, compacto y con aro del color del botón", () => {
  assert.match(bell, /\{unreadCount > 0 && \(\s*<span className="beyonix-notifications-badge /)
  assert.match(bell, /beyonix-notifications-badge[^"]*-right-0\.5 -top-0\.5[^"]*h-4\.5 min-w-4\.5[^"]*bg-red-600[^"]*tabular-nums text-white shadow-\[0_0_0_2px_#0D1117\]/)
  assert.match(bell, /\{unreadCount > 99 \? "99\+" : unreadCount\}/)
  assert.match(
    css,
    /html\[data-account-theme="light"\]\[data-account-scope\] \.beyonix-notifications-badge \{\n  box-shadow: 0 0 0 2px #fff;\n\}/,
  )
})
