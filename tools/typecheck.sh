#!/bin/sh
# Type-check with the Node type definitions installed on this machine (pass a typeRoots dir to override).
ROOTS=${1:-/opt/node-tools/node_modules/@types}
exec tsc -p "$(dirname "$0")/.." --typeRoots "$ROOTS" --types node
