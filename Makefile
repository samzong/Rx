PREFIX ?= $(HOME)/.local
BIN := $(PREFIX)/bin

.PHONY: deps check audit typecheck test install uninstall

deps:
	pnpm install --frozen-lockfile

check: audit typecheck test

audit:
	pnpm audit

typecheck:
	pnpm -s typecheck

test:
	pnpm -s test

install: deps
	mkdir -p "$(BIN)"
	ln -sfn "$(CURDIR)/src/cli.ts" "$(BIN)/rx"

uninstall:
	rm -f "$(BIN)/rx"
