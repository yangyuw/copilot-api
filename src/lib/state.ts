import type { ModelsResponse } from "~/services/copilot/get-models"
import type { LingmaRpcClient } from "~/services/lingma/json-rpc"

export type Provider = "copilot" | "lingma"

export interface State {
  provider: Provider
  githubToken?: string
  copilotToken?: string
  lingmaClient?: LingmaRpcClient

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  provider: "copilot",
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
