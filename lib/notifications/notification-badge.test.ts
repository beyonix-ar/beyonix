import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  countUnreadNotifications,
  formatNotificationBadgeCount,
  getNotificationsButtonLabel,
} from "./notification-badge.ts"

test("badge: 0 sin badge, número exacto hasta 9 y 9+ desde 10", () => {
  assert.equal(formatNotificationBadgeCount(0), null)
  assert.equal(formatNotificationBadgeCount(-1), null)
  assert.equal(formatNotificationBadgeCount(Number.NaN), null)
  assert.equal(formatNotificationBadgeCount(1), "1")
  assert.equal(formatNotificationBadgeCount(3), "3")
  assert.equal(formatNotificationBadgeCount(9), "9")
  assert.equal(formatNotificationBadgeCount(10), "9+")
  assert.equal(formatNotificationBadgeCount(250), "9+")
})

test("contador derivado de la misma lista: sólo las no leídas", () => {
  const list = [{ read: false }, { read: true }, { read: false }]
  assert.equal(countUnreadNotifications(list, (item) => item.read), 2)
  assert.equal(countUnreadNotifications([], () => false), 0)
})

test("etiqueta accesible con la cantidad sin leer", () => {
  assert.equal(getNotificationsButtonLabel("Abrir notificaciones", 0), "Abrir notificaciones")
  assert.equal(getNotificationsButtonLabel("Abrir notificaciones", 12), "Abrir notificaciones (12 sin leer)")
})

test("admin y storefront: la campana no recibe un contador aparte de la lista", () => {
  const callers = [
    "app/admin/admin-client.tsx",
    "components/site-header.tsx",
    "components/public-minimal-header.tsx",
    "components/checkout/checkout-header.tsx",
  ]
  for (const file of callers) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/<AdminNotificationsBell[\s\S]*?\/>/g)) {
      assert.doesNotMatch(match[0], /\bcount=/, file)
    }
  }
  const bell = readFileSync("components/admin-notification-bell.tsx", "utf8")
  assert.doesNotMatch(bell, /^\s*count: number/m)
  assert.match(bell, /countUnreadNotifications\(notifications,/)
})
