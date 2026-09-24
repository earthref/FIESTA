# FIESTA developer workflows.
#
# Stack selection and ports come from .env (see .env.example); every target
# honors the same variables, e.g.:
#   make up FIESTA_NODE=karar
#   make e2e API_PORT=18000

# `make up` layers the hot-reload overlay (Vite dev server, uvicorn --reload,
# watchfiles worker) so a `git pull` is live without rebuilding images.
# PROD=1 runs the built images exactly as deployed (CI's e2e job does this).
# (The dev overlay mounts a named volume at frontend/node_modules; `up` creates
# that directory first so Docker does not leave a root-owned one behind.)
COMPOSE_FILES := -f docker-compose.yml$(if $(PROD),, -f docker-compose.dev.yml)
COMPOSE := docker compose $(COMPOSE_FILES)

# Read the local .env so FIESTA_NODE / port overrides are visible to make.
-include .env

# FIESTA_NODE is a comma-separated node list (magic,karar,cdr). The one API,
# worker and frontend serve every listed node (the frontend at
# http://localhost:$(FRONTEND_PORT)/<Key>/).
FIESTA_NODE ?= magic
export FIESTA_NODE

.DEFAULT_GOAL := help

.PHONY: help
help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---- Docker Compose stack -------------------------------------------------

.PHONY: up
up: ## Start infra + the API + worker + the frontend (every node in FIESTA_NODE at /<Key>/), hot reload (PROD=1 for the built images)
	@mkdir -p frontend/node_modules
	$(COMPOSE) up -d --build --remove-orphans --wait

.PHONY: down
down: ## Stop the stack (keep data volumes)
	$(COMPOSE) down

.PHONY: clean
clean: ## Stop the stack and DELETE all data volumes
	$(COMPOSE) down -v

.PHONY: build
build: ## Build all images
	$(COMPOSE) build

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps

.PHONY: logs
logs: ## Tail logs (use SERVICE=api to narrow)
	$(COMPOSE) logs -f $(SERVICE)

## ---- Operations (run inside the backend image, for every node in FIESTA_NODE) --

comma := ,
NODES := $(subst $(comma), ,$(FIESTA_NODE))
NODE1 := $(word 1,$(NODES))

.PHONY: init
init: ## Apply migrations + job schema, ensure bucket + index (all nodes)
	$(COMPOSE) run --rm api fiesta init

.PHONY: user
user: ## Create an account: make user EMAIL=you@example.org NAME="Your Name"
	$(COMPOSE) run --rm api fiesta create-user $(EMAIL) "$(NAME)"

.PHONY: rebuild
rebuild: ## Rebuild search from Postgres + immutable revision files (all nodes)
	$(COMPOSE) run --rm api fiesta rebuild --yes

## ---- Local development (outside docker) ------------------------------------

.PHONY: infra
infra: ## Start only the infrastructure (postgres, opensearch, rustfs, mailpit)
	$(COMPOSE) up -d postgres opensearch rustfs mailpit

.PHONY: backend-dev
backend-dev: infra ## Run the API locally with reload (every node in FIESTA_NODE, :8000; portal links to `make frontend-dev`)
	cd backend && uv sync && FIESTA_CONFIG_FILE=../config/fiesta.yaml FIESTA_NODE=$(FIESTA_NODE) \
		FIESTA_FRONTEND_URL=http://localhost:5173 \
		uv run sh -c "fiesta init && uvicorn fiesta.apps.api:create_app --factory --reload"

.PHONY: fiesta
fiesta: ## Run the CLI on the host: make fiesta ARGS="legacy-inventory karar --out ../migration/karar" [ENV_FILE=.env.prod] [NODE=karar] [CMD=python]
	cd backend && $(if $(ENV_FILE),FIESTA_ENV_FILE=$(abspath $(ENV_FILE))) \
		FIESTA_CONFIG_FILE=../config/fiesta.yaml $(if $(NODE),FIESTA_NODE=$(NODE)) uv run $(or $(CMD),fiesta) $(ARGS)

.PHONY: worker-dev
worker-dev: ## Run the job worker locally (every node in FIESTA_NODE)
	cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml FIESTA_NODE=$(FIESTA_NODE) uv run fiesta worker

.PHONY: frontend-dev
frontend-dev: ## Run the Vite dev server on :5173 for every node in FIESTA_NODE (/<Key>/; proxies /v2 to localhost:8000)
	cd frontend && npm install && FIESTA_NODES=$(FIESTA_NODE) npm run dev

## ---- Tests & linting --------------------------------------------------------

.PHONY: test
test: test-backend test-frontend ## Run all tests/builds

.PHONY: test-backend
test-backend: ## Backend unit tests (pytest)
	cd backend && uv run pytest

.PHONY: test-frontend
test-frontend: ## Frontend type-check + production build
	cd frontend && npm run build

.PHONY: e2e
e2e: ## End-to-end workflow test against a running `make up FIESTA_NODE=magic` stack
	API_PORT=$(or $(API_PORT),8000) \
	MAILPIT_PORT=$(or $(MAILPIT_WEB_PORT),8025) bash scripts/e2e.sh

.PHONY: lint
lint: ## Lint everything (ruff + biome)
	cd backend && uv run ruff check .
	cd frontend && npx biome check .

.PHONY: fix
fix: ## Auto-fix lint issues (ruff --fix + biome --write)
	cd backend && uv run ruff check --fix .
	cd frontend && npx biome check --write .

.PHONY: seed
seed: ## Seed the enabled nodes with config-defined local fixtures (preserves edits)
	$(COMPOSE) run --rm api fiesta seed

.PHONY: test-phase-m
test-phase-m: ## Run all-node seeds and migration/revision integration tests without external services
	docker compose -p fiesta-phase-m-test -f compose.phase-m-test.yml run --build --rm tests

.PHONY: test-phase-m-restore
test-phase-m-restore: ## Rehearse a logical database restore against the isolated Phase M test bucket
	bash scripts/rehearse-phase-m-restore.sh
