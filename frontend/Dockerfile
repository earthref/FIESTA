# Build the SPA.
#
# BASE_PATH is the path the SPA is served under: "/" (default, one node per
# hostname) or a node prefix such as "/MagIC/" when several nodes share one
# hostname (dev.earthref.org/MagIC/, later earthref.org/MagIC/). It must start
# and end with "/". It is baked into the build (asset URLs, router base) and
# also drives the nginx config below, so it is a build arg, not a runtime env.
FROM node:22-alpine AS build
ARG BASE_PATH=/
RUN case "$BASE_PATH" in /|/*/) ;; *) echo "BASE_PATH must start and end with '/', got '$BASE_PATH'" >&2; exit 1;; esac
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV VITE_BASE_PATH=$BASE_PATH
RUN npm run build

# Serve with nginx (SPA history fallback + /v2 proxy to the API service).
# The nginx image's entrypoint runs envsubst over /etc/nginx/templates/, so
# at runtime FIESTA_NODE picks the node this frontend is for (one image, any
# node), API_URL optionally points the SPA at another API origin (empty =
# proxy <base>v1/ to BACKEND_HOST), and BASE_PATH places the location blocks.
# The build lands at <html root><BASE_PATH> so nginx serves it from the same
# prefix the bundle was built for.
FROM nginx:alpine
ARG BASE_PATH=/
ENV BACKEND_HOST=api
ENV FIESTA_NODE=magic
ENV API_URL=
ENV BASE_PATH=$BASE_PATH
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html${BASE_PATH}
EXPOSE 80
