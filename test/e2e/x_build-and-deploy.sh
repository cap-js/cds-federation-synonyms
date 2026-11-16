#!/usr/bin/env bash
# Usage:
#   bash x_build-and-deploy.sh xflights               # re-pack plugin, mbt build, cf deploy
#   bash x_build-and-deploy.sh xtravels --pack-only   # re-pack plugin and re-install only
#   bash x_build-and-deploy.sh xtravels-j --build-only # re-pack plugin, mbt build only

set -euo pipefail

usage() {
  echo "Usage: bash $(basename "$0") <xflights|xtravels|xtravels-j> [--pack-only|--build-only]"
}

SAMPLE="${1:-}"
case "$SAMPLE" in
  xflights)   ARCHIVE="capire.xflights_0.1.3.mtar" ;;
  xtravels)   ARCHIVE="capire.xtravels_1.0.1.mtar" ;;
  xtravels-j) ARCHIVE="capire.xtravels-j_1.0.1.mtar" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
shift

PACK_ONLY=false
BUILD_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --pack-only)  PACK_ONLY=true ;;
    --build-only) BUILD_ONLY=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$(realpath "$0")")/$SAMPLE"
set -x

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
if [ "$SAMPLE" != xflights ]; then
  (cd mtx/sidecar && npm install ../../../cap-js-cds-federation-synonyms-0.0.1.tgz)
fi

if [ "$PACK_ONLY" = true ]; then
  echo "Plugin re-packed and re-installed. Skipping mbt build and cf deploy."
  exit 0
fi

mbt build

if [ "$BUILD_ONLY" = true ]; then
  echo "Build complete. Skipping cf deploy."
  exit 0
fi

cf deploy "mta_archives/$ARCHIVE"
