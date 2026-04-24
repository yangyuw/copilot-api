import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { state } from "../src/lib/state"
import { server } from "../src/server"
import { resolveLingmaWebSocketUrl } from "../src/services/lingma/config"
import {
  createLingmaChatCompletions,
  renderLingmaPrompt,
  validateLingmaChatPayload,
} from "../src/services/lingma/create-chat-completions"
import {
  encodeJsonRpcFrame,
  JsonRpcFrameParser,
  LingmaRpcClient,
} from "../src/services/lingma/json-rpc"
import { createLingmaModels } from "../src/services/lingma/models"

afterEach(() => {
  state.provider = "copilot"
  state.lingmaClient = undefined
  state.models = undefined
})

describe("Lingma JSON-RPC framing", () => {
  test("parses split and coalesced frames", () => {
    const parser = new JsonRpcFrameParser()
    const first = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "auth/status",
      params: {},
    })
    const second = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      method: "chat/answer",
      params: { content: "ok" },
    })

    expect(parser.push(first.slice(0, 10))).toEqual([])
    expect(parser.push(first.slice(10) + second)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "auth/status",
        params: {},
      },
      {
        jsonrpc: "2.0",
        method: "chat/answer",
        params: { content: "ok" },
      },
    ])
  })

  test("throws on invalid JSON frames", () => {
    const parser = new JsonRpcFrameParser()
    expect(() => parser.push("Content-Length: 1\r\n\r\n{")).toThrow()
  })

  test("times out unanswered requests", async () => {
    const originalWebSocket = globalThis.WebSocket
    const globalWithWebSocket = globalThis as unknown as {
      WebSocket: typeof WebSocket
    }
    globalWithWebSocket.WebSocket =
      TimeoutWebSocket as unknown as typeof WebSocket

    try {
      const client = new LingmaRpcClient("ws://127.0.0.1:1", 5)
      let error: unknown
      try {
        await client.request("auth/status", {})
      } catch (caughtError) {
        error = caughtError
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("timed out")
      client.close()
    } finally {
      globalWithWebSocket.WebSocket = originalWebSocket
    }
  })
})

describe("Lingma config and models", () => {
  test("resolves websocket URL from .info.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingma-cache-"))
    try {
      await writeFile(
        join(dir, ".info.json"),
        JSON.stringify({ websocketPort: 36510 }),
      )

      const discoveredUrl = await resolveLingmaWebSocketUrl({ cacheDir: dir })
      const overrideUrl = await resolveLingmaWebSocketUrl({
        wsUrl: "ws://127.0.0.1:45678",
      })

      expect(discoveredUrl).toBe("ws://127.0.0.1:36510")
      expect(overrideUrl).toBe("ws://127.0.0.1:45678")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("creates Copilot-shaped static model responses", () => {
    const models = createLingmaModels(["lingma"])
    expect(models.data[0].id).toBe("lingma")
    expect(models.data[0].vendor).toBe("lingma")
    expect(models.data[0].capabilities.tokenizer).toBe("o200k_base")
  })
})

describe("Lingma chat completions", () => {
  test("renders text-only OpenAI messages with roles", () => {
    const prompt = renderLingmaPrompt({
      model: "lingma",
      messages: [
        { role: "system", content: "Be terse." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
      ],
    })

    expect(prompt).toBe("SYSTEM:\nBe terse.\n\nUSER:\nHello\nWorld")
  })

  test("rejects unsupported V1 payload features", () => {
    expect(() =>
      validateLingmaChatPayload({
        model: "lingma",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).toThrow("stream")

    expect(() =>
      validateLingmaChatPayload({
        model: "lingma",
        tools: [
          {
            type: "function",
            function: { name: "search", parameters: {} },
          },
        ],
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).toThrow("tools")
  })

  test("assembles a non-streaming OpenAI response from Lingma events", async () => {
    state.provider = "lingma"
    state.lingmaClient = createFakeLingmaClient("Hello from Lingma")

    const response = await createLingmaChatCompletions({
      model: "lingma",
      messages: [{ role: "user", content: "Hello" }],
    })

    expect(response.object).toBe("chat.completion")
    expect(response.choices[0].message.content).toBe("Hello from Lingma")
    expect(response.usage).toBeUndefined()
  })
})

describe("Lingma routes", () => {
  test("returns static models in Lingma mode", async () => {
    state.provider = "lingma"
    state.models = createLingmaModels(["lingma"])

    const response = await server.request("/v1/models")
    const body = (await response.json()) as { data: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.data[0].id).toBe("lingma")
  })

  test("rejects Lingma streaming chat requests", async () => {
    state.provider = "lingma"
    state.models = createLingmaModels(["lingma"])

    const response = await server.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "lingma",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(response.status).toBe(501)
  })

  test("rejects unsupported Lingma endpoints", async () => {
    state.provider = "lingma"

    const response = await server.request("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "lingma",
        max_tokens: 1,
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(response.status).toBe(501)
  })
})

class TimeoutWebSocket {
  readyState = 0
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open")
    })
  }

  addEventListener(type: string, handler: () => void): void {
    const handlers = this.listeners.get(type) ?? new Set()
    handlers.add(handler)
    this.listeners.set(type, handlers)
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3
    this.emit("close")
  }

  private emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler()
  }
}

function createFakeLingmaClient(answer: string): LingmaRpcClient {
  const handlers = new Map<string, Set<(params: unknown) => void>>()
  const sessionId = "session-id"
  const generation = 1

  return {
    generation,
    connect: () => Promise.resolve(),
    request: (method: string, params: unknown) => {
      if (method === "initialize") {
        return Promise.resolve({})
      }

      if (method === "session/new") {
        return Promise.resolve({ sessionId })
      }

      const request = params as {
        sessionId: string
        _meta: Record<string, string>
      }
      return new Promise((resolve) => {
        queueMicrotask(() => {
          emit(handlers, "session/update", {
            sessionId: request.sessionId,
            _meta: {
              "ai-coding/request-id": request._meta["ai-coding/request-id"],
            },
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: answer },
            },
          })
          emit(handlers, "session/update", {
            sessionId: request.sessionId,
            _meta: {
              "ai-coding/request-id": request._meta["ai-coding/request-id"],
            },
            update: {
              sessionUpdate: "notification",
              type: "chat_finish",
              data: { reason: "success", statusCode: 200 },
            },
          })
          resolve({ stopReason: "end_turn" })
        })
      })
    },
    onNotification: (method: string, handler: (params: unknown) => void) => {
      const methodHandlers = handlers.get(method) ?? new Set()
      methodHandlers.add(handler)
      handlers.set(method, methodHandlers)

      return () => {
        methodHandlers.delete(handler)
      }
    },
  } as unknown as LingmaRpcClient
}

function emit(
  handlers: Map<string, Set<(params: unknown) => void>>,
  method: string,
  params: unknown,
): void {
  for (const handler of handlers.get(method) ?? []) handler(params)
}
