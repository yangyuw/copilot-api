import type { ModelsResponse } from "~/services/copilot/get-models"

export const DEFAULT_LINGMA_MODEL_IDS = [
  "org_auto",
  "dashscope_qmodel",
  "dashscope_qwen3_coder",
  "dashscope_qwen_plus_20250428_thinking",
  "dashscope_qwen_max_latest",
  "kmodel",
  "mmodel",
]

export function createLingmaModels(modelIds: Array<string>): ModelsResponse {
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      name: id,
      object: "model",
      vendor: "lingma",
      version: "",
      preview: false,
      model_picker_enabled: true,
      capabilities: {
        family: "lingma",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    })),
  }
}

export function parseLingmaModelIds(raw?: string): Array<string> {
  const modelIds =
    raw
      ?.split(",")
      .map((model) => model.trim())
      .filter((model) => model.length > 0) ?? DEFAULT_LINGMA_MODEL_IDS

  return [...new Set(modelIds)]
}
