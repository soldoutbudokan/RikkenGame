// Builds the static site into dist/: bundles the game with React inlined
// and compiles the Tailwind classes used by Rikken.jsx.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["entry.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  loader: { ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: "dist/game.js",
});

execSync("npx tailwindcss -c tailwind.config.js -i tw.css -o dist/game.css --minify", { stdio: "inherit" });

writeFileSync("dist/index.html", `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rikken</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🃏</text></svg>">
<link rel="stylesheet" href="game.css">
<style>html,body{margin:0;height:100%;background:#022c22;overscroll-behavior:none}#rikken-root{height:100%}button{touch-action:manipulation}*{-webkit-tap-highlight-color:transparent}</style>
</head>
<body>
<div id="rikken-root"></div>
<script src="game.js"></script>
</body>
</html>
`);
writeFileSync("dist/.nojekyll", ""); // serve files verbatim on GitHub Pages
console.log("dist/ ready");
