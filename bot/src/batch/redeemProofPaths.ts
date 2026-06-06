import * as fs from 'fs';
import * as path from 'path';

/** Repo root whether `npm start` runs from `bot/` or the monorepo root. */
export function resolveRepoRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === 'bot' ? path.resolve(cwd, '..') : cwd;
}

export function redeemProofBotDir(): string {
  return path.join(resolveRepoRoot(), 'bot', 'data', 'redeem-proofs');
}

export function redeemProofFrontendDir(): string {
  return path.join(resolveRepoRoot(), 'frontend', 'public', 'redeem-proofs');
}

export function redeemProofFilename(product: string, batchCycle: bigint): string {
  return `${product}-batch-${batchCycle.toString()}.json`;
}

/** Copy bot manifest to frontend/public for Vercel/static claim UI. */
export function publishRedeemProofToFrontend(product: string, batchCycle: bigint): void {
  const filename = redeemProofFilename(product, batchCycle);
  const src = path.join(redeemProofBotDir(), filename);
  if (!fs.existsSync(src)) {
    console.warn(`   ⚠️  Redeem proof missing at ${src} — skip frontend publish`);
    return;
  }
  const destDir = redeemProofFrontendDir();
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  fs.copyFileSync(src, dest);
  console.log(`   📤 Published redeem proof for frontend: ${dest}`);
  console.log('   ℹ️  Commit + push (or redeploy Vercel) so users can claim from the app.\n');
}
