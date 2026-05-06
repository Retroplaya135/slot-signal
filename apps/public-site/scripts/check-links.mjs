import fs from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(new URL("..", import.meta.url).pathname);
const distRoot = path.join(appRoot, "dist");
const pages = (await fs.readdir(distRoot)).filter((name) => name.endsWith(".html"));
const failures = [];

for (const page of pages) {
  const source = await fs.readFile(path.join(distRoot, page), "utf8");
  for (const match of source.matchAll(/(?:href|src)="([^"]+)"/gu)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
    const relative = target.startsWith("/") ? target.slice(1) : path.join(path.dirname(page), target);
    const normalized = relative === "" ? "index.html" : relative;
    const filePath = path.join(distRoot, normalized);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) failures.push(`${page}: ${target}`);
    } catch {
      failures.push(`${page}: ${target}`);
    }
  }
}

if (failures.length) {
  throw new Error(`Broken local links:\n${failures.join("\n")}`);
}

console.log(`Checked ${pages.length} pages: no broken local links.`);
