import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "smart-budget-site";
const basePath = `/${repositoryName}`;
const projectRoot = process.cwd();
const outputDirectory = path.resolve(
  projectRoot,
  process.env.GITHUB_PAGES_OUTPUT_DIRECTORY ?? "github-pages",
);
const workerFile = path.join(projectRoot, "dist", "server", "index.js");
const clientDirectory = path.join(projectRoot, "dist", "client");

const workerUrl = pathToFileURL(workerFile);
workerUrl.searchParams.set("github-pages-export", Date.now().toString());
const { default: worker } = await import(workerUrl.href);

const pageUrl = "https://fifeetch.github.io/";
const response = await worker.fetch(
  new Request(pageUrl, {
    headers: {
      accept: "text/html",
      "x-forwarded-host": "fifeetch.github.io",
      "x-forwarded-proto": "https",
    },
  }),
  {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  },
  {
    passThroughOnException() {},
    waitUntil() {},
  },
);

if (!response.ok) {
  throw new Error(`Static rendering failed with status ${response.status}.`);
}

let html = await response.text();

// GitHub Pages serves project sites below /<repository>/.
html = html
  .replaceAll("/assets/", `${basePath}/assets/`)
  .replaceAll("/favicon.svg", `${basePath}/favicon.svg`)
  .replaceAll("/manifest.webmanifest", `${basePath}/manifest.webmanifest`)
  .replaceAll("/apple-touch-icon.png", `${basePath}/apple-touch-icon.png`)
  .replaceAll(
    "https://fifeetch.github.io/og.png",
    `https://fifeetch.github.io${basePath}/og.png`,
  );

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(clientDirectory, outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "index.html"), html, "utf8");
await writeFile(path.join(outputDirectory, "404.html"), html, "utf8");
await writeFile(path.join(outputDirectory, ".nojekyll"), "", "utf8");

console.log(`GitHub Pages export created in ${outputDirectory}`);
