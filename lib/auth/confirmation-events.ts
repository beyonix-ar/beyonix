export const EMAIL_CONFIRMATION_STORAGE_KEY =
  "beyonix-email-confirmation-event"
export const EMAIL_CONFIRMATION_CHANNEL =
  "beyonix-email-confirmation"

export interface EmailConfirmationEvent {
  userId: string
  email: string
  confirmedAt: number
}
