import assert from "node:assert/strict"
import test from "node:test"

import { createBrowserClient } from "@supabase/ssr"

import {
  getSupabaseCookieOptions,
  serializeSupabaseCookieRemoval,
} from "./cookie-options.ts"

function createCookieDocument() {
  const cookies = new Map<string, string>()
  const writes: string[] = []
  const document = {
    get cookie() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    },
    set cookie(value: string) {
      writes.push(value)
      const [pair] = value.split(";")
      const separator = pair.indexOf("=")
      const name = pair.slice(0, separator)
      const cookieValue = pair.slice(separator + 1)
      if (/Max-Age=0(?:;|$)/i.test(value)) cookies.delete(name)
      else cookies.set(name, cookieValue)
    },
  }
  return { document, cookies, writes }
}

for (const [nodeEnv, secure] of [
  ["production", true],
  ["development", false],
] as const) {
  test(`Supabase SSR: login, refresh y logout en ${nodeEnv}`, async () => {
    const { document, cookies, writes } = createCookieDocument()
    const originalWindow = Reflect.get(globalThis, "window")
    const originalDocument = Reflect.get(globalThis, "document")
    let closeBroadcast: (() => void) | undefined
    Reflect.set(globalThis, "window", { document })
    Reflect.set(globalThis, "document", document)

    try {
      const cookieOptions = getSupabaseCookieOptions(nodeEnv)
      const client = createBrowserClient(
        `https://cookie-options-test-${nodeEnv}.supabase.co`,
        "test-anon-key",
        {
          isSingleton: false,
          auth: { autoRefreshToken: false, detectSessionInUrl: false },
          cookieOptions,
        },
      )
      const broadcast = Reflect.get(client.auth, "broadcastChannel") as BroadcastChannel | null
      closeBroadcast = () => broadcast?.close()
      const storage = Reflect.get(client.auth, "storage") as {
        setItem(key: string, value: string): Promise<void>
        getItem(key: string): Promise<string | null>
        removeItem(key: string): Promise<void>
      }
      const key = `sb-cookie-options-test-${nodeEnv}-auth-token`

      await storage.setItem(key, JSON.stringify({ access_token: "login" }))
      assert.equal(await storage.getItem(key), JSON.stringify({ access_token: "login" }))
      assert.ok(cookies.size > 0, "el login conserva la sesión en cookies")

      await storage.setItem(key, JSON.stringify({ access_token: "refresh" }))
      assert.equal(await storage.getItem(key), JSON.stringify({ access_token: "refresh" }))

      await storage.removeItem(key)
      assert.equal(await storage.getItem(key), null)
      assert.equal(cookies.size, 0)

      for (const write of writes) {
        assert.match(write, /(?:^|;) Path=\//i)
        assert.match(write, /(?:^|;) SameSite=Lax/i)
        assert.equal(/(?:^|;) Secure(?:;|$)/i.test(write), secure)
        assert.doesNotMatch(write, /HttpOnly/i)
      }
      assert.ok(writes.some((write) => /Max-Age=0/i.test(write)))
      assert.equal(cookieOptions.httpOnly, false)
    } finally {
      closeBroadcast?.()
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window")
      else Reflect.set(globalThis, "window", originalWindow)
      if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document")
      else Reflect.set(globalThis, "document", originalDocument)
    }
  })

  test(`limpieza manual de Supabase en ${nodeEnv}`, () => {
    const removal = serializeSupabaseCookieRemoval("sb-test-auth-token.0", nodeEnv)
    assert.match(removal, /^sb-test-auth-token\.0=; Max-Age=0; Path=\/; SameSite=lax/)
    assert.equal(removal.endsWith("; Secure"), secure)
    assert.doesNotMatch(removal, /HttpOnly/i)
  })
}
