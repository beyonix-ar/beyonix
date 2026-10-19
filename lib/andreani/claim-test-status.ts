/** La simulación sólo opera sobre envíos QA y nunca se activa por defecto en producción. */
export function claimShipmentTestStatusEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.ANDREANI_SHIPMENT_ENV?.toUpperCase() === "QA" &&
    (env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.CLAIM_SHIPMENT_TEST_OVERRIDE_ENABLED === "true")
}
