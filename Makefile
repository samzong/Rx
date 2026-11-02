CARGO := cargo
CARGO_BIN := $(or $(CARGO_HOME),$(HOME)/.cargo)/bin
ALIASES := rxa rxc rxx rxo rxp rxd rxk
AGENT_BINARY := target/rx-agent
GIT_COMMIT := $(shell git log -1 --abbrev=9 --format="%h %cs" 2>/dev/null)
GIT_DIRTY := $(shell git status --porcelain 2>/dev/null)
RX_BUILD := $(if $(GIT_COMMIT),$(GIT_COMMIT)$(if $(GIT_DIRTY),$(shell date -u "+, dirty, built %Y-%m-%dT%H:%MZ")))
unexport RX_BUILD

.PHONY: build release check audit fmt lint test agent agent-deps agent-check eval eval-image eval-lifecycle install uninstall

build:
	$(CARGO) build --locked

release:
	$(CARGO) build --locked --release

check: audit fmt lint test

audit:
	$(CARGO) audit --file Cargo.lock

fmt:
	$(CARGO) fmt --all -- --check

lint:
	$(CARGO) clippy --locked --all-targets -- -D warnings

test:
	$(CARGO) test --locked

agent-deps:
	cd agent && pnpm install --frozen-lockfile

agent-check: agent-deps
	cd agent && pnpm audit && pnpm typecheck && pnpm test

agent: agent-deps
	mkdir -p "$(dir $(AGENT_BINARY))"
	@build_dir=$$(mktemp -d "$(abspath $(dir $(AGENT_BINARY)))/rx-agent-build.XXXXXX") && \
	trap 'rm -rf "$$build_dir"' EXIT && \
	trap 'exit 1' HUP INT TERM && \
	cd "$$build_dir" && \
	bun build --compile $(if $(RX_BUILD),--define 'RX_BUILD="$(RX_BUILD)"') "$(CURDIR)/agent/src/cli.ts" --outfile "$(abspath $(AGENT_BINARY))"

AGENT ?= rx-agent
eval:
	cd agent && node evals/run.ts --agent $(AGENT) $(ARGS)

eval-image:
	cd agent && docker build -f evals/Dockerfile -t rx-evals:local .

eval-lifecycle:
	cd agent && node evals/lifecycle.ts

install: agent
	$(if $(RX_BUILD),RX_BUILD='$(RX_BUILD)') $(CARGO) install --path . --locked
	install -m 755 $(AGENT_BINARY) "$(CARGO_BIN)/rx-agent"
	@for name in $(ALIASES); do ln -sfn rx "$(CARGO_BIN)/$$name"; done
	@if [ -d "$(HOME)/.zsh/completions" ]; then "$(CARGO_BIN)/rx" completions zsh > "$(HOME)/.zsh/completions/_rx"; fi

uninstall:
	$(CARGO) uninstall rx
	rm -f "$(CARGO_BIN)/rx-agent"
	@for name in $(ALIASES); do rm -f "$(CARGO_BIN)/$$name"; done
