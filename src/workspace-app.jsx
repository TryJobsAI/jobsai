import React, { useEffect, useState } from 'react';
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

function Workspace() {
  const { address, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session, setSession] = useState(readSession);
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState('Loading funded jobs…');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!session?.token) { goToAuth(); return; }
    if (isReconnecting) return;
    if (!isConnected || !address || session.walletAddress.toLowerCase() !== address.toLowerCase()) {
      sessionStorage.removeItem(sessionKey);
      goToAuth();
    }
  }, [session, address, isConnected, isReconnecting]);

  async function loadJobs() {
    setStatus('Checking JobsAI for funded work…');
    try {
      const response = await JobsAIAPI.readyJobs();
      const ready = Array.isArray(response?.data) ? response.data : [];
      setJobs(ready);
      setStatus(ready.length ? `${ready.length} funded ${ready.length === 1 ? 'job is' : 'jobs are'} ready to claim.` : 'No funded jobs are ready to claim right now. Refresh to check again.');
    } catch (error) { setJobs([]); setStatus(error.message || 'JobsAI could not load funded jobs.'); }
  }

  useEffect(() => { if (session?.token && isConnected && address?.toLowerCase() === session.walletAddress.toLowerCase()) loadJobs(); }, [session?.token, address, isConnected]);

  async function claim(job) {
    setBusy(job.id);
    try {
      await JobsAIAPI.claim(job.id, session.token);
      setJobs(current => current.filter(item => item.id !== job.id));
      setStatus('Job claimed. It is now assigned to your wallet.');
    } catch (error) { setStatus(error.message || 'The job could not be claimed.'); }
    finally { setBusy(''); }
  }

  async function signOut() {
    try { await JobsAIAPI.logout(session.token); } catch {}
    try { await disconnectAsync(); } catch {}
    sessionStorage.removeItem(sessionKey);
    setSession(null);
    goToAuth();
  }

  return <div className="jobsai-live-app">
    <header className="jobsai-live-header">
      <div><span className="eyebrow">JOBS AI · LIVE WORK</span><h1>Jobs ready to claim</h1><p>Funded jobs on Robinhood Chain, paid in the asset shown on each listing.</p></div>
      <div className="jobsai-wallet-controls"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} /><button className="jobsai-refresh" onClick={signOut}>Sign out</button></div>
    </header>
    <section className="jobsai-live-panel" aria-label="Funded jobs">
      <div className="jobsai-live-panel-head"><div><span className="eyebrow">SIGNED IN · {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'WALLET'}</span><h2>Open work</h2></div><button className="jobsai-refresh" onClick={loadJobs} disabled={!!busy}>Refresh</button></div>
      <p className="jobsai-live-status" role="status" aria-live="polite">{status}</p>
      <div className="jobsai-live-list">{jobs.map(job => <article className="jobsai-job-card" key={job.id}>
        <div className="jobsai-job-top"><h3>{job.title}</h3><strong>{job.amount} {job.asset}</strong></div>
        <p>{job.description}</p>
        {!!job.acceptanceCriteria?.length && <><h4>Acceptance criteria</h4><ul>{job.acceptanceCriteria.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></>}
        <p className="jobsai-job-deadline">{job.deadlineAt && !Number.isNaN(new Date(job.deadlineAt).valueOf()) ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided'}</p>
        <button className="jobsai-claim" disabled={!!busy} onClick={() => claim(job)}>{busy === job.id ? 'Claiming…' : 'Claim job'}</button>
      </article>)}</div>
    </section>
    <footer><a href="index.html">JobsAI home ↗</a><span>Claiming assigns the job. It does not move funds.</span></footer>
  </div>;
}

createRoot(document.getElementById('jobsai-workspace-root')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><Workspace /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
