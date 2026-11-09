// Minimal .env loader (no dependencies). Real environment variables win over the file.
import fs from 'node:fs';
import path from 'node:path';
try {
  const txt = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch {}
