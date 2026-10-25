import * as acp from "@agentclientprotocol/sdk";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { AcpSelection, SupportsFast } from "./acp-state.ts";
import { formatModel, resolveModel } from "./models.ts";

export async function sessionConfigOptions(
  models: Models,
  selection: AcpSelection,
  supportsFast: SupportsFast,
  booleanSupported: boolean,
): Promise<acp.SessionConfigOption[]> {
  const available = [...await models.getAvailable()];
  const currentModel = formatModel(selection.model);
  if (!available.some((model) => formatModel(model) === currentModel)) available.push(selection.model);
  const options: acp.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: available.map((model) => ({ value: formatModel(model), name: model.name })),
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: selection.thinking,
      options: getSupportedThinkingLevels(selection.model).map((level) => ({ value: level, name: level })),
    },
  ];
  if (booleanSupported && supportsFast(selection.model)) {
    options.push({ id: "fast", name: "Fast", description: "Requests priority service. It can use more subscription allowance.", category: "model_config", type: "boolean", currentValue: selection.fast });
  }
  return options;
}

export async function changeSessionConfig(
  models: Models,
  selection: AcpSelection,
  supportsFast: SupportsFast,
  configId: string,
  value: string | boolean,
): Promise<AcpSelection> {
  switch (configId) {
    case "model": {
      if (typeof value !== "string") throw acp.RequestError.invalidParams(undefined, "model requires a provider/id string");
      let choice;
      try {
        choice = await resolveModel(models, value, selection.thinking);
      } catch (error) {
        throw acp.RequestError.invalidParams(undefined, error instanceof Error ? error.message : String(error));
      }
      const thinking = clampThinkingLevel(choice.model, selection.thinking);
      if (!getSupportedThinkingLevels(choice.model).includes(thinking)) {
        throw acp.RequestError.invalidParams(undefined, "model has no supported thinking levels");
      }
      return { model: choice.model, thinking, fast: false };
    }
    case "thinking": {
      const thinking = getSupportedThinkingLevels(selection.model).find((level) => level === value);
      if (thinking === undefined) throw acp.RequestError.invalidParams(undefined, "thinking level is not supported by the selected model");
      return { ...selection, thinking };
    }
    case "fast": {
      if (typeof value !== "boolean" || !supportsFast(selection.model)) {
        throw acp.RequestError.invalidParams(undefined, "fast requires a boolean and a supported model");
      }
      return { ...selection, fast: value };
    }
    default:
      throw acp.RequestError.invalidParams(undefined, `unknown session configuration option: ${configId}`);
  }
}
