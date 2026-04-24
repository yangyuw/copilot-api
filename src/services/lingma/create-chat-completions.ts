import consola from "consola"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "~/services/copilot/create-chat-completions"

import { APIError } from "~/lib/error"
import { state } from "~/lib/state"

import { ensureLingmaAcpInitialized } from "./acp"

interface LingmaSessionNewResponse {
  sessionId?: string
}

interface LingmaSessionPromptResponse {
  requestId?: string
  success?: boolean
  errorCode?: string
  errorMessage?: string
  data?: unknown
  result?: unknown
  stopReason?: string
}

interface LingmaAcpPromptPayload {
  sessionId: string
  _meta: Record<string, string>
  prompt: Array<{
    type: "text"
    text: string
  }>
}

interface LingmaAnswerCollector {
  chunks: Array<string>
  finish: () => void
  finishWithError: (error: Error) => void
}

const COMPLETION_TIMEOUT_MS = 120_000
const ACP_REQUEST_ID_KEY = "ai-coding/request-id"
const ACP_MODEL_KEY = "ai-coding/model"
const ACP_MODE_KEY = "ai-coding/mode"

let lingmaChatQueue: Promise<void> = Promise.resolve()

export async function createLingmaChatCompletions(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse> {
  const run = lingmaChatQueue.then(
    () => createLingmaChatCompletionsUnsafe(payload),
    () => createLingmaChatCompletionsUnsafe(payload),
  )
  lingmaChatQueue = run.then(
    () => undefined,
    () => undefined,
  )

  return await run
}

export function validateLingmaChatPayload(
  payload: ChatCompletionsPayload,
): void {
  if (payload.stream) {
    throw new APIError(
      "Lingma provider does not support stream: true in V1",
      501,
      "unsupported_feature",
    )
  }

  if (payload.n && payload.n > 1) {
    throw new APIError("Lingma provider only supports n: 1", 400)
  }

  if (payload.response_format) {
    throw new APIError(
      "Lingma provider does not support response_format in V1",
      501,
      "unsupported_feature",
    )
  }

  if (payload.tools?.length) {
    throw new APIError(
      "Lingma provider does not support tools in V1",
      501,
      "unsupported_feature",
    )
  }

  if (payload.tool_choice && payload.tool_choice !== "none") {
    throw new APIError(
      "Lingma provider does not support tool_choice in V1",
      501,
      "unsupported_feature",
    )
  }

  for (const message of payload.messages) {
    if (message.tool_calls?.length) {
      throw new APIError(
        "Lingma provider does not support tool calls in V1",
        501,
        "unsupported_feature",
      )
    }

    if (Array.isArray(message.content)) {
      const hasImage = message.content.some((part) => part.type === "image_url")
      if (hasImage) {
        throw new APIError(
          "Lingma provider does not support image inputs in V1",
          501,
          "unsupported_feature",
        )
      }
    }
  }
}

export function renderLingmaPrompt(payload: ChatCompletionsPayload): string {
  const prompt = payload.messages
    .map((message) => renderMessage(message))
    .filter((message) => message.length > 0)
    .join("\n\n")

  if (!prompt) throw new APIError("Lingma prompt cannot be empty", 400)

  return prompt
}

async function createLingmaChatCompletionsUnsafe(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse> {
  validateLingmaChatPayload(payload)

  const client = state.lingmaClient
  if (!client) {
    throw new APIError("Lingma RPC client is not initialized", 500)
  }

  const requestId = crypto.randomUUID()
  const content = renderLingmaPrompt(payload)
  const answer = await runLingmaAcpCompletion(requestId, payload.model, content)

  const created = Math.floor(Date.now() / 1000)
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created,
    model: payload.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: answer,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
  }
}

async function runLingmaAcpCompletion(
  requestId: string,
  model: string,
  content: string,
): Promise<string> {
  const client = state.lingmaClient
  if (!client) throw new APIError("Lingma RPC client is not initialized", 500)

  await ensureLingmaAcpInitialized(client)

  const session = await client.request<LingmaSessionNewResponse>(
    "session/new",
    {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {},
    },
  )
  if (!session.sessionId) {
    throw new APIError("Lingma session/new did not return a sessionId", 502)
  }

  const promptPayload: LingmaAcpPromptPayload = {
    sessionId: session.sessionId,
    _meta: {
      [ACP_REQUEST_ID_KEY]: requestId,
      [ACP_MODEL_KEY]: model,
      [ACP_MODE_KEY]: "",
    },
    prompt: [{ type: "text", text: content }],
  }

  return await collectLingmaAnswer(
    requestId,
    session.sessionId,
    async (expectedIds) => {
      const response = await client.request<LingmaSessionPromptResponse>(
        "session/prompt",
        promptPayload,
        COMPLETION_TIMEOUT_MS,
      )

      if (response.requestId) expectedIds.add(response.requestId)
      if (response.success === false) {
        throw new APIError(
          response.errorMessage
            || response.errorCode
            || "Lingma chat request failed",
          502,
        )
      }

      return extractDirectAnswer(response)
    },
  )
}

async function collectLingmaAnswer(
  requestId: string,
  sessionId: string,
  sendRequest: (expectedIds: Set<string>) => Promise<string | undefined>,
): Promise<string> {
  const client = state.lingmaClient
  if (!client) throw new APIError("Lingma RPC client is not initialized", 500)

  const expectedIds = new Set([requestId])
  const chunks: Array<string> = []
  let settled = false

  return await new Promise<string>((resolve, reject) => {
    const cleanupCallbacks: Array<() => void> = []

    const cleanup = () => {
      for (const cleanupCallback of cleanupCallbacks) cleanupCallback()
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new APIError("Lingma chat completion timed out", 504, "timeout"))
    }, COMPLETION_TIMEOUT_MS)

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      resolve(chunks.join(""))
    }

    const finishWithError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      reject(error)
    }

    cleanupCallbacks.push(
      client.onNotification("session/update", (params) => {
        if (!matchesExpectedRequest(params, expectedIds, sessionId)) return
        handleSessionUpdate(params, {
          chunks,
          finish,
          finishWithError,
        })
      }),
      client.onNotification("chat/answer", (params) => {
        if (!matchesExpectedRequest(params, expectedIds)) return
        const text = extractText(params)
        if (text) appendLingmaAnswerText(chunks, text)
      }),
      client.onNotification("chat/finish", (params) => {
        if (!matchesExpectedRequest(params, expectedIds)) return
        const text = extractText(params)
        if (text) appendLingmaAnswerText(chunks, text)
        finish()
      }),
      client.onNotification("chat/error", (params) => {
        if (!matchesExpectedRequest(params, expectedIds)) return
        finishWithError(
          new APIError(
            extractErrorMessage(params) ?? "Lingma chat failed",
            502,
          ),
        )
      }),
      client.onNotification("chat/think", (params) => {
        if (matchesExpectedRequest(params, expectedIds)) {
          consola.debug("Lingma thinking event:", params)
        }
      }),
    )

    sendRequest(expectedIds)
      .then((directAnswer) => {
        if (!directAnswer) return
        appendLingmaAnswerText(chunks, directAnswer)
        finish()
      })
      .catch((error: unknown) => {
        finishWithError(
          error instanceof Error ? error : new Error(String(error)),
        )
      })
  })
}

