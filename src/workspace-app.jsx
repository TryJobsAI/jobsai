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
  const [status, setStatus] = useState('Loading funded jobs…');
  const [busy, setBusy] = useState('');

  async function refresh() {
    setStatus('Checking JobsAI for funded work…');
    try {
      const response = await JobsAIAPI.readyJobs();
      const ready = Array.isArray(response?.data) ? response.data : [];
      setJobs(ready);
      setStatus(ready.length ? `${ready.length} funded ${ready.length === 1 ? 'job is' : 'jobs are'} ready to claim.` : 'No funded jobs are ready to claim right now. Refresh to check again.');
    } catch (error) { setJobs([]); setStatus(error.message || 'JobsAI could not load funded jobs.'); }
  }

  useEffect(() => { refresh(); }, []);

  async function claim(job) {
    setBusy(job.id);
    try {
      await JobsAIAPI.claim(job.id, session.token);
      setJobs(current => current.filter(item => item.id !== job.id));
      setStatus('Job claimed. It is now assigned to your wallet.');
    } catch (error) { setStatus(error.message || 'The job could not be claimed.'); }
    finally { setBusy(''); }
  }

  return <>
    <div className="live-jobs-heading">
      <div><span className="eyebrow">LIVE · FUNDED ON ROBINHOOD CHAIN</span><h2 id="live-jobs-title">Jobs ready to claim</h2><p>Review each funded job, its listed asset, and acceptance criteria before claiming.</p></div>
      <button className="pill outline" onClick={refresh} disabled={!!busy}>Refresh</button>
    </div>
    <p className="live-jobs-status" role="status" aria-live="polite">{status}</p>
    <div className="live-jobs-list">{jobs.map(job => <article className="live-job-card" key={job.id}>
      <div className="live-job-top"><h3>{job.title}</h3><strong className="live-job-amount">{job.amount} {job.asset}</strong></div>
      <p className="live-job-description">{job.description}</p>
      {!!job.acceptanceCriteria?.length && <><h4>Acceptance criteria</h4><ul className="live-job-criteria">{job.acceptanceCriteria.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></>}
      <p className="live-job-deadline">{job.deadlineAt && !Number.isNaN(new Date(job.deadlineAt).valueOf()) ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided'}</p>
      <button className="pill primary live-job-claim" disabled={!!busy} onClick={() => claim(job)}>{busy === job.id ? 'Claiming…' : 'Claim job'}</button>
    </article>)}</div>
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
    {createPortal(<><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} /><button className="workspace-signout" onClick={signOut}>Sign out</button></>, header)}
    {createPortal(<div className="wallet-profile-summary"><span className="wallet-profile-icon">✓</span><div>Connected wallet<small>{short}</small></div></div>, profile)}
    {createPortal(<FundedJobs session={session} />, jobsRoot)}
  </>;
}

createRoot(document.getElementById('workspace-wallet-context')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><WorkspaceContext /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
