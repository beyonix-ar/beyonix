import { supabase } from "@/lib/supabase/client"
import {
  resolveSpecIconAliasRows,
  SPEC_ICON_ALIAS_KEY_PREFIX as KEY_PREFIX,
  SPEC_ICON_LEGACY_ALIAS_KEY_PREFIX as LEGACY_KEY_PREFIX,
  type SpecIconAliases,
} from "@/lib/products/spec-icons"

// Nombre visible (sólo Admin) de cada ícono de especificaciones, por iconName,
// en `site_settings`. Las claves v1 (por entrada sintética) se leen como
// respaldo y se borran al guardar o restablecer ese ícono.
export type { SpecIconAliases }

export async function loadSpecIconAliases(): Promise<SpecIconAliases> {
  const { data, error } = await supabase
    .from("site_settings")
    .select("key,value,updated_at")
    .or(`key.like.${KEY_PREFIX}%,key.like.${LEGACY_KEY_PREFIX}%`)

  if (error) throw error
  return resolveSpecIconAliasRows(data ?? [])
}

async function deleteLegacyAliases(iconName: string) {
  const { error } = await supabase.from("site_settings")
    .delete()
    .like("key", `${LEGACY_KEY_PREFIX}${iconName}:%`)
  if (error) throw error
}

export async function saveSpecIconAlias(iconName: string, label: string) {
  const { error } = await supabase.from("site_settings").upsert({
    key: `${KEY_PREFIX}${iconName}`,
    value: { label },
    description: "Nombre visible en Admin de un ícono de especificaciones (no se muestra en la tienda)",
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" })
  if (error) throw error
  await deleteLegacyAliases(iconName)
}

export async function resetSpecIconAlias(iconName: string) {
  const { error } = await supabase.from("site_settings")
    .delete()
    .eq("key", `${KEY_PREFIX}${iconName}`)
  if (error) throw error
  await deleteLegacyAliases(iconName)
}
