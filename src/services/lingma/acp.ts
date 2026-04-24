import { basename } from "node:path"
import { pathToFileURL } from "node:url"

import type { LingmaRpcClient } from "./json-rpc"

const initializedGenerations = new WeakMap<LingmaRpcClient, number>()

export async function ensureLingmaAcpInitialized(
  client: LingmaRpcClient,
  workspacePath = process.cwd(),
): Promise<void> {
  await client.connect()
  if (initializedGenerations.get(client) === client.generation) return

  const rootUri = pathToFileURL(workspacePath).href
  await client.request("initialize", {
    processId: process.pid,
    rootUri,
    rootPath: workspacePath,
    workspaceFolders: [
      {
        uri: rootUri,
        name: basename(workspacePath),
      },
    ],
    capabilities: {
      workspace: {
        workspaceFolders: true,
        configuration: true,
      },
    },
    clientInfo: {
      name: "copilot-api",
      version: "0.0.0",
    },
    allowStatistics: false,
    configuration: {},
  })

  initializedGenerations.set(client, client.generation)
}
