import consola from "consola"
import { Buffer } from "node:buffer"

import { APIError } from "~/lib/error"

export type JsonRpcId = number | string

export interface JsonRpcRequestMessage {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotificationMessage {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface JsonRpcResponseMessage {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

type JsonRpcOutgoingMessage = JsonRpcNotificationMessage | JsonRpcRequestMessage
type JsonRpcIncomingMessage =
  | JsonRpcNotificationMessage
  | JsonRpcResponseMessage
type NotificationHandler = (
  params: unknown,
  message: JsonRpcNotificationMessage,
) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const HEADER_DELIMITER = Buffer.from("\r\n\r\n")
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function encodeJsonRpcFrame(message: JsonRpcOutgoingMessage): string {
  const payload = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`
}

export class JsonRpcFrameParser {
  private buffer = Buffer.alloc(0)

  push(chunk: unknown): Array<JsonRpcIncomingMessage> {
    this.buffer = Buffer.concat([this.buffer, toBuffer(chunk)])

    const messages: Array<JsonRpcIncomingMessage> = []
    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_DELIMITER)
      if (headerEnd === -1) break

      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
      if (!match?.[1]) throw new Error("Invalid Lingma JSON-RPC frame header")

      const contentLength = Number.parseInt(match[1], 10)
      const bodyStart = headerEnd + HEADER_DELIMITER.length
      const frameEnd = bodyStart + contentLength
      if (this.buffer.length < frameEnd) break

      const body = this.buffer.subarray(bodyStart, frameEnd).toString("utf8")
      this.buffer = this.buffer.subarray(frameEnd)
      messages.push(parseJsonRpcMessage(body))
    }

    return messages
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}

export class LingmaRpcClient {
  private socket?: WebSocket
  private connectPromise?: Promise<void>
  private readonly parser = new JsonRpcFrameParser()
  private readonly requestTimeoutMs: number
  private readonly url: string
  private connectionGeneration = 0
  private requestId = 0
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly notificationHandlers = new Map<
    string,
    Set<NotificationHandler>
  >()

  constructor(url: string, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.url = url
    this.requestTimeoutMs = requestTimeoutMs
  }

  get generation(): number {
    return this.connectionGeneration
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === 1) return
    if (this.connectPromise) {
      await this.connectPromise
      return
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.socket = socket

      socket.addEventListener("open", () => {
        this.connectionGeneration += 1
        this.connectPromise = undefined
        resolve()
      })

      socket.addEventListener("error", () => {
        const error = new APIError(
          `Failed to connect to Lingma RPC at ${this.url}`,
          502,
        )
        this.connectPromise = undefined
        reject(error)
      })

      socket.addEventListener("close", () => {
        const error = new APIError("Lingma RPC connection closed", 502)
        this.socket = undefined
        this.connectPromise = undefined
        this.parser.reset()
        this.rejectPending(error)
      })

      socket.addEventListener("message", (event) => {
        this.handleSocketMessage(event.data as unknown)
      })
    })

    await this.connectPromise
  }

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    await this.connect()

    const id = this.requestId++
    const message: JsonRpcRequestMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new APIError(`Lingma RPC request timed out: ${method}`, 504))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => {
          resolve(value as T)
        },
        reject,
        timer,
      })

      try {
        this.send(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set()
    handlers.add(handler)
    this.notificationHandlers.set(method, handlers)

    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.notificationHandlers.delete(method)
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.connect()
    this.send({
      jsonrpc: "2.0",
      method,
      params,
    })
  }

  close(): void {
    this.rejectPending(new APIError("Lingma RPC connection closed", 502))
    this.socket?.close()
    this.socket = undefined
    this.connectPromise = undefined
    this.parser.reset()
  }

  private send(message: JsonRpcOutgoingMessage): void {
    if (this.socket?.readyState !== 1) {
      throw new APIError("Lingma RPC is not connected", 502)
    }

    this.socket.send(encodeJsonRpcFrame(message))
  }

  private handleSocketMessage(data: unknown): void {
    let messages: Array<JsonRpcIncomingMessage>
    try {
      messages = this.parser.push(data)
    } catch (error) {
      const reason =
        error instanceof Error ? error : (
          new Error("Failed to parse Lingma JSON-RPC frame")
        )
      this.rejectPending(reason)
      this.socket?.close()
      return
    }

    for (const message of messages) {
      if ("id" in message && !("method" in message)) {
        this.handleResponse(message)
      } else {
        this.handleNotification(message as JsonRpcNotificationMessage)
      }
    }
  }

  private handleResponse(message: JsonRpcResponseMessage): void {
    const pending = this.pending.get(message.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    if (message.error) {
      pending.reject(
        new APIError(message.error.message ?? "Lingma RPC request failed", 502),
      )
      return
    }

    pending.resolve(message.result)
  }

  private handleNotification(message: JsonRpcNotificationMessage): void {
    const handlers = this.notificationHandlers.get(message.method)
    if (!handlers) return

    for (const handler of handlers) {
      try {
        handler(message.params, message)
      } catch (error) {
        consola.warn("Lingma notification handler failed:", error)
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8")
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }

  throw new Error("Unsupported Lingma JSON-RPC frame chunk")
}

function parseJsonRpcMessage(body: string): JsonRpcIncomingMessage {
  const parsed = JSON.parse(body) as unknown
  if (!isRecord(parsed)) throw new Error("Invalid Lingma JSON-RPC message")
  if (parsed.jsonrpc !== "2.0") {
    throw new Error("Invalid Lingma JSON-RPC version")
  }

  if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
    return parsed as unknown as JsonRpcResponseMessage
  }

  if (typeof parsed.method === "string") {
    return parsed as unknown as JsonRpcNotificationMessage
  }

  throw new Error("Unsupported Lingma JSON-RPC message")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
