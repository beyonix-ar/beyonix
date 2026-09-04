/**
 * Mensaje público único de "olvidé mi contraseña", compartido entre el
 * servidor (`lib/auth/forgot-password.ts`) y el cliente (`app/login/page.tsx`)
 * para que nunca puedan desalinearse. Sin "server-only": el cliente lo
 * necesita para mostrar el mismo texto sin depender de lo que devuelva la
 * respuesta (que, por diseño, siempre es este mismo texto).
 *
 * Nunca revela si la cuenta existe -- ver lib/auth/forgot-password.ts para
 * el razonamiento completo de por qué la respuesta tiene que ser idéntica
 * para una cuenta existente e inexistente.
 */
export const FORGOT_PASSWORD_GENERIC_MESSAGE =
  "Si existe una cuenta asociada a los datos ingresados, te enviaremos un correo con las instrucciones para recuperar tu contraseña."
