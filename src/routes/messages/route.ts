import { Hono } from "hono"

import { APIError, forwardError } from "~/lib/error"
import { state } from "~/lib/state"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  try {
    if (state.provider === "lingma") {
      throw new APIError(
        "Anthropic messages are not supported by the Lingma provider in V1",
        501,
        "unsupported_feature",
      )
    }

    return await handleCompletion(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    if (state.provider === "lingma") {
      throw new APIError(
        "Token counting is not supported by the Lingma provider in V1",
        501,
        "unsupported_feature",
      )
    }

    return await handleCountTokens(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
