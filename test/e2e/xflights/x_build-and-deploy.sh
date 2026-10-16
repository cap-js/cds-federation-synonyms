#!/usr/bin/env bash
# Usage:
#   bash x_build-and-deploy.sh              # re-pack plugin, mbt build, cf deploy
#   bash x_build-and-deploy.sh --pack-only  # re-pack plugin and re-install only (no build/deploy)
#   bash x_build-and-deploy.sh --build-only # re-pack plugin, mbt build only (no deploy)

set -euxo pipefail

cd "$(dirname "$(realpath "$0")")"

PACK_ONLY=false
BUILD_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --pack-only)  PACK_ONLY=true ;;
    --build-only) BUILD_ONLY=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$PACK_ONLY" = false ] && [ "$BUILD_ONLY" = false ]; then
  # Verify the active Cloud Foundry login, endpoint, organization, and space.
  cf target
  if ! cf oauth-token >/dev/null 2>&1; then
    echo "Not logged in to Cloud Foundry. Run 'cf login' before deploying." >&2
    exit 1
  fi
fi

npm pack ../../../ --pack-destination ..

npm install ../cap-js-cds-federation-synonyms-0.0.1.tgz

if [ "$PACK_ONLY" = true ]; then
  echo "Plugin re-packed and re-installed. Skipping mbt build and cf deploy."
  exit 0
fi

mbt build

if [ "$BUILD_ONLY" = true ]; then
  echo "Build complete. Skipping cf deploy."
  exit 0
fi

cf deploy mta_archives/capire.xflights_0.1.3.mtar
