#!/usr/bin/env bash
# Usage: bash x_clean.sh <xflights|xtravels|xtravels-j|all>
# Removes local dependencies and generated build output for the selected sample.
# With all, also removes shared plugin archives from this directory.
set -euo pipefail

usage() {
  echo "Usage: bash $(basename "$0") <xflights|xtravels|xtravels-j|all>"
}

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi
TARGET="$1"
case "$TARGET" in
  xflights|xtravels|xtravels-j) SAMPLES=("$TARGET") ;;
  all) SAMPLES=(xflights xtravels xtravels-j) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

cd "$(dirname "$(realpath "$0")")"
set -x

for SAMPLE in "${SAMPLES[@]}"; do
  (
    cd "$SAMPLE"
    rm -rf -- node_modules mtx/sidecar/node_modules app/router/node_modules mta_archives
    case "$SAMPLE" in
      xtravels-j)
        rm -rf -- mtx/sidecar/gen db/cfg db/src # db/cfg and db/src contain only generated files
        rm -rf -- srv/src/gen srv/src/main/resources/edmx srv/target
        rm -f -- srv/.flattened-pom.xml cap-js-cds-federation-synonyms-*.tgz
        ;;
      *) rm -rf -- gen ;;
    esac
  )
done

if [ "$TARGET" = all ]; then
  rm -f -- cap-js-cds-federation-synonyms-*.tgz
fi
