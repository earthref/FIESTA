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

# FIESTA_NODE is a comma-separated node list (magic,karar,cdr). The one API
# and worker serve every listed node; compose activates one frontend profile
# per node, so mirror the list into COMPOSE_PROFILES.
FIESTA_NODE ?= magic
export FIESTA_NODE
export COMPOSE_PROFILES = $(FIESTA_NODE)

# Targets that must see every service regardless of the selected nodes.
down clean ps logs build: export COMPOSE_PROFILES = *

# Frontend port per node (defaults mirror docker-compose.yml).
MAGIC_FRONTEND_PORT ?= 8080
KDD_FRONTEND_PORT   ?= 8081
CDR_FRONTEND_PORT   ?= 8082
KARAR_FRONTEND_PORT ?= 8083
ERDA_FRONTEND_PORT  ?= 8084
OSU_MGR_FRONTEND_PORT ?= 8086
port-magic := $(MAGIC_FRONTEND_PORT)
port-kdd   := $(KDD_FRONTEND_PORT)
port-cdr   := $(CDR_FRONTEND_PORT)
port-karar := $(KARAR_FRONTEND_PORT)
port-erda  := $(ERDA_FRONTEND_PORT)
port-osu-mgr := $(OSU_MGR_FRONTEND_PORT)

# Portal-bar cross-links: `slug=http://localhost:<port>` for every running
# node, so a multi-node local stack links to the sibling instances.
empty :=
space := $(empty) $(empty)
comma := ,
_node_list := $(subst $(comma), ,$(FIESTA_NODE))
_portal_pairs := $(foreach n,$(_node_list),$(n)=http://localhost:$(port-$(n)))
export FIESTA_PORTAL_URLS := $(subst $(space),$(comma),$(_portal_pairs))

.DEFAULT_GOAL := help

.PHONY: help
help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

## ---- Docker Compose stack -------------------------------------------------

.PHONY: up
up: ## Start infra + the API + worker + a frontend per node in FIESTA_NODE, hot reload (PROD=1 for the built images)
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
infra: ## Start only the infrastructure (postgres, opensearch, minio, mailpit)
	$(COMPOSE) up -d postgres opensearch minio mailpit

.PHONY: backend-dev
backend-dev: infra ## Run the API locally with reload (every node in FIESTA_NODE, :8000)
	cd backend && uv sync && FIESTA_CONFIG_FILE=../config/fiesta.yaml FIESTA_NODE=$(FIESTA_NODE) \
		uv run sh -c "fiesta init && uvicorn fiesta.apps.api:create_app --factory --reload"

.PHONY: worker-dev
worker-dev: ## Run the job worker locally (every node in FIESTA_NODE)
	cd backend && FIESTA_CONFIG_FILE=../config/fiesta.yaml FIESTA_NODE=$(FIESTA_NODE) uv run fiesta worker

.PHONY: frontend-dev
frontend-dev: ## Run the Vite dev server for the first FIESTA_NODE (proxies /v2 to localhost:8000)
	cd frontend && npm install && VITE_NODE=$(NODE1) npm run dev

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
