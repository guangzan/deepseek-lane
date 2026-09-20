#!/usr/bin/env zx

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { $, cd } from "zx";

let version = process.argv[2];

if (!version) {
  throw new Error("No tag specified");
}

if (version.startsWith("v")) {
  version = version.slice(1);
}

const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

if (pkg.version !== version) {
  throw new Error(
    `Package version from tag "${version}" mismatches with the current version "${pkg.version}"`,
  );
}

const releaseTag = version.includes("beta")
  ? "beta"
  : version.includes("alpha")
    ? "alpha"
    : undefined;

console.log("Publishing version", version, "with tag", releaseTag || "latest");

cd("packages/cli");

// Use npx to run the latest npm which supports Trusted Publishing (OIDC).
// The npm bundled with vp's Node.js runtime may be too old.
if (releaseTag) {
  await $`npx npm@latest publish --access public --provenance --tag ${releaseTag}`;
} else {
  await $`npx npm@latest publish --access public --provenance`;
}
