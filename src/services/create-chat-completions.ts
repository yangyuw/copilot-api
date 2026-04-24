import { state } from "~/lib/state"

import type { ChatCompletionsPayload } from "./copilot/create-chat-completions"

import { createChatCompletions as createCopilotChatCompletions } from "./copilot/create-chat-completions"
import { createLingmaChatCompletions } from "./lingma/create-chat-completions"

export type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  ImagePart,
  Message,
  TextPart,
  Tool,
  ToolCall,
} from "./copilot/create-chat-completions"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (state.provider === "lingma") {
    return await createLingmaChatCompletions(payload)
  }

  return await createCopilotChatCompletions(payload)
}
