import { Hono } from "hono"

import { APIError, forwardError } from "~/lib/error"
import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  try {
    if (state.provider === "lingma") {
      throw new APIError(
        "Token inspection is not supported by the Lingma provider in V1",
        501,
        "unsupported_feature",
      )
    }

    return c.json({
      token: state.copilotToken,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})
