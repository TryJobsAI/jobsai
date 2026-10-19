import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ConnectButton, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useDisconnect } from 'wagmi';
import { JobsAIAPI, queryClient, readSession, sessionKey, walletConfig } from './wallet-config.jsx';
import './wallet-app.css';

function goToAuth() {
  const next = `workspace.html${location.search}`;
  location.replace(`auth.html?next=${encodeURIComponent(next)}`);
}

function FundedJobs({ session }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState({ title: 'Loading funded jobs', message: 'Checking for currently funded work…', kind: 'loading' });

  async function refresh() {
    setFeedback({ title: 'Loading funded jobs', message: 'Checking for currently funded work…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.readyJobs();
      const ready = Array.isArray(response?.data) ? response.data : [];
      setJobs(ready);
      setFeedback(null);
    } catch (error) { setJobs([]); setFeedback({ title: 'Could not load funded jobs', message: error.message || 'JobsAI could not load funded jobs.', kind: 'error' }); }
  }

  useEffect(() => { refresh(); }, []);

  async function claim(job) {
    setBusy(job.id);
    setFeedback({ title: 'Claiming job', message: 'Assigning this job to your wallet…', kind: 'loading' });
    try {
      await JobsAIAPI.claim(job.id, session.token);
      setJobs(current => current.filter(item => item.id !== job.id));
      setFeedback({ title: 'Job claimed', message: 'This job is now assigned to your wallet.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not claim job', message: error.message || 'The job could not be claimed.', kind: 'error' }); }
    finally { setBusy(''); }
  }

  return <>
    <div className="live-jobs-heading">
      <div><span className="eyebrow">LIVE · FUNDED ONCHAIN</span><h2 id="live-jobs-title">Jobs ready to claim</h2><p>Review each funded job, its listed asset, and acceptance criteria before claiming.</p></div>
      <button className="pill outline" onClick={refresh} disabled={!!busy}>Refresh</button>
    </div>
    {!jobs.length && !feedback && <div className="live-jobs-empty"><h3>No funded jobs are ready right now.</h3><p>Check back later or refresh to look for new work.</p></div>}
    <div className="live-jobs-list">{jobs.map(job => <article className="live-job-card" key={job.id}>
      <div className="live-job-top"><h3>{job.title}</h3><strong className="live-job-amount">{job.amount} {job.asset}</strong></div>
      <p className="live-job-description">{job.description}</p>
      {!!job.acceptanceCriteria?.length && <><h4>Acceptance criteria</h4><ul className="live-job-criteria">{job.acceptanceCriteria.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></>}
      <p className="live-job-deadline">{job.deadlineAt && !Number.isNaN(new Date(job.deadlineAt).valueOf()) ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided'}</p>
      <button className="pill primary live-job-claim" disabled={!!busy} onClick={() => claim(job)}>Claim job</button>
    </article>)}</div>
    {feedback && <div className="workspace-overlay" role="presentation"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : '!'}</span><h2 id="workspace-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
  </>;
}

function WorkspaceContext() {
  const { address, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session, setSession] = useState(readSession);
  const header = document.getElementById('wallet-header-root');
  const profile = document.getElementById('wallet-profile-root');
  const jobsRoot = document.getElementById('live-jobs-root');

  useEffect(() => {
    if (!session?.token) { goToAuth(); return; }
    if (isReconnecting) return;
    if (!isConnected || !address || session.walletAddress.toLowerCase() !== address.toLowerCase()) {
      sessionStorage.removeItem(sessionKey);
      goToAuth();
    }
  }, [session, address, isConnected, isReconnecting]);

  async function signOut() {
    try { await JobsAIAPI.logout(session.token); } catch {}
    try { await disconnectAsync(); } catch {}
    sessionStorage.removeItem(sessionKey);
    setSession(null);
    goToAuth();
  }

  if (!header || !profile || !jobsRoot || !session?.token) return null;
  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Wallet';
  return <>
    {createPortal(<><ConnectButton.Custom>{({ account, openAccountModal, mounted }) => <button className="workspace-account-button" onClick={openAccountModal} disabled={!mounted || !account} aria-label={`Connected wallet ${account?.displayName || ''}`}><span className="workspace-account-status" />{account?.displayName || 'Connected wallet'}</button>}</ConnectButton.Custom><button className="workspace-signout" onClick={signOut}>Sign out</button></>, header)}
    {createPortal(<div className="wallet-profile-summary"><span className="wallet-profile-icon">✓</span><div>Connected wallet<small>{short}</small></div></div>, profile)}
    {createPortal(<FundedJobs session={session} />, jobsRoot)}
  </>;
}

createRoot(document.getElementById('workspace-wallet-context')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><WorkspaceContext /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