function handleSessionUpdate(
  params: unknown,
  collector: LingmaAnswerCollector,
): void {
  const update = getRecordValue(params, "update")
  const sessionUpdate = extractKnownString(update, ["sessionUpdate"])

  if (sessionUpdate === "agent_message_chunk") {
    const text = extractText(getRecordValue(update, "content"))
    if (text) appendLingmaAnswerText(collector.chunks, text)
    return
  }

  if (sessionUpdate === "agent_thought_chunk") {
    consola.debug("Lingma thinking event:", params)
    return
  }

  if (sessionUpdate !== "notification") return

  const type = extractKnownString(update, ["type"])
  if (type === "chat_finish") {
    const data = getRecordValue(update, "data")
    const fullAnswer = extractKnownString(data, ["fullAnswer"])
    if (fullAnswer) appendLingmaAnswerText(collector.chunks, fullAnswer)

    const statusCode = extractStatusCode(data)
    const reason = extractKnownString(data, ["reason"])
    if ((statusCode && statusCode >= 400) || isFailureReason(reason)) {
      collector.finishWithError(
        new APIError(
          extractErrorMessage(data) ?? reason ?? "Lingma chat failed",
          502,
        ),
      )
      return
    }

    collector.finish()
    return
  }

  if (type === "chat_error" || type === "error") {
    collector.finishWithError(
      new APIError(extractErrorMessage(update) ?? "Lingma chat failed", 502),
    )
  }
}

