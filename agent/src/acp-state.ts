import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface AcpSelection {
  model: Model<Api>;
  thinking: ThinkingLevel;
  fast: boolean;
}

export type SupportsFast = (model: Model<Api>) => boolean;
