# FIESTA developer workflows.
#
# Stack selection and ports come from .env (see .env.example); every target
# honors the same variables, e.g.:
#   make up FIESTA_NODE=karar
#   make e2e BACKEND_PORT=18000 PUBLIC_API_PORT=18001

COMPOSE := docker compose

# Read the local .env so FIESTA_NODE / port overrides are visible to make.
-include .env

# FIESTA_NODE is a comma-separated node list (magic,karar,cdr). Compose
# activates one profile per node, so mirror it into COMPOSE_PROFILES.
FIESTA_NODE ?= magic
export FIESTA_NODE
export COMPOSE_PROFILES = $(FIESTA_NODE)

# Targets that must see every service regardless of the selected nodes.
down clean ps logs build: export COMPOSE_PROFILES = *
up-public-api: export COMPOSE_PROFILES = $(FIESTA_NODE),public-api

# Frontend port per node (defaults mirror docker-compose.yml).
MAGIC_FRONTEND_PORT ?= 8080
KDD_FRONTEND_PORT   ?= 8081
CDR_FRONTEND_PORT   ?= 8082
KARAR_FRONTEND_PORT ?= 8083
port-magic := $(MAGIC_FRONTEND_PORT)
port-kdd   := $(KDD_FRONTEND_PORT)
port-cdr   := $(CDR_FRONTEND_PORT)
port-karar := $(KARAR_FRONTEND_PORT)

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
up: ## Start the node stack(s) in FIESTA_NODE (e.g. make up FIESTA_NODE=magic,karar)
	$(COMPOSE) up -d --build --remove-orphans

.PHONY: up-public-api
up-public-api: ## Start the node stack(s) plus the /v1 public API
	$(COMPOSE) up -d --build --remove-orphans

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
logs: ## Tail logs (use SERVICE=backend-magic to narrow)
	$(COMPOSE) logs -f $(SERVICE)

## ---- Operations (run inside the backend image) -----------------------------

comma := ,
NODES := $(subst $(comma), ,$(FIESTA_NODE))
NODE1 := $(word 1,$(NODES))

.PHONY: init
init: ## Apply migrations + job schema, ensure bucket + index (all nodes)
	@for n in $(NODES); do $(COMPOSE) run --rm backend-$$n fiesta init; done

.PHONY: user
user: ## Create an account: make user EMAIL=you@example.org NAME="Your Name"
	$(COMPOSE) run --rm backend-$(NODE1) fiesta create-user $(EMAIL) "$(NAME)"

.PHONY: rebuild
rebuild: ## Rebuild Postgres + OpenSearch from the YAML config + bucket (all nodes)
	@for n in $(NODES); do $(COMPOSE) run --rm backend-$$n fiesta rebuild --yes; done

## ---- Local development (outside docker) ------------------------------------

.PHONY: infra
infra: ## Start only the infrastructure (postgres, opensearch, minio, mailpit)
	$(COMPOSE) up -d postgres opensearch minio mailpit

.PHONY: backend-dev
backend-dev: infra ## Run the first FIESTA_NODE's backend locally with reload
	cd backend && uv sync && FIESTA_CONFIG_FILE=../config/$(NODE1).yaml \
		uv run sh -c "fiesta init && uvicorn fiesta.apps.node:create_app --factory --reload"

.PHONY: public-api-dev
public-api-dev: infra ## Run the public API locally with reload
	cd backend && uv sync && FIESTA_CONFIG_FILE=../config/public-api.yaml \
		uv run sh -c "fiesta init && uvicorn fiesta.apps.public:create_app --factory --reload --port 8001"

.PHONY: worker-dev
worker-dev: ## Run the first FIESTA_NODE's job worker locally
	cd backend && FIESTA_CONFIG_FILE=../config/$(NODE1).yaml uv run fiesta worker

.PHONY: frontend-dev
frontend-dev: ## Run the Vite dev server (proxies /api to localhost:8000)
	cd frontend && npm install && npm run dev

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
e2e: ## End-to-end workflow test against a running magic + public-api stack
	BACKEND_PORT=$(or $(MAGIC_BACKEND_PORT),8000) \
	PUBLIC_API_PORT=$(or $(PUBLIC_API_PORT),8005) bash scripts/e2e.sh

.PHONY: lint
lint: ## Lint everything (ruff + biome)
	cd backend && uv run ruff check .
	cd frontend && npx biome check .

.PHONY: fix
fix: ## Auto-fix lint issues (ruff --fix + biome --write)
	cd backend && uv run ruff check --fix .
	cd frontend && npx biome check --write .
