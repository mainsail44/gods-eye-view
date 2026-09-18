#!/bin/sh
# Inject the browser-side keys into the prebuilt assets at startup.
#
# The image is built with placeholder sentinels instead of real keys, so it can
# be pushed to a registry without carrying any secrets. Each start restores the
# pristine placeholder copies and substitutes whatever is in the environment.
set -eu

TEMPLATE_DIR=/app/dist-template
DIST_DIR=/app/dist

substitute() {
  placeholder=$1
  value=$2
  # Escape the replacement for sed; keys are opaque strings.
  escaped=$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')
  find "$DIST_DIR" -type f \( -name '*.js' -o -name '*.html' \) -print0 |
    xargs -0 -r sed -i "s|$placeholder|$escaped|g"
}

if [ -d "$TEMPLATE_DIR" ]; then
  # Restore the placeholder versions so restarts are idempotent.
  (cd "$TEMPLATE_DIR" && find . -type f -exec cp {} "$DIST_DIR"/{} \;)
  substitute '__GEV_RUNTIME_GOOGLE_MAPS_API_KEY__' "${GOOGLE_MAPS_API_KEY:-}"
  substitute '__GEV_RUNTIME_CESIUM_ION_TOKEN__' "${CESIUM_ION_TOKEN:-}"
fi

exec npx vite preview --host "${HOST:-0.0.0.0}" --port "${PORT:-4173}"
