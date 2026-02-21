import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CONTRACTS } from '@/lib/contracts/addresses';
import { ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/contracts/addresses';

// Etherscan API V2 (required; V1 deprecated). Same key works for all chains.
const ETHERSCAN_V2_API = 'https://api.etherscan.io/v2/api';
const KASH_YIELD_LOWER = (CONTRACTS.kashYield as string).toLowerCase();

function getEtherscanApiKey(): string {
  let key =
    process.env.ETHERSCAN_API_KEY ||
    process.env.ARBISCAN_API_KEY ||
    process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY ||
    process.env.NEXT_PUBLIC_ARBISCAN_API_KEY ||
    '';
  if (key) return key;
  // Next.js only loads .env from the app (frontend) dir; try repo root .env
  try {
    const rootEnv = join(process.cwd(), '..', '.env');
    if (existsSync(rootEnv)) {
      const content = readFileSync(rootEnv, 'utf-8');
      const match = content.match(/ETHERSCAN_API_KEY\s*=\s*["']?([^\s#"'\r\n]+)/m);
      if (match?.[1]) return match[1].trim();
      const match2 = content.match(/ARBISCAN_API_KEY\s*=\s*["']?([^\s#"'\r\n]+)/m);
      if (match2?.[1]) return match2[1].trim();
    }
  } catch {
    // ignore
  }
  return '';
}

// Function selectors (first 4 bytes of calldata) for our contract
const SELECTOR_REQUEST_MINT = '0x31a02bce';
const SELECTOR_REQUEST_REDEEM = '0x107703ab';

export type ActivityItem = {
  type: 'mint' | 'redeem';
  hash: string;
  timestamp: number;
  blockNumber: string;
};

type ArbiscanTx = {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  functionName: string;
};

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 20, 50);

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
  }

  const apiKey = getEtherscanApiKey();
  if (!apiKey) {
    console.error('Activity API: ETHERSCAN_API_KEY (or ARBISCAN_API_KEY) required for Etherscan API V2');
    return NextResponse.json({ error: 'Activity API not configured', activities: [] }, { status: 503 });
  }
  const url = `${ETHERSCAN_V2_API}?chainid=${ARBITRUM_SEPOLIA_CHAIN_ID}&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=100&sort=desc&apikey=${apiKey}`;

  try {
    const res = await fetch(url, { next: { revalidate: 60 } });
    const data = await res.json();

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return NextResponse.json({ activities: [] });
    }

    const txs = data.result as ArbiscanTx[];
    const activities: ActivityItem[] = [];

    for (const tx of txs) {
      if (activities.length >= limit) break;
      const to = (tx.to || '').toLowerCase();
      if (to !== KASH_YIELD_LOWER) continue;

      const input = (tx.input || '').toLowerCase();
      const selector = input.slice(0, 10);

      if (selector === SELECTOR_REQUEST_MINT) {
        activities.push({
          type: 'mint',
          hash: tx.hash,
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: tx.blockNumber,
        });
      } else if (selector === SELECTOR_REQUEST_REDEEM) {
        activities.push({
          type: 'redeem',
          hash: tx.hash,
          timestamp: parseInt(tx.timeStamp, 10),
          blockNumber: tx.blockNumber,
        });
      }
    }

    return NextResponse.json({ activities });
  } catch (e) {
    console.error('Activity API error:', e);
    return NextResponse.json({ error: 'Failed to fetch activity', activities: [] }, { status: 500 });
  }
}
