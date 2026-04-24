import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface LingmaConnectionOptions {
  cacheDir?: string
  wsUrl?: string
}

interface LingmaInfoFile {
  websocketPort?: number
}

export function getDefaultLingmaCacheDir(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Lingma",
    "SharedClientCache",
  )
}

export async function resolveLingmaWebSocketUrl(
  options: LingmaConnectionOptions,
): Promise<string> {
  if (options.wsUrl) return options.wsUrl

  const cacheDir = options.cacheDir ?? getDefaultLingmaCacheDir()
  const infoPath = join(cacheDir, ".info.json")
  const raw = await readFile(infoPath, "utf8")
  const info = JSON.parse(raw) as LingmaInfoFile

  if (!info.websocketPort) {
    throw new Error(`Lingma websocketPort not found in ${infoPath}`)
  }

  return `ws://127.0.0.1:${info.websocketPort}`
}
