import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
const bell = read("./customer-notifications-bell.tsx")
const css = read("../app/globals.css")

test("campana del navbar: negra sobre fondo blanco sólo en tema Light; tamaño sin cambios", () => {
  assert.match(bell, /<Bell className="beyonix-notifications-bell-icon size-4\.5" \/>/)
  assert.match(
    css,
    /html\[data-account-theme="light"\]\[data-account-scope\] \.beyonix-notifications-bell-icon \{\n  color: #000;\n\}/,
  )
  // El ícono sólo tiene regla de color bajo el tema Light: en Dark hereda el
  // text-white/80 del trigger como antes.
  const iconRules = css.split("\n").filter((line) => line.includes(".beyonix-notifications-bell-icon"))
  assert.equal(iconRules.length, 1)
  assert.ok(iconRules[0].startsWith('html[data-account-theme="light"]'))
  assert.match(
    css,
    /html\[data-account-theme="light"\]\[data-account-scope\] \.beyonix-notifications-trigger \{\n  background: #fff !important;\n\}/,
  )
  // Dark conserva su fondo propio del trigger.
  assert.match(bell, /beyonix-notifications-trigger relative flex size-11 [^"]*bg-\[#0D1117\]/)
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
