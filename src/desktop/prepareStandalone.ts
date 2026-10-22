import fs from 'fs';
import path from 'path';

export const STANDALONE_ASSET_PLAN = [
  { from: '.next/static', to: '.next/standalone/.next/static' },
  { from: 'public', to: '.next/standalone/public' },
] as const;

/** These paths are never part of the desktop asset copy. */
export const STANDALONE_EXCLUDED = [
  '.env',
  '.env.local',
  '.env.production',
  'python_backend',
  'python_backend/models',
] as const;

export interface StandaloneLayout {
  serverEntry: string;
  copies: Array<{ from: string; to: string }>;
}

export function resolveStandaloneLayout(repoRoot: string): StandaloneLayout {
  return {
    serverEntry: path.join(repoRoot, '.next', 'standalone', 'server.js'),
    copies: STANDALONE_ASSET_PLAN.map((entry) => ({
      from: path.join(repoRoot, entry.from),
      to: path.join(repoRoot, entry.to),
    })),
  };
}

export function shouldCopyAsset(source: string, copyRoot: string): boolean {
  if (path.resolve(source) === path.resolve(copyRoot)) {
    return true;
  }

  const base = path.basename(source);
  if (base === '.env' || base.startsWith('.env.')) {
    return false;
  }

  return !path.relative(copyRoot, source).split(path.sep).includes('python_backend');
}

export function prepareStandalone(repoRoot: string): StandaloneLayout {
  const layout = resolveStandaloneLayout(repoRoot);
  if (!fs.existsSync(layout.serverEntry)) {
    throw new Error('Next.js standalone server is missing. Run npm run build before starting the desktop shell.');
  }

  for (const copy of layout.copies) {
    if (!fs.existsSync(copy.from)) {
      throw new Error(`Desktop asset is missing: ${path.relative(repoRoot, copy.from)}`);
    }
    fs.mkdirSync(path.dirname(copy.to), { recursive: true });
    fs.cpSync(copy.from, copy.to, {
      recursive: true,
      force: true,
      filter: (source) => shouldCopyAsset(source, copy.from),
    });
  }

  return layout;
}
