CARGO := cargo
CARGO_BIN := $(or $(CARGO_HOME),$(HOME)/.cargo)/bin
ALIASES := rxa rxc rxx rxo rxp rxd rxk
AGENT := target/rx-agent

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
	cd agent && bun build --compile src/cli.ts --outfile ../$(AGENT)

install: agent
	$(CARGO) install --path . --locked
	install -m 755 $(AGENT) "$(CARGO_BIN)/rx-agent"
	@for name in $(ALIASES); do ln -sfn rx "$(CARGO_BIN)/$$name"; done
	@if [ -d "$(HOME)/.zsh/completions" ]; then "$(CARGO_BIN)/rx" completions zsh > "$(HOME)/.zsh/completions/_rx"; fi

uninstall:
	$(CARGO) uninstall rx
	rm -f "$(CARGO_BIN)/rx-agent"
	@for name in $(ALIASES); do rm -f "$(CARGO_BIN)/$$name"; done
