FROM mcr.microsoft.com/playwright@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS dependencies
RUN npm install -g pnpm@12.15.0 @anthropic-ai/claude-code@2.1.314 @openai/codex@0.163.0
WORKDIR /opt/rx
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
FROM dependencies AS build
RUN npm install -g bun@1.4.4
COPY src ./src
COPY evals ./evals
RUN bun build --compile --minify src/cli.ts --outfile /opt/rx/rx-agent
RUN node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {sourceHash} from "./evals/files.ts"; writeFileSync("source.json",JSON.stringify({sourceHash:sourceHash(".")}))'
FROM dependencies
COPY --from=build /opt/rx/rx-agent /usr/local/bin/rx-agent
COPY --from=build /opt/rx/source.json ./source.json
COPY evals ./evals
RUN mkdir -p /home/node && chown -R 1000:1000 /home/node
USER 1000:1000
WORKDIR /work
