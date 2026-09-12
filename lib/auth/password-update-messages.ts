/**
 * Traducción de errores de `auth.updateUser` a copy en español. Usada por
 * `app/reset-password/page.tsx` (cambio de contraseña por recuperación,
 * directo contra `supabase.auth.updateUser()` con la sesión que dejó
 * `verifyOtp()`) y por el resto de los lugares que actualizan contraseña
 * desde el cliente.
 */
export function getPasswordUpdateErrorMessage(message: string) {
  const normalizedMessage = message.toLowerCase()

  if (
    normalizedMessage.includes("different from the old password") ||
    normalizedMessage.includes("same password") ||
    normalizedMessage.includes("new password should be different")
  ) {
    return "La nueva contraseña no puede coincidir con la contraseña anterior."
  }

  return "No se pudo actualizar la contraseña. Intentá nuevamente."
}

export function getInvalidRecoveryLinkMessage() {
  return "Este enlace de recuperación ya no es válido o expiró."
}
