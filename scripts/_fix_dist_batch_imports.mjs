import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist_batch/src');

function hasExt(spec) {
  return /\.[a-zA-Z0-9]+$/.test(spec);
}

function fixText(text) {
  text = text.replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, p1, spec, p3) => {
    if (hasExt(spec)) return m;
    return `${p1}${spec}.js${p3}`;
  });
  text = text.replace(/(\bimport\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, p1, spec, p3) => {
    if (hasExt(spec)) return m;
    return `${p1}${spec}.js${p3}`;
  });
  return text;
}

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.isFile() && p.endsWith('.js')) {
      const before = fs.readFileSync(p, 'utf8');
      const after = fixText(before);
      if (after !== before) fs.writeFileSync(p, after, 'utf8');
    }
  }
}

if (!fs.existsSync(root)) {
  console.error(`dist_batch not found at ${root}`);
  process.exit(1);
}

walk(root);
console.log('dist_batch import specifiers patched for Node ESM (.js extensions).');
