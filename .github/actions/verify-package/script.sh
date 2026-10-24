#!/bin/bash
set -ev

node -e "const Cesium = require('./');"
NODE_ENV=development node Specs/test.cjs
NODE_ENV=production node Specs/test.cjs
node Specs/test.mjs

for filename in packages/**/Specs/test.mjs; do
    node $filename
done

mkdir ../test
cp cesium*.tgz ../test
cp Specs/test.*js ../test
# Specs/test.mjs registers ./register-ts.mjs before it imports the un-bundled
# `cesium` barrel (the packed engine ships .ts sources, and Node refuses to
# strip types under node_modules). The hook imports esbuild, which a bare
# `npm install` of the three tarballs does not bring, so carry both across.
cp Specs/register-ts.mjs ../test
ESBUILD_VERSION=$(node -p "require('./package.json').devDependencies.esbuild")
cd ../test

npm install cesium-engine*.tgz
npm install cesium-widgets*.tgz
npm install cesium-1.*.tgz
npm install "esbuild@$ESBUILD_VERSION"
NODE_ENV=development node test.cjs
NODE_ENV=production node test.cjs
node test.mjs
