import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
const bell = read("./customer-notifications-bell.tsx")
const css = read("../app/globals.css")

test("campana del navbar: negra sólo en tema Light; tamaño, fondo y badge sin cambios", () => {
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
  // Badge rojo intacto.
  assert.match(bell, /bg-red-600 px-1 text-9px font-bold leading-none text-white/)
})
