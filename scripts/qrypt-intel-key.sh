#!/usr/bin/env bash
# Rotate the quantum-derived key that secures the app -> Starlight Intel link.
#
# The app side runs Qrypt BLAST gen_init_otp (32 bytes from Qrypt's QDEA
# entropy sources) and the intel side runs gen_sync on the resulting metadata.
# Both end up with the identical key; only the metadata ever moved. The two
# keys are written to qrypt-key/ which compose mounts read-only into both
# containers. Re-run to rotate; no restart needed, both sides re-read per call.
# status.json carries what the HUD shows: sources sampled with latency, key
# size, metadata size, TTL, cipher, and when the next rotation is due.
#
# Needs the Qrypt demo helpers built in $QRYPT_DEMO_DIR (default
# ~/workspace/Qrypt: bin/blast-psk-init, bin/blast-psk-sync, .env with BLAST=).
set -euo pipefail
QRYPT_DEMO_DIR="${QRYPT_DEMO_DIR:-/home/mainsail/workspace/Qrypt}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/qrypt-key"
TTL="${QRYPT_TTL:-600}"
ROTATE_EVERY="${QRYPT_ROTATE_EVERY:-600}"     # matches qrypt-intel-key.timer
export QRYPT_TOKEN="${QRYPT_TOKEN:-$(sed -n 's/^BLAST=//p' "$QRYPT_DEMO_DIR/.env" | tr -d '"\r')}"
[ -n "$QRYPT_TOKEN" ] || { echo "no BLAST token"; exit 1; }
mkdir -p "$OUT"; chmod 755 "$OUT"
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
fp() { printf '%s\n' "$1" | sha256sum | cut -c1-16; }
keyline() { grep -E '^[A-Za-z0-9+/]{43}=$' "$1" | tail -1; }

# App side: fresh key + metadata from the live entropy sources (DEBUG log on
# stdout gives per-source timings; the key is the one base64 line).
T0=$(date +%s%N)
BLAST_DEBUG=1 "$QRYPT_DEMO_DIR/bin/blast-psk-init" "$TMP/metadata.bin" "$TTL" >"$TMP/init.out" 2>"$TMP/init.err"
INIT_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
APP_KEY="$(keyline "$TMP/init.out")"
# Intel side: same key, re-derived from the metadata alone.
T0=$(date +%s%N)
"$QRYPT_DEMO_DIR/bin/blast-psk-sync" "$TMP/metadata.bin" >"$TMP/sync.out" 2>"$TMP/sync.err"
SYNC_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
INTEL_KEY="$(keyline "$TMP/sync.out")"
[ -n "$APP_KEY" ] && [ "$(fp "$APP_KEY")" = "$(fp "$INTEL_KEY")" ] || { echo "key mismatch between init and sync"; exit 1; }

# Per-source sample timings from the SDK log.
SOURCES_JSON=$(grep -oE 'Curl request to https://[^/]+/api/v1/user/generate-stateful-sample completed with status code 200 in [0-9.]+s' "$TMP/init.out" \
  | sed -E 's#Curl request to https://([^/]+)/.* in ([0-9.]+)s#\1 \2#' \
  | awk '{printf "%s{\"host\":\"%s\",\"ms\":%d}", (NR>1?",":""), $1, $2*1000}')
N_SOURCES=$(grep -o 'pinned [0-9]* entropy sources' "$TMP/init.err" | grep -o '[0-9]*' | head -1)
NOW=$(date -u +%s)
umask 022
printf '%s\n' "$APP_KEY"   > "$OUT/app.key.tmp";   mv "$OUT/app.key.tmp"   "$OUT/app.key"
printf '%s\n' "$INTEL_KEY" > "$OUT/intel.key.tmp"; mv "$OUT/intel.key.tmp" "$OUT/intel.key"
cat > "$OUT/status.json.tmp" <<JSON
{"fingerprint":"$(fp "$APP_KEY")",
 "rotated_at":"$(date -u -d @$NOW +%Y-%m-%dT%H:%M:%SZ)",
 "next_rotation_at":"$(date -u -d @$((NOW + ROTATE_EVERY)) +%Y-%m-%dT%H:%M:%SZ)",
 "origin":"Qrypt QDEA aws-eastus","region":"aws-eastus",
 "sources":${N_SOURCES:-10},"sources_detail":[${SOURCES_JSON}],
 "key_bits":256,"metadata_bytes":$(stat -c %s "$TMP/metadata.bin"),"ttl":$TTL,
 "init_ms":$INIT_MS,"sync_ms":$SYNC_MS,
 "cipher":"AES-256-GCM","sdk":"Qrypt BLAST C SDK 0.12.8","protocol":"BLAST (gen_init_otp / gen_sync)"}
JSON
mv "$OUT/status.json.tmp" "$OUT/status.json"
unset APP_KEY INTEL_KEY
echo "rotated: $(tr -d '\n' < "$OUT/status.json")"
