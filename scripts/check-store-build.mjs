import { readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";

const outputDirectory = new URL("../apps/extension/.output/chrome-mv3/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", outputDirectory), "utf8"));
const expectedHosts = ["https://api.slot-signal.example/*"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  JSON.stringify(manifest.host_permissions ?? []) === JSON.stringify(expectedHosts),
  `Unexpected store host permissions: ${JSON.stringify(manifest.host_permissions ?? [])}`
);
assert(
  JSON.stringify(manifest.optional_host_permissions ?? []) === "[]",
  `Store build must not declare optional host permissions: ${JSON.stringify(manifest.optional_host_permissions ?? [])}`
);

const readableExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".mjs", ".txt"]);
const forbiddenPatterns = [
  { label: "local workstation path", pattern: /\/(?:Users|home)\//i },
  { label: "local Windows path", pattern: /[A-Z]:\\Users\\/i },
  { label: "local development host", pattern: /(?:127\.0\.0\.1|localhost):\d+/i },
  { label: "appointment portal permission", pattern: /https:\/\/ais\.usvisa-info\.com\/\*/i }
];

async function* walk(directoryUrl) {
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) yield* walk(child);
    else yield child;
  }
}

for await (const fileUrl of walk(outputDirectory)) {
  if (!readableExtensions.has(extname(fileUrl.pathname))) continue;
  const contents = await readFile(fileUrl, "utf8");
  for (const { label, pattern } of forbiddenPatterns) {
    assert(!pattern.test(contents), `${label} found in ${relative(outputDirectory.pathname, fileUrl.pathname)}`);
  }
}

console.log("Store build audit passed: least-privilege permissions and portable output verified.");
