import { Hono } from "hono"

import { APIError, forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    if (state.provider === "lingma") {
      throw new APIError(
        "Usage is not supported by the Lingma provider in V1",
        501,
        "unsupported_feature",
      )
    }

    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    return await forwardError(c, error)
  }
})
