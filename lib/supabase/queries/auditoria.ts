import { supabase } from "@/lib/supabase/client"
import type { SupabaseAuditLog } from "@/lib/supabase/types"

export async function getAuditLogs() {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(150)

  if (error) throw new Error(error.message)

  return (data ?? []) as SupabaseAuditLog[]
}

export async function undoAuditLog(id: number) {
  const { error } = await supabase.rpc("undo_audit_log", {
    p_log_id: id,
  })

  if (error) throw new Error(error.message)

  return true
}
