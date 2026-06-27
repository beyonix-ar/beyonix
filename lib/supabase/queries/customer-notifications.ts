import { supabase } from "@/lib/supabase/client"
import type { SupabaseCustomerNotification } from "@/lib/supabase/types"

export async function getCustomerNotifications(userId: string) {
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("id, user_id, type, title, body, action_url, order_id, is_read, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30)

  if (error) throw error

  return (data ?? []) as SupabaseCustomerNotification[]
}

export async function markCustomerNotificationRead(
  notificationId: string,
  userId: string,
) {
  const { error } = await supabase
    .from("customer_notifications")
    .update({ is_read: true })
    .eq("id", notificationId)
    .eq("user_id", userId)

  if (error) throw error
}

export async function markAllCustomerNotificationsRead(userId: string) {
  const { error } = await supabase
    .from("customer_notifications")
    .update({ is_read: true })
    .eq("user_id", userId)
    .eq("is_read", false)

  if (error) throw error
}
