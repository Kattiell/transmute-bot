import { createPublicClient, http, type PublicClient, type Address, erc20Abi, isAddress, getAddress } from 'viem';
import { base } from 'viem/chains';
import { GATE_CONFIG } from './config';
import { readCachedBalance, writeCachedBalance } from './db';

const clients: PublicClient[] = GATE_CONFIG.rpcUrls.map((url) =>
  createPublicClient({
    chain: base,
    transport: http(url, { timeout: 6_000, retryCount: 1 }),
  }) as PublicClient
);

export function isValidAddress(input: string): input is `0x${string}` {
  return isAddress(input, { strict: false });
}

export function normalizeAddress(input: string): `0x${string}` {
  return getAddress(input) as `0x${string}`;
}

async function callWithFailover<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const client of clients) {
    try {
      return await fn(client);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`All RPCs failed: ${(lastErr as Error)?.message ?? 'unknown'}`);
}

export interface BalanceResult {
  raw: bigint;
  decimals: number;
  formatted: number;
  meetsMinimum: boolean;
  minimum: bigint;
}

let cachedDecimals: number | null = null;
async function getTokenDecimals(): Promise<number> {
  if (cachedDecimals !== null) return cachedDecimals;
  const decimals = await callWithFailover((c) =>
    c.readContract({
      address: GATE_CONFIG.tokenAddress,
      abi: erc20Abi,
      functionName: 'decimals',
    })
  );
  cachedDecimals = Number(decimals);
  return cachedDecimals;
}

export async function getTokenBalance(walletAddress: string, opts: { bypassCache?: boolean } = {}): Promise<BalanceResult> {
  if (!isValidAddress(walletAddress)) throw new Error('Invalid wallet address');

  const wallet = walletAddress.toLowerCase() as `0x${string}`;

  if (!opts.bypassCache) {
    const cached = await readCachedBalance(wallet, GATE_CONFIG.chainId, GATE_CONFIG.tokenAddress);
    if (cached) {
      const decimals = await getTokenDecimals();
      const minimum = GATE_CONFIG.minBalance * 10n ** BigInt(decimals);
      return {
        raw: cached,
        decimals,
        formatted: Number(cached) / 10 ** decimals,
        meetsMinimum: cached >= minimum,
        minimum,
      };
    }
  }

  const [rawBalance, decimals] = await Promise.all([
    callWithFailover((c) =>
      c.readContract({
        address: GATE_CONFIG.tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet as Address],
      })
    ),
    getTokenDecimals(),
  ]);

  const raw = rawBalance as bigint;
  const minimum = GATE_CONFIG.minBalance * 10n ** BigInt(decimals);

  await writeCachedBalance(wallet, GATE_CONFIG.chainId, GATE_CONFIG.tokenAddress, raw);

  return {
    raw,
    decimals,
    formatted: Number(raw) / 10 ** decimals,
    meetsMinimum: raw >= minimum,
    minimum,
  };
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  return whole.toLocaleString('en-US');
}
