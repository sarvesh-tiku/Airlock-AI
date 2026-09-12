# Airlock developer entry points. `make help` lists them.
SHELL := /bin/bash
NODE  ?= node
PY    ?= python3
PORT  ?= 3000

.PHONY: help start dev test test-node test-python test-ts check seed demo-reset docker docker-run clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

start: ## Run the control plane on $(PORT)
	PORT=$(PORT) npm start

dev: ## Run with file watching
	PORT=$(PORT) npm run dev

test: test-node test-python test-ts ## Run every test suite

test-node: ## Node engine + HTTP tests (spawns a server)
	$(NODE) --test

test-python: ## Python client tests (spawns a server)
	$(PY) -m unittest discover -s sdk/python -v

test-ts: ## Type-check the TypeScript client (needs tsc; skipped if absent)
	@command -v npx >/dev/null && npx --yes -p typescript tsc -p sdk/typescript || echo "tsc unavailable; skipped"

check: ## Verify the Linear key and list importable issues
	npm run linear:check

seed: ## Create a fresh demo issue graph in your Linear workspace
	npm run linear:seed

demo-reset: ## Seed fresh Linear issues and reset the dashboard to sample data
	./scripts/demo-reset.sh

docker: ## Build the container image
	docker build -t airlock .

docker-run: ## Run the container on $(PORT) with your .env
	docker run --rm -p $(PORT):3000 --env-file .env airlock

clean: ## Remove runtime state
	rm -rf data/state.json data/state.json.tmp
