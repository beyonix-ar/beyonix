import type {
  AndreaniConnectionTestResult,
  AndreaniIntegrationStatus,
} from "./types.ts"

type AuthorizationResult = { error: Response } | { authorized: true }
type Authorize = (request: Request) => Promise<AuthorizationResult>

export function createAndreaniAdminTestHandlers(dependencies: {
  authorize: Authorize
  getStatus: () => AndreaniIntegrationStatus
  testConnection: () => Promise<AndreaniConnectionTestResult>
}) {
  return {
    GET: async (request: Request) => {
      const authorization = await dependencies.authorize(request)
      if ("error" in authorization) return authorization.error

      return Response.json(dependencies.getStatus(), {
        headers: { "Cache-Control": "no-store" },
      })
    },
    POST: async (request: Request) => {
      const authorization = await dependencies.authorize(request)
      if ("error" in authorization) return authorization.error

      const result = await dependencies.testConnection()
      return Response.json(result, {
        status: result.status === "success" ? 200 : 502,
        headers: { "Cache-Control": "no-store" },
      })
    },
  }
}
