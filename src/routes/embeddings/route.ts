import { Hono } from "hono"

import { APIError, forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    if (state.provider === "lingma") {
      throw new APIError(
        "Embeddings are not supported by the Lingma provider in V1",
        501,
        "unsupported_feature",
      )
    }

    const paylod = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(paylod)

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
