PLUGIN_ID ?= com.integrasources.read-receipts
PLUGIN_VERSION ?= 0.2.2
BUNDLE_NAME ?= $(PLUGIN_ID)-$(PLUGIN_VERSION).tar.gz

# Optional local Go SDK: prepended only if the directory exists.
# Override with `make GO_BIN_DIR=/path/to/go/bin` or set GO directly.
GO_BIN_DIR ?= $(HOME)/go-sdk/bin
export PATH := $(if $(wildcard $(GO_BIN_DIR)),$(GO_BIN_DIR):,)$(PATH)
GO ?= go
GOFLAGS ?= -ldflags '-s -w'

# Must stay in sync with plugin.json -> server.executables
PLUGIN_TARGETS ?= linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

.PHONY: all check-style check-style-server check-style-webapp dist server webapp \
        test test-server test-webapp node-deps node-deps-update clean

all: check-style test dist

node-deps:
	@test -d webapp/node_modules || (cd webapp && npm ci --silent)

node-deps-update:
	cd webapp && npm install

server:
	@mkdir -p server/dist
	@cd server && for target in $(PLUGIN_TARGETS); do \
		os=$${target%/*}; arch=$${target#*/}; ext=""; \
		if [ "$$os" = "windows" ]; then ext=".exe"; fi; \
		echo "building server/dist/plugin-$$os-$$arch$$ext"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build $(GOFLAGS) \
			-o dist/plugin-$$os-$$arch$$ext . || exit 1; \
	done

webapp: node-deps
	cd webapp && npm run build

dist: server webapp
	@mkdir -p dist/$(PLUGIN_ID)/server/dist dist/$(PLUGIN_ID)/webapp/dist
	@cp plugin.json dist/$(PLUGIN_ID)/
	@cp -r assets dist/$(PLUGIN_ID)/
	@cp server/dist/plugin-* dist/$(PLUGIN_ID)/server/dist/
	@cp webapp/dist/main.js dist/$(PLUGIN_ID)/webapp/dist/
	@cd dist && tar -czf $(BUNDLE_NAME) $(PLUGIN_ID)
	@echo "Built dist/$(BUNDLE_NAME)"

test: test-server test-webapp

test-server:
	cd server && $(GO) test -race ./...

test-webapp: node-deps
	cd webapp && npm run typecheck && npm run test

check-style: check-style-server check-style-webapp

check-style-server:
	@cd server && unformatted="$$(gofmt -l .)"; \
		if [ -n "$$unformatted" ]; then \
			echo "gofmt required for:"; echo "$$unformatted"; exit 1; \
		fi
	cd server && $(GO) vet ./...
	@if command -v golangci-lint >/dev/null 2>&1; then \
		cd server && golangci-lint run ./...; \
	else \
		echo "golangci-lint not installed - skipped (gofmt + go vet enforced above)"; \
	fi

check-style-webapp: node-deps
	cd webapp && npm run lint

clean:
	rm -rf dist server/dist webapp/dist webapp/node_modules
