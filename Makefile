CARGO := cargo
CARGO_BIN := $(or $(CARGO_HOME),$(HOME)/.cargo)/bin
ALIASES := rxa rxc rxx rxo rxp rxd rxk
AGENT := target/rx-agent
GIT_COMMIT := $(shell git log -1 --abbrev=9 --format="%h %cs" 2>/dev/null)
GIT_DIRTY := $(shell git status --porcelain 2>/dev/null)
RX_BUILD := $(if $(GIT_COMMIT),$(GIT_COMMIT)$(if $(GIT_DIRTY),$(shell date -u "+, dirty, built %Y-%m-%dT%H:%MZ")))
unexport RX_BUILD

.PHONY: build release check audit fmt lint test agent agent-deps agent-check install uninstall

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
	cd agent && bun build --compile $(if $(RX_BUILD),--define 'RX_BUILD="$(RX_BUILD)"') src/cli.ts --outfile ../$(AGENT)

install: agent
	$(if $(RX_BUILD),RX_BUILD='$(RX_BUILD)') $(CARGO) install --path . --locked
	install -m 755 $(AGENT) "$(CARGO_BIN)/rx-agent"
	@for name in $(ALIASES); do ln -sfn rx "$(CARGO_BIN)/$$name"; done
	@if [ -d "$(HOME)/.zsh/completions" ]; then "$(CARGO_BIN)/rx" completions zsh > "$(HOME)/.zsh/completions/_rx"; fi

uninstall:
	$(CARGO) uninstall rx
	rm -f "$(CARGO_BIN)/rx-agent"
	@for name in $(ALIASES); do rm -f "$(CARGO_BIN)/$$name"; done
