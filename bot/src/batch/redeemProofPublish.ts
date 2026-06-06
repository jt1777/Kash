import { put } from '@vercel/blob';
import * as fs from 'fs';
import * as path from 'path';
import {
  publishRedeemProofToFrontend,
  redeemProofBotDir,
  redeemProofFilename,
} from './redeemProofPaths';

function blobPathPrefix(): string {
  return (process.env.REDEEM_PROOF_BLOB_PREFIX || 'redeem-proofs').replace(/^\/+|\/+$/g, '');
}

function publicBaseFromBlobUrl(blobUrl: string, prefix: string): string {
  const u = new URL(blobUrl);
  return `${u.origin}/${prefix}`;
}

async function publishToVercelBlob(src: string, filename: string): Promise<boolean> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) return false;

  const prefix = blobPathPrefix();
  const pathname = `${prefix}/${filename}`;
  const body = fs.readFileSync(src, 'utf8');

  const blob = await put(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    token,
  });

  const publicBase = publicBaseFromBlobUrl(blob.url, prefix);
  console.log(`   ☁️  Uploaded redeem proof to Vercel Blob: ${blob.url}`);
  console.log(`   ℹ️  Frontend env: NEXT_PUBLIC_REDEEM_PROOF_BASE_URL=${publicBase}\n`);
  return true;
}

/** Publish manifest after redeem Phase 2 — Vercel Blob if configured, else local frontend/public copy. */
export async function publishRedeemProof(product: string, batchCycle: bigint): Promise<void> {
  const filename = redeemProofFilename(product, batchCycle);
  const src = path.join(redeemProofBotDir(), filename);
  if (!fs.existsSync(src)) {
    console.warn(`   ⚠️  Redeem proof missing at ${src} — skip publish`);
    return;
  }

  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    try {
      const uploaded = await publishToVercelBlob(src, filename);
      if (uploaded) return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`   ❌ Vercel Blob upload failed: ${msg}`);
      if (process.env.REDEEM_PROOF_BLOB_REQUIRED === 'true') {
        throw err;
      }
    }
  }

  publishRedeemProofToFrontend(product, batchCycle);
}
