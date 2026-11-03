import type * as acp from "@agentclientprotocol/sdk/unstable";
import { LODY_EXTENSION_METHODS, type LodySessionActivityState, type LodySessionActivityUpdate } from "acp-extension-core";

export function activityUpdate(sessionId: string, state: LodySessionActivityState): LodySessionActivityUpdate {
  return { version: 1, sessionId, state, backgroundTaskCount: 0 };
}

export function sessionActivityStream(stream: acp.Stream): acp.Stream {
  const requests = new Map<acp.JsonRpcId, string | undefined>();
  const writer = stream.writable.getWriter();
  return {
    readable: stream.readable.pipeThrough(new TransformStream({
      transform(message: acp.AnyMessage, controller) {
        if ("method" in message && "id" in message && ["session/new", "session/load", "session/resume", "session/fork"].includes(message.method)) {
          const params = message.params as { sessionId?: string } | undefined;
          requests.set(message.id, params?.sessionId);
        }
        controller.enqueue(message);
      },
    })),
    writable: new WritableStream({
      async write(message: acp.AnyMessage) {
        await writer.write(message);
        if (!("id" in message) || "method" in message || !requests.has(message.id)) return;
        const previous = requests.get(message.id);
        requests.delete(message.id);
        if (!("result" in message)) return;
        const result = message.result as { sessionId?: string } | null;
        const sessionId = result?.sessionId ?? previous;
        if (typeof sessionId !== "string") return;
        await writer.write({ jsonrpc: "2.0", method: LODY_EXTENSION_METHODS.sessionActivityUpdate, params: activityUpdate(sessionId, "idle") });
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
}
