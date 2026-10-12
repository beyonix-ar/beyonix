import { supabase } from "@/lib/supabase/client"

const KEY_PREFIX = "product_spec_icon_alias_v1:"

export type SpecIconAliases = Record<string, string>

export async function loadSpecIconAliases(): Promise<SpecIconAliases> {
  const { data, error } = await supabase
    .from("site_settings")
    .select("key,value")
    .like("key", `${KEY_PREFIX}%`)

  if (error) throw error

  return Object.fromEntries((data ?? []).flatMap(({ key, value }) => {
    const label = value && typeof value === "object" && !Array.isArray(value)
      ? value.label
      : null
    return typeof label === "string" && label.trim()
      ? [[key.slice(KEY_PREFIX.length), label.trim()]]
      : []
  }))
}

export async function saveSpecIconAlias(optionId: string, label: string) {
  const { error } = await supabase.from("site_settings").upsert({
    key: `${KEY_PREFIX}${optionId}`,
    value: { label },
    description: "Nombre visible de un ícono de especificaciones",
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" })
  if (error) throw error
}

export async function resetSpecIconAlias(optionId: string) {
  const { error } = await supabase.from("site_settings")
    .delete()
    .eq("key", `${KEY_PREFIX}${optionId}`)
  if (error) throw error
}
