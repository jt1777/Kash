/**
 * Print NEXT_PUBLIC_REDEEM_PROOF_BASE_URL from an existing Blob upload.
 * Run on the machine that has BLOB_READ_WRITE_TOKEN in bot/.env:
 *   npm run redeem-proof:blob-url
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
import { list } from '@vercel/blob';

dotenv.config({ path: path.join(__dirname, '../../.env') });

function blobPathPrefix(): string {
  return (process.env.REDEEM_PROOF_BLOB_PREFIX || 'redeem-proofs').replace(/^\/+|\/+$/g, '');
}

function publicBaseFromBlobUrl(blobUrl: string, prefix: string): string {
  const u = new URL(blobUrl);
  return `${u.origin}/${prefix}`;
}

async function main(): Promise<void> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    console.error('BLOB_READ_WRITE_TOKEN is not set in bot/.env');
    process.exit(1);
  }

  const prefix = blobPathPrefix();
  const listPrefix = `${prefix}/`;

  const { blobs } = await list({ prefix: listPrefix, limit: 10, token });
  if (blobs.length === 0) {
    console.log(`No blobs found under prefix "${listPrefix}".`);
    console.log('Either no redeem Phase 2 has uploaded yet, or REDEEM_PROOF_BLOB_PREFIX differs.');
    console.log('After the next redeem batch, check bot logs for:');
    console.log('  ℹ️  Frontend env: NEXT_PUBLIC_REDEEM_PROOF_BASE_URL=...');
    process.exit(0);
  }

  const sample = blobs[0];
  const publicBase = publicBaseFromBlobUrl(sample.url, prefix);

  console.log('Found redeem proof blobs in Vercel Blob.\n');
  console.log(`Sample file: ${sample.pathname}`);
  console.log(`Sample URL:  ${sample.url}\n`);
  console.log('Set this on frontend (local + Vercel production), then redeploy:\n');
  console.log(`NEXT_PUBLIC_REDEEM_PROOF_BASE_URL=${publicBase}\n`);
  console.log(`Proof fetch example: ${publicBase}/btc-batch-494671.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
