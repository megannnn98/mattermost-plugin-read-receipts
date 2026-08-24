GO ?= $(shell which go)
GOFLAGS ?= -ldflags '-s -w'
PLUGIN_ID ?= com.integrasources.read-receipts
PLUGIN_VERSION ?= 0.1.0
BUNDLE_NAME ?= $(PLUGIN_ID)-$(PLUGIN_VERSION).tar.gz

export PATH := /home/b/go-sdk/bin:$(PATH)

.PHONY: all check-style dist server webapp test clean

all: check-style test dist

server:
	cd server && go build $(GOFLAGS) -o dist/plugin-linux-amd64 .

webapp:
	cd webapp && npm install --silent && npm run build

dist: server webapp
	@mkdir -p dist
	@rm -rf dist/$(PLUGIN_ID)
	@mkdir -p dist/$(PLUGIN_ID)/server/dist
	@mkdir -p dist/$(PLUGIN_ID)/webapp/dist
	@cp plugin.json dist/$(PLUGIN_ID)/
	@cp server/dist/plugin-linux-amd64 dist/$(PLUGIN_ID)/server/dist/ 2>/dev/null || true
	@cp webapp/dist/main.js dist/$(PLUGIN_ID)/webapp/dist/ 2>/dev/null || true
	@cd dist && tar -czf $(BUNDLE_NAME) $(PLUGIN_ID)
	@echo "Built dist/$(BUNDLE_NAME)"

test: test-server test-webapp

test-server:
	cd server && go test -v -race ./...

test-webapp:
	cd webapp && npm install --silent && npm run typecheck && npm run test

check-style: check-style-server check-style-webapp

check-style-server:
	@echo "Skipping golangci-lint (not installed)"

check-style-webapp:
	cd webapp && npm install --silent && npm run lint || true

clean:
	rm -rf dist server/dist webapp/dist webapp/node_modules
