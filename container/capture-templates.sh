#!/bin/sh
# Save a pristine copy of every built file that still contains a key
# placeholder, so the entrypoint can re-substitute on every start.
set -eu
cd /app
rm -rf dist-template
find dist -type f \( -name '*.js' -o -name '*.html' \) \
  -exec grep -lE '__GEV_RUNTIME_(GOOGLE_MAPS_API_KEY|CESIUM_ION_TOKEN)__' {} + |
  while IFS= read -r file; do
    target="dist-template/${file#dist/}"
    mkdir -p "$(dirname "$target")"
    cp "$file" "$target"
  done
echo "Captured key placeholders in:"
find dist-template -type f 2>/dev/null || echo "  (none)"
