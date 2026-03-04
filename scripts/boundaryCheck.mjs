#!/usr/bin/env node
/**
 * boundary:check — FAIL if src/sim imports src/map or assets.
 *
 * Locked boundary: src/sim/** must not import src/map/** or assets/** (or data/map).
 */
import fs from "node:fs";
import path from "node:path";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function extractImportStrings(src) {
  const out = [];
  const patterns = [
    /import\s+[^;]*?from\s+["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      out.push(m[1]);
    }
  }
  return out;
}

function isForbiddenResolved(resolvedAbs) {
  const norm = path.normalize(resolvedAbs);
  const root = path.resolve(".");
  const rel = path.relative(root, norm);
  const relNorm = rel.split(path.sep).join("/");
  if (relNorm.startsWith("src/map/")) return true;
  if (relNorm.startsWith("assets/")) return true;
  if (relNorm.startsWith("data/map/")) return true;
  return false;
}

function check() {
  const simRoot = path.resolve("src/sim");
  const files = walk(simRoot).filter((p) => /\.(ts|tsx|js|mjs|cjs)$/.test(p));

  const violations = [];

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const imports = extractImportStrings(src);

    for (const imp of imports) {
      if (typeof imp !== "string") continue;

      // Non-relative imports can't be resolved to our src tree reliably; skip.
      if (!imp.startsWith(".") && !imp.startsWith("/")) continue;

      // Resolve relative imports against file.
      let resolved = imp;
      if (imp.startsWith("/")) {
        // absolute path (web) not relevant to node resolution; flag if it hits /data/map
        if (imp.startsWith("/data/map") || imp.startsWith("/assets")) {
          violations.push({ file: path.relative(".", file), import: imp, reason: "web import path forbidden in sim" });
        }
        continue;
      }

      const base = path.dirname(file);
      const abs = path.resolve(base, imp);

      // Handle extensionless by checking typical extensions and index.
      const candidates = [
        abs,
        abs + ".ts",
        abs + ".tsx",
        abs + ".js",
        abs + ".mjs",
        abs + ".cjs",
        path.join(abs, "index.ts"),
        path.join(abs, "index.tsx"),
        path.join(abs, "index.js")
      ];

      let found = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          found = c;
          break;
        }
      }

      if (found && isForbiddenResolved(found)) {
        violations.push({ file: path.relative(".", file), import: imp, resolved: path.relative(".", found) });
      }
    }

  }

  return { files_scanned: files.length, violations };
}

const result = {
  gate: "boundary_check",
  started_at: new Date().toISOString(),
  ...check()
};

const outPath = path.resolve("qa_artifacts/boundary_check/report.json");
writeJson(outPath, {
  ...result,
  ok: result.violations.length === 0
});

if (result.violations.length) {
  console.error(`boundary:check FAIL — see ${outPath}`);
  for (const v of result.violations.slice(0, 12)) {
    console.error(" -", v.file, "imports", v.import ?? "(string)", v.resolved ?? v.reason ?? "");
  }
  process.exit(1);
}

console.log(`boundary:check OK — ${outPath}`);
process.exit(0);
