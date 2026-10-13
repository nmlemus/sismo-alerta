#!/usr/bin/env bash
# Rebuilds vendor/d3-custom-7.9.0.min.js: only the d3 modules the page uses
# (d3 7.9.0's own versions), about 26 KB gzipped instead of 92 KB for all of d3.
# If the code starts using another d3 function, add it to tools/d3-entry.js.
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d)
cp d3-entry.js "$tmp/entry.js"
cd "$tmp"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund d3-array@3.2.4 d3-scale@4.0.2 d3-shape@3.2.0 d3-selection@3.0.0 \
  d3-time@3.1.0 d3-time-format@4.1.0 d3-format@3.1.0 d3-delaunay@6.0.4 esbuild@0.24.0
out="$OLDPWD/../vendor/d3-custom-7.9.0.min.js"
{ echo '/*! d3 7.9.0 modules (ISC, Mike Bostock), delaunator (ISC, Mapbox), robust-predicates (Unlicense, Vladimir Agafonkin). See vendor/d3.LICENSE. */'
  npx esbuild entry.js --bundle --minify --format=iife --global-name=d3 --legal-comments=none --log-level=warning; } > "$out"
echo "wrote $out ($(gzip -9c "$out" | wc -c) bytes gzipped)"