function renderMessage(message: Message): string {
  const content = renderContent(message.content)
  if (!content) return ""

  const name = message.name ? ` ${message.name}` : ""
  const toolCallId =
    message.tool_call_id ? ` tool_call_id=${message.tool_call_id}` : ""
  return `${message.role.toUpperCase()}${name}${toolCallId}:\n${content}`
}

function renderContent(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!content) return ""

  return content
    .map((part) => renderContentPart(part))
    .filter(Boolean)
    .join("\n")
}

function renderContentPart(part: ContentPart): string {
  if (part.type === "text") return part.text
  throw new APIError(
    "Lingma provider does not support image inputs in V1",
    501,
    "unsupported_feature",
  )
}

function extractDirectAnswer(
  response: LingmaSessionPromptResponse,
): string | undefined {
  return extractText(response.data) ?? extractText(response.result)
}

function appendLingmaAnswerText(chunks: Array<string>, text: string): void {
  if (!text) return
  const current = chunks.join("")
  if (current && text.startsWith(current)) {
    chunks.splice(0, chunks.length, text)
    return
  }
  chunks.push(text)
}

function matchesExpectedRequest(
  params: unknown,
  expectedIds: Set<string>,
  expectedSessionId?: string,
): boolean {
  const eventRequestId = extractRequestId(params)
  if (eventRequestId && !expectedIds.has(eventRequestId)) return false

  const eventSessionId = extractSessionId(params)
  if (
    expectedSessionId
    && eventSessionId
    && eventSessionId !== expectedSessionId
  ) {
    return false
  }

  if (expectedSessionId) return Boolean(eventRequestId || eventSessionId)
  return !eventRequestId || expectedIds.has(eventRequestId)
}

function extractRequestId(value: unknown): string | undefined {
  return extractKnownString(value, [
    ACP_REQUEST_ID_KEY,
    "requestId",
    "request_id",
    "id",
  ])
}

function extractSessionId(value: unknown): string | undefined {
  return extractKnownString(value, ["sessionId", "session_id"])
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value

  return extractKnownString(value, ["content", "text", "answer", "delta"])
}

function extractErrorMessage(value: unknown): string | undefined {
  return extractKnownString(value, [
    "errorMessage",
    "message",
    "error",
    "errorCode",
  ])
}

function extractStatusCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined

  const statusCode = value.statusCode
  if (typeof statusCode === "number") return statusCode

  return undefined
}

function isFailureReason(reason: string | undefined): boolean {
  return Boolean(reason && !["end_turn", "stop", "success"].includes(reason))
}

function extractKnownString(
  value: unknown,
  keys: Array<string>,
  depth = 0,
): string | undefined {
  if (depth > 3 || !isRecord(value)) return undefined

  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate
    }
  }

  for (const key of [
    "_meta",
    "data",
    "result",
    "payload",
    "message",
    "content",
    "update",
  ]) {
    const nested = value[key]
    const candidate = extractKnownString(nested, keys, depth + 1)
    if (candidate) return candidate
  }

  return undefined
}

function getRecordValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  return value[key]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
