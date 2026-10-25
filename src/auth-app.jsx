import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectButton, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useSignMessage, useSwitchChain } from 'wagmi';
import { JobsAIAPI, queryClient, readSession, robinhood, sessionKey, walletConfig } from './wallet-config.jsx';
import './wallet-app.css';

function nextPage() {
  const next = new URLSearchParams(location.search).get('next') || 'workspace.html';
  return /^(?:workspace|team)\.html(?:[?#].*)?$/.test(next) ? next : 'workspace.html';
}

function Auth() {
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChain } = useSwitchChain();
  const [busy, setBusy] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const attemptedAddress = useRef('');

  async function authenticate(walletAddress) {
    setBusy(true);
    setFeedback({ title: 'Signing in securely', message: 'Approve the sign-in message in your wallet. This does not send a transaction.', kind: 'loading' });
    try {
      const challenge = await JobsAIAPI.issueNonce(walletAddress);
      const signature = await signMessageAsync({ message: challenge.data.message });
      const response = await JobsAIAPI.verifyWallet({ address: walletAddress, nonce: challenge.data.nonce, signature });
      const session = { token: response.data.token, walletAddress: response.data.walletAddress };
      sessionStorage.setItem(sessionKey, JSON.stringify(session));
      setFeedback(null);
      setTransitioning(true);
    } catch (error) {
      attemptedAddress.current = '';
      setFeedback({ title: error.code === 4001 ? 'Sign-in cancelled' : 'Wallet sign-in failed', message: error.code === 4001 ? 'You can try connecting again when ready.' : error.message || 'Wallet sign-in failed.', kind: 'error' });
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!address || !isConnected) return;
    const session = readSession();
    if (session && session.walletAddress.toLowerCase() === address.toLowerCase()) {
      setTransitioning(true);
      return;
    }
    if (session) sessionStorage.removeItem(sessionKey);
    if (chainId !== robinhood.id) {
      setFeedback({ title: 'Switch network', message: 'JobsAI wallet sign-in uses Robinhood Chain.', kind: 'error', action: true });
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
    <a className="jobsai-auth-brand" href="index.html"><img src="assets/jobsai-approved-mark.svg" alt="" width="34" height="40" />JobsAI</a>
    <section className="jobsai-auth-card" aria-labelledby="auth-title">
      <span className="eyebrow">SECURE WALLET SIGN-IN</span>
      <h1 id="auth-title">Your work starts here.</h1>
      <div className="jobsai-auth-connect"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} /></div>
      {isConnected && chainId === robinhood.id && !busy && !transitioning && attemptedAddress.current === '' && <button className="jobsai-claim" onClick={() => { attemptedAddress.current = address || ''; if (address) authenticate(address); }}>Continue to JobsAI</button>}
      <button className="text-info-button" onClick={() => setFeedback({ title: 'About wallet sign-in', message: 'Connect your wallet to access funded jobs. JobsAI asks you to sign a message to verify your address; sign-in does not send a transaction or move funds.', kind: 'info' })}>Wallet sign-in details</button>
    </section>
    <footer><a href="index.html">← Back to JobsAI</a><span>Robinhood Chain · ETH and USDG jobs</span></footer>
    {transitioning && <div className="jobsai-landscape-transition" aria-label="Opening your JobsAI dashboard"><div className="jobsai-landscape-sky"><span className="jobsai-landscape-sun"/><span className="jobsai-landscape-mountain mountain-back"/><span className="jobsai-landscape-mountain mountain-front"/><span className="jobsai-landscape-ground"/><span className="jobsai-landscape-path"/></div><strong>Welcome to JobsAI</strong></div>}
    {feedback && !transitioning && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="auth-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="auth-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && (feedback.action ? <button className="pill primary" onClick={() => { setFeedback(null); switchChain({ chainId: robinhood.id }); }}>Switch to Robinhood Chain</button> : <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>)}</section></div>}
  </main>;
}

createRoot(document.getElementById('jobsai-auth-root')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><Auth /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
