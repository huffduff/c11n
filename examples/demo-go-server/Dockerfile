# Build the demo upstream for the closedcloud cluster.
#
# Same pattern as the caddy image: the context is the REPO ROOT, because the
# SPA is an npm workspace package and the server is the Go module next to it.
#
#   closedcloud build . -f examples/demo-go-server/Dockerfile -t c11n-demo:v1
#
# node builds examples/demo-vue/dist, go builds the stdlib-only server, and the
# result is a distroless nonroot image with both baked in. It is a TEST
# UPSTREAM, not a shipped c11n image: it exists so the cluster install has a
# real site to review (Phase 5 task 5.5).
ARG NODE_VERSION=24.19.0
ARG GO_VERSION=1.27.2

# ---- 1. the SPA -------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS spa
ARG NODE_VERSION
WORKDIR /src
COPY package.json package-lock.json ./
COPY examples/demo-vue/package.json examples/demo-vue/
COPY packages/overlay/package.json packages/overlay/
COPY examples/demo-go-server/go.mod examples/demo-go-server/
COPY e2e/package.json e2e/
RUN npm ci --ignore-scripts
COPY examples/demo-vue examples/demo-vue
RUN npm run build -w examples/demo-vue

# ---- 2. the server ----------------------------------------------------------
FROM golang:${GO_VERSION}-alpine AS server
ARG GO_VERSION
WORKDIR /src
# Stdlib only (no go.sum, no module downloads): copy the module and build it.
COPY examples/demo-go-server/go.mod examples/demo-go-server/
COPY examples/demo-go-server/*.go examples/demo-go-server/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
      -o /out/demo-go-server ./examples/demo-go-server

# ---- 3. runtime -------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/demo-go-server /usr/local/bin/demo-go-server
COPY --from=spa /src/examples/demo-vue/dist /srv/demo
ENV C11N_GO_ADDR=0.0.0.0:15174 \
    C11N_GO_DIST=/srv/demo
USER 65532:65532
EXPOSE 15174
ENTRYPOINT ["/usr/local/bin/demo-go-server"]
