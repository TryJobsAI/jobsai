import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectButton, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useSignMessage, useSwitchChain } from 'wagmi';
import { JobsAIAPI, queryClient, readSession, robinhood, sessionKey, walletConfig } from './wallet-config.jsx';
import './wallet-app.css';

function nextPage() {
  const next = new URLSearchParams(location.search).get('next') || 'workspace.html';
  return /^workspace\.html(?:[?#].*)?$/.test(next) ? next : 'workspace.html';
}

function Auth() {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChain } = useSwitchChain();
  const [status, setStatus] = useState('Connect your wallet to enter JobsAI.');
  const [busy, setBusy] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const attemptedAddress = useRef('');

  async function authenticate(walletAddress) {
    setBusy(true);
    setStatus('Requesting secure sign-in…');
    try {
      const challenge = await JobsAIAPI.issueNonce(walletAddress);
      setStatus('Approve the sign-in message in your wallet. This does not send a transaction.');
      const signature = await signMessageAsync({ message: challenge.data.message });
      const response = await JobsAIAPI.verifyWallet({ address: walletAddress, nonce: challenge.data.nonce, signature });
      const session = { token: response.data.token, walletAddress: response.data.walletAddress };
      sessionStorage.setItem(sessionKey, JSON.stringify(session));
      setStatus('Welcome to JobsAI.');
      setTransitioning(true);
    } catch (error) {
      attemptedAddress.current = '';
      setStatus(error.code === 4001 ? 'Signature cancelled. You can try again when ready.' : error.message || 'Wallet sign-in failed.');
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!address || !isConnected) return;
    const session = readSession();
    if (session && session.walletAddress.toLowerCase() === address.toLowerCase()) {
      setStatus('Welcome back.');
      setTransitioning(true);
      return;
    }
    if (session) sessionStorage.removeItem(sessionKey);
    if (chainId !== robinhood.id) {
      setStatus('Switch to Robinhood Chain to continue.');
      return;
    }
    if (attemptedAddress.current !== address) {
      attemptedAddress.current = address;
      authenticate(address);
    }
  }, [address, chainId, isConnected]);

  useEffect(() => {
    if (!transitioning) return;
    const timer = setTimeout(() => location.replace(nextPage()), 1250);
    return () => clearTimeout(timer);
  }, [transitioning]);

  return <main className="jobsai-auth-page">
    <a className="jobsai-auth-brand" href="index.html"><span className="jobsai-auth-mark">J</span>JobsAI</a>
    <section className="jobsai-auth-card" aria-labelledby="auth-title">
      <span className="eyebrow">SECURE WALLET SIGN-IN</span>
      <h1 id="auth-title">Your work starts here.</h1>
      <p>Connect your wallet to see funded jobs and claim work on Robinhood Chain.</p>
      <div className="jobsai-auth-connect"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} /></div>
      {isConnected && chainId !== robinhood.id && <button className="jobsai-switch" onClick={() => switchChain({ chainId: robinhood.id })}>Switch to Robinhood Chain</button>}
      {isConnected && chainId === robinhood.id && !busy && !transitioning && attemptedAddress.current === '' && <button className="jobsai-claim" onClick={() => { attemptedAddress.current = address || ''; if (address) authenticate(address); }}>Continue to JobsAI</button>}
      <p className="jobsai-auth-status" role="status" aria-live="polite">{busy ? 'Confirm the message in your wallet…' : status}</p>
      <small>Wallet sign-in uses a message only. It does not move funds.</small>
    </section>
    <footer><a href="index.html">← Back to JobsAI</a><span>Robinhood Chain · ETH and USDG jobs</span></footer>
    {transitioning && <div className="jobsai-landscape-transition" aria-label="Opening your JobsAI dashboard"><div className="jobsai-landscape-sky"><span className="jobsai-landscape-sun"/><span className="jobsai-landscape-mountain mountain-back"/><span className="jobsai-landscape-mountain mountain-front"/><span className="jobsai-landscape-ground"/><span className="jobsai-landscape-path"/></div><strong>Welcome to JobsAI</strong></div>}
  </main>;
}

createRoot(document.getElementById('jobsai-auth-root')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><Auth /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
