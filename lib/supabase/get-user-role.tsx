import { createClient } from '@/lib/supabase/server'

export async function getUserRole() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return null
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('rol')
    .eq('id', user.id)
    .single()

  return profile?.rol ?? null
}