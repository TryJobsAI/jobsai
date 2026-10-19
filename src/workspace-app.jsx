import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ConnectButton, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useDisconnect, usePublicClient, useSendTransaction, useWriteContract } from 'wagmi';
import { erc20Abi } from 'viem';
import { JobsAIAPI, queryClient, readSession, robinhood, sessionKey, walletConfig } from './wallet-config.jsx';
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

function CreateJobPanel({ session, walletAddress, chainId }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [asset, setAsset] = useState('eth');
  const [amount, setAmount] = useState('');
  const [deadlineAt, setDeadlineAt] = useState('');
  const [jobs, setJobs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [saving, setSaving] = useState(false);
  const publicClient = usePublicClient({ chainId: robinhood.id });
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();

  async function loadJobs(showLoading = true) {
    if (showLoading) setFeedback({ title: 'Loading your jobs', message: 'Retrieving jobs created from this wallet…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.myJobs(session.token);
      const ownJobs = (Array.isArray(response?.data) ? response.data : []).filter(job => job.clientWallet?.toLowerCase() === walletAddress?.toLowerCase()).map(job => ({ ...job, pendingFundingHash: localStorage.getItem(`jobsai-pending-funding-${job.id}`) || undefined }));
      setJobs(ownJobs);
      setLoaded(true);
      if (showLoading) setFeedback(null);
      return ownJobs;
    } catch (error) {
      setLoaded(true);
      setFeedback({ title: 'Could not load your jobs', message: error.message || 'JobsAI could not retrieve your jobs.', kind: 'error' });
      return [];
    }
  }

  useEffect(() => {
    const onOpen = () => { if (!loaded) loadJobs(); };
    document.addEventListener('jobsai:open-create', onOpen);
    if (new URLSearchParams(location.search).get('tab') === 'create') onOpen();
    return () => document.removeEventListener('jobsai:open-create', onOpen);
  }, [loaded, session.token, walletAddress]);

  async function createJob(event) {
    event.preventDefault();
    const acceptanceCriteria = criteria.split('\n').map(item => item.trim()).filter(Boolean);
    if (!acceptanceCriteria.length) {
      setFeedback({ title: 'Add acceptance criteria', message: 'Enter at least one clear condition for accepting the finished work.', kind: 'error' });
      return;
    }
    setSaving(true);
    setFeedback({ title: 'Creating your job', message: 'Setting up its escrow address and funding terms…', kind: 'loading' });
    try {
      const input = { title, description, acceptanceCriteria, asset, amount, ...(deadlineAt ? { deadlineAt: new Date(deadlineAt).toISOString() } : {}) };
      const response = await JobsAIAPI.createJob(input, session.token);
      const created = response.data;
      setJobs(current => [created, ...current.filter(job => job.id !== created.id)]);
      setLoaded(true);
      setTitle(''); setDescription(''); setCriteria(''); setAmount(''); setDeadlineAt('');
      setFeedback({ title: 'Job created', message: `Fund ${created.amount} ${created.asset} from your connected wallet to publish this job for claiming.`, kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Could not create job', message: error.message || 'JobsAI could not create this job.', kind: 'error' });
    } finally { setSaving(false); }
  }

  async function fundJob(job) {
    if (chainId !== robinhood.id) {
      setFeedback({ title: 'Switch network', message: 'Switch your wallet to Robinhood Chain, then try funding this job again.', kind: 'error' });
      return;
    }
    setSaving(true);
    setFeedback({ title: 'Confirm funding in your wallet', message: `Send exactly ${job.amount} ${job.asset} to this job’s escrow address. JobsAI will verify the transaction before listing the job.`, kind: 'loading' });
    let hash = job.pendingFundingHash;
    try {
      if (!hash && job.asset === 'ETH') hash = await sendTransactionAsync({ to: job.escrowAddress, value: BigInt(job.amountRaw), chainId: robinhood.id });
      else if (!hash) {
        if (!job.tokenAddress) throw new Error('USDG is not configured for this job. Contact JobsAI support.');
        hash = await writeContractAsync({ address: job.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [job.escrowAddress, BigInt(job.amountRaw)], chainId: robinhood.id });
      }
      localStorage.setItem(`jobsai-pending-funding-${job.id}`, hash);
      setJobs(current => current.map(item => item.id === job.id ? { ...item, pendingFundingHash: hash } : item));
      setFeedback({ title: 'Confirming escrow deposit', message: 'Waiting for the transaction to confirm on Robinhood Chain…', kind: 'loading' });
      if (!publicClient) throw new Error('Robinhood Chain is unavailable. Try again in a moment.');
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
      setFeedback({ title: 'Verifying escrow deposit', message: 'JobsAI is checking the sender, asset, and exact amount…', kind: 'loading' });
      await JobsAIAPI.fundJob(job.id, hash, session.token);
      localStorage.removeItem(`jobsai-pending-funding-${job.id}`);
      setJobs(current => current.map(item => item.id === job.id ? { ...item, status: 'ready', fundingTransaction: hash, pendingFundingHash: undefined } : item));
      setFeedback({ title: 'Job funded and published', message: 'Your job is now visible to eligible workers.', kind: 'success' });
    } catch (error) {
      if (hash) localStorage.setItem(`jobsai-pending-funding-${job.id}`, hash);
      setFeedback({ title: hash ? 'Verify your escrow deposit' : 'Funding was not completed', message: hash ? 'Your transfer was sent, but verification did not finish. Retry verification from your jobs list; do not send the funds again.' : error.message || 'The escrow deposit could not be completed.', kind: 'error' });
    } finally { setSaving(false); }
  }

  return <div className="create-job-grid">
    <form className="create-job-form" onSubmit={createJob}>
      <div className="create-job-form-heading"><span className="eyebrow">JOB DETAILS</span><h2>Describe the work.</h2><p>Make the scope and finish line clear before funding.</p></div>
      <label>Job title<input required minLength="3" maxLength="160" value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Build a product launch page" /></label>
      <label>Description<textarea required maxLength="20000" rows="5" value={description} onChange={event => setDescription(event.target.value)} placeholder="Explain the task, expected output, and any relevant context." /></label>
      <label>Acceptance criteria <small>One criterion per line</small><textarea required rows="4" value={criteria} onChange={event => setCriteria(event.target.value)} placeholder={'Responsive on mobile and desktop\nSource files included'} /></label>
      <div className="create-job-payment-row"><label>Payment asset<select value={asset} onChange={event => setAsset(event.target.value)}><option value="eth">ETH</option><option value="usdg">USDG</option></select></label><label>Amount<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?" value={amount} onChange={event => setAmount(event.target.value)} placeholder={asset === 'eth' ? '0.05' : '25'} /></label></div>
      <label>Deadline <small>Optional</small><input type="datetime-local" value={deadlineAt} onChange={event => setDeadlineAt(event.target.value)} /></label>
      <button className="pill primary" type="submit" disabled={saving}>Create job</button>
      <p className="create-job-note">Creating a job does not move funds. You review and approve the escrow transfer in your wallet as a separate step.</p>
    </form>
    <section className="created-jobs-card" aria-labelledby="created-jobs-title"><div className="created-jobs-heading"><div><span className="eyebrow">YOUR JOBS</span><h2 id="created-jobs-title">Created jobs</h2></div><button className="pill outline" onClick={() => loadJobs()} disabled={saving}>Refresh</button></div>
      {!loaded && <p className="created-jobs-empty">Your jobs will appear here. Select Refresh to load existing jobs from this wallet.</p>}
      {loaded && !jobs.length && <p className="created-jobs-empty">You haven’t created any jobs yet.</p>}
      <div className="created-jobs-list">{jobs.map(job => <article className="created-job-item" key={job.id}><div className="created-job-summary"><div><h3>{job.title}</h3><span className={`created-job-status status-${job.status}`}>{job.status.replaceAll('_', ' ')}</span></div><strong>{job.amount} {job.asset}</strong></div>
        {job.status === 'awaiting_funding' ? <><p>{job.pendingFundingHash ? 'A transfer was sent. Verify it to publish the job.' : 'Fund the escrow to publish this job for workers.'}</p><code>{job.escrowAddress}</code><button className="pill primary" onClick={() => fundJob(job)} disabled={saving}>{job.pendingFundingHash ? 'Verify deposit' : 'Fund job'}</button></> : <p>{job.status === 'ready' ? 'Funded and open for eligible workers to claim.' : `Current status: ${job.status.replaceAll('_', ' ')}.`}</p>}
      </article>)}</div>
    </section>
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="create-job-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : '!'}</span><h2 id="create-job-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
  </div>;
}

function WorkspaceContext() {
  const { address, chainId, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session, setSession] = useState(readSession);
  const header = document.getElementById('wallet-header-root');
  const jobsRoot = document.getElementById('live-jobs-root');
  const createJobRoot = document.getElementById('create-job-root');

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

  if (!header || !jobsRoot || !createJobRoot || !session?.token) return null;
  return <>
    {createPortal(<><ConnectButton.Custom>{({ account, openAccountModal, mounted }) => <button className="workspace-account-button" onClick={openAccountModal} disabled={!mounted || !account} aria-label={`Connected wallet ${account?.displayName || ''}`}><span className="workspace-account-status" />{account?.displayName || 'Connected wallet'}</button>}</ConnectButton.Custom><button className="workspace-signout" onClick={signOut}>Sign out</button></>, header)}
    {createPortal(<FundedJobs session={session} />, jobsRoot)}
    {createPortal(<CreateJobPanel session={session} walletAddress={address} chainId={chainId} />, createJobRoot)}
  </>;
}

createRoot(document.getElementById('workspace-wallet-context')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><WorkspaceContext /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
