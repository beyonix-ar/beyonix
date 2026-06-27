import { createClient } from '@/lib/supabase/server'
import { isUserRole } from '@/lib/auth/roles'

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

  return isUserRole(profile?.rol) ? profile.rol : null
}
