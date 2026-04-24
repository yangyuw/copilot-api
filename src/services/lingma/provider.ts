import consola from "consola"

import { APIError } from "~/lib/error"
import { state } from "~/lib/state"

import { ensureLingmaAcpInitialized } from "./acp"
import { resolveLingmaWebSocketUrl } from "./config"
import { LingmaRpcClient } from "./json-rpc"
import { createLingmaModels, parseLingmaModelIds } from "./models"

interface SetupLingmaProviderOptions {
  cacheDir?: string
  wsUrl?: string
  models?: string
}

interface LingmaAuthStatus {
  status?: number
  name?: string
  email?: string
}

export async function setupLingmaProvider(
  options: SetupLingmaProviderOptions,
): Promise<void> {
  const wsUrl = await resolveLingmaWebSocketUrl({
    cacheDir: options.cacheDir,
    wsUrl: options.wsUrl,
  })
  const client = new LingmaRpcClient(wsUrl)
  await client.connect()

  const authStatus = await client.request<LingmaAuthStatus>("auth/status", {})
  if (authStatus.status !== 2) {
    client.close()
    throw new APIError(
      "Lingma IDE is not logged in. Open Lingma IDE, complete login, then start this server again.",
      401,
      "authentication_error",
    )
  }

  state.lingmaClient = client
  state.models = createLingmaModels(parseLingmaModelIds(options.models))
  await ensureLingmaAcpInitialized(client)

  const label = authStatus.name || authStatus.email || "current Lingma user"
  consola.info(`Using Lingma local IDE session for ${label}`)
}
