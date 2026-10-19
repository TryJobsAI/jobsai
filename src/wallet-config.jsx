import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { QueryClient } from '@tanstack/react-query';
import { defineChain } from 'viem';
import '@rainbow-me/rainbowkit/styles.css';

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Chain Explorer', url: 'https://robinhoodchain.blockscout.com' } },
});

export const walletConfig = getDefaultConfig({
  appName: 'JobsAI',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'walletconnect-project-id-required',
  chains: [robinhood],
  ssr: false,
});

export const queryClient = new QueryClient();
export const sessionKey = 'jobsai-wallet-session-v1';
export const JobsAIAPI = window.JobsAIAPI;

export function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    return value && typeof value.token === 'string' && typeof value.walletAddress === 'string' ? value : null;
  } catch { return null; }
}
