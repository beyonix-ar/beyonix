/**
 * Traducción de errores de `auth.updateUser`/`admin.updateUserById` a copy en
 * español. Vive acá (no duplicada entre cliente y servidor) porque el
 * servidor ahora es quien realmente aplica el cambio de contraseña
 * (`app/api/auth/reset-password/confirm`); el cliente sólo muestra el
 * mensaje que el servidor devuelve.
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
