import pkg from "../package.json" with { type: "json" };

declare const RX_BUILD: string | undefined;

export const VERSION: string = pkg.version;
export const VERSION_TEXT: string = typeof RX_BUILD === "string" ? `${VERSION} (${RX_BUILD})` : VERSION;
