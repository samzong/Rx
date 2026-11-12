import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const children = new Set(["items", "additionalItems", "prefixItems", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "contentSchema"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(path: string, key: string): string {
  return `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function rewriteSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const moves: Array<{ from: string; to: string }> = [];
  const nodes: Array<{ schema: Record<string, unknown>; from: string; to: string }> = [];
  const visit = (value: unknown, from: string, to: string, baseFrom: string, baseTo: string): unknown => {
    if (!record(value)) return value;
    if (typeof value.$id === "string" && !value.$id.startsWith("#")) { baseFrom = from; baseTo = to; }
    const result = { ...value };
    nodes.push({ schema: result, from: baseFrom, to: baseTo });
    const properties = record(value.properties) ? value.properties : undefined;
    const moving = properties !== undefined && Object.hasOwn(properties, "$ref");
    let pattern = "^\\$ref$";
    if (moving && record(value.patternProperties)) {
      while (Object.hasOwn(value.patternProperties, pattern)) pattern = `(?:${pattern})`;
    }
    for (const [key, entry] of Object.entries(value)) {
      const source = pointer(from, key);
      const target = pointer(to, key);
      if (maps.has(key) && record(entry)) {
        result[key] = Object.fromEntries(Object.entries(entry).filter(([name]) => !(moving && key === "properties" && name === "$ref")).map(([name, child]) => [name, visit(child, pointer(source, name), pointer(target, name), baseFrom, baseTo)]));
      } else if (children.has(key)) {
        result[key] = Array.isArray(entry)
          ? entry.map((child, index) => visit(child, pointer(source, String(index)), pointer(target, String(index)), baseFrom, baseTo))
          : visit(entry, source, target, baseFrom, baseTo);
      }
    }
    if (moving) {
      const source = pointer(pointer(from, "properties"), "$ref");
      const target = pointer(pointer(to, "patternProperties"), pattern);
      moves.push({ from: source, to: target });
      result.patternProperties = { ...record(result.patternProperties) ? result.patternProperties : {}, [pattern]: visit(properties.$ref, source, target, baseFrom, baseTo) };
    }
    return result;
  };
  const rewritten = visit(schema, "", "", "", "") as Record<string, unknown>;
  if (!moves.length) return schema;
  moves.sort((left, right) => right.from.length - left.from.length);
  for (const node of nodes) {
    for (const key of ["$ref", "$dynamicRef", "$recursiveRef"]) {
      const ref = node.schema[key];
      if (typeof ref !== "string" || !ref.startsWith("#/")) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(ref.slice(1)); } catch { continue; }
      const target = node.from + decoded;
      const move = moves.find(({ from }) => target === from || target.startsWith(`${from}/`));
      if (!move) continue;
      const relocated = move.to + target.slice(move.from.length);
      if (relocated.startsWith(`${node.to}/`)) node.schema[key] = `#${relocated.slice(node.to.length).split("/").map(encodeURIComponent).join("/")}`;
    }
  }
  return rewritten;
}

function rewriteDefinition(value: unknown): unknown {
  if (!record(value)) return value;
  if (record(value.function)) return { ...value, function: rewriteDefinition(value.function) };
  if (typeof value.name !== "string" || !value.name.startsWith("mcp__")) return value;
  const key = record(value.input_schema) ? "input_schema" : record(value.parameters) ? "parameters" : undefined;
  if (!key) return value;
  const schema = value[key] as Record<string, unknown>;
  const rewritten = rewriteSchema(schema);
  return rewritten === schema ? value : { ...value, [key]: rewritten };
}

export function tokenerMcpStreamOptions(model: Model<Api>, options: SimpleStreamOptions): SimpleStreamOptions {
  if (model.provider !== "tokener") return options;
  return {
    ...options,
    onPayload: async (payload, selected) => {
      if (!record(payload)) return options.onPayload?.(payload, selected);
      const rewritten = {
        ...payload,
        ...(Array.isArray(payload.tools) ? { tools: payload.tools.map(rewriteDefinition) } : {}),
        ...(Array.isArray(payload.messages) ? { messages: payload.messages.map((message: unknown) => {
          if (!record(message) || !Array.isArray(message.content)) return message;
          return { ...message, content: message.content.map((block: unknown) => {
            if (!record(block) || block.type !== "tool_addition" || !record(block.tool) || block.tool.type !== "tool_definition") return block;
            return { ...block, tool: { ...block.tool, definition: rewriteDefinition(block.tool.definition) } };
          }) };
        }) } : {}),
      };
      const next = await options.onPayload?.(rewritten, selected);
      return next === undefined ? rewritten : next;
    },
  };
}
