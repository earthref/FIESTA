# Build the SPA
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve with nginx (SPA history fallback + /api proxy to the backend service).
# The nginx image's entrypoint runs envsubst over /etc/nginx/templates/, so
# BACKEND_HOST selects which backend service this frontend proxies to
# (per-node in multi-node compose stacks).
FROM nginx:alpine
ENV BACKEND_HOST=backend
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
