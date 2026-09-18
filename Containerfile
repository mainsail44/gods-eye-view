# Build and run God's Eye View with Podman.
#
#   podman compose up -d --build     # reads keys from ./.env
#
# The image contains NO API keys. The browser-side keys (Google / Cesium) are
# compiled in by Vite, so the build uses placeholder sentinels and the
# entrypoint substitutes the real values from the environment at startup. That
# makes the image safe to push to a registry.

FROM docker.io/library/node:24-slim AS build
WORKDIR /app

# Puppeteer/sharp are test-only devDependencies; skip the Chromium download.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Sentinels, never real keys — see container/entrypoint.sh.
ENV GOOGLE_MAPS_API_KEY=__GEV_RUNTIME_GOOGLE_MAPS_API_KEY__ \
    CESIUM_ION_TOKEN=__GEV_RUNTIME_CESIUM_ION_TOKEN__
RUN npm run build && sh container/capture-templates.sh

FROM docker.io/library/node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

# `vite preview` serves the built assets *and* installs the local provider
# middleware (server/providers/*), so the toolchain stays in the final image.
COPY --from=build --chown=node:node /app /app

EXPOSE 4173
USER node

ENTRYPOINT ["/app/container/entrypoint.sh"]
