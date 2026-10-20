import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ConnectButton, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useDisconnect, usePublicClient, useSendTransaction, useWriteContract } from 'wagmi';
import { erc20Abi } from 'viem';
import { JobsAIAPI, queryClient, readSession, robinhood, sessionKey, walletConfig } from './wallet-config.jsx';
import './wallet-app.css';

function InformationDialog({ info, onClose }) {
  const titleId = useId();
  if (!info) return null;
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <span className="workspace-modal-symbol" aria-hidden="true">i</span>
    <h2 id={titleId}>{info.title}</h2>
    {info.paragraphs?.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    {info.items?.length > 0 && <><h3>{info.itemsLabel || 'Details'}</h3><ul>{info.items.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    {info.code && <><h3>{info.codeLabel || 'Reference'}</h3><code>{info.code}</code></>}
    <button className="pill primary" onClick={onClose}>Got it</button>
  </section></div>;
}

function WorkflowDialog({ dialog, onClose, onSubmit, busy }) {
  if (!dialog) return null;
  const { mode, job } = dialog;
  if (mode === 'submit' || mode === 'revision' || mode === 'dispute') {
    const isSubmit = mode === 'submit';
    const title = isSubmit ? 'Submit your work' : mode === 'revision' ? 'Request a revision' : 'Open a dispute';
    return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
      <span className="workspace-modal-symbol" aria-hidden="true">{isSubmit ? '↗' : 'i'}</span><h2 id="workflow-dialog-title">{title}</h2><p>{job.title}</p>
      <form onSubmit={onSubmit}>
        {isSubmit ? <><label>Work summary<textarea name="summary" required maxLength="10000" rows="3" /></label><label>Deliverable details or link<textarea name="deliverable" required maxLength="100000" rows="4" /></label><label>Evidence links, one per line (optional)<textarea name="evidence" rows="2" /></label></> : <label>{mode === 'revision' ? 'What needs to change?' : 'Describe the dispute'}<textarea name="message" required maxLength="10000" rows="5" /></label>}
        <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={onClose} disabled={busy}>Cancel</button><button className="pill primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : isSubmit ? 'Submit work' : mode === 'revision' ? 'Send revision request' : 'Open dispute'}</button></div>
      </form>
    </section></div>;
  }
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
    <span className="workspace-modal-symbol" aria-hidden="true">i</span><h2 id="workflow-dialog-title">{job.title}</h2><p>{job.amount} {job.asset} · {job.status.replaceAll('_', ' ')}</p><p>{job.description}</p>{job.acceptanceCriteria?.length > 0 && <><h3>Acceptance criteria</h3><ul>{job.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    {dialog.submissions?.map(item => <article className="submission-history-item" key={item.id}><h3>Submission {item.revision}</h3><p><strong>Summary</strong><br />{item.summary}</p><p><strong>Deliverable</strong><br />{item.deliverable}</p>{item.evidence?.length > 0 && <ul>{item.evidence.map(link => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></li>)}</ul>}</article>)}
    {dialog.revisions?.length > 0 && <><h3>Revision requests</h3>{dialog.revisions.map(item => <p className="submission-revision" key={item.id}>Revision {item.revision}: {item.feedback}</p>)}</>}
    {dialog.submissions?.length === 0 && <p>No submissions have been recorded yet.</p>}
    <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={onClose}>Close</button>{job.clientWallet?.toLowerCase() === dialog.walletAddress?.toLowerCase() && job.status === 'submitted' && <><button type="button" className="pill outline" onClick={() => dialog.onRequestRevision(job)}>Request revision</button><button type="button" className="pill primary" onClick={() => dialog.onAccept(job)}>Accept and release payment</button></>}</div>
  </section></div>;
}

function MyWork({ session, walletAddress }) {
  const [jobs, setJobs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [dialog, setDialog] = useState(null);

  async function refresh(showLoading = true) {
    if (showLoading) setFeedback({ title: 'Refreshing your work', message: 'Loading jobs connected to this wallet…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.myJobs(session.token);
      const ownJobs = (Array.isArray(response?.data) ? response.data : []).filter(job => !['awaiting_funding', 'ready'].includes(job.status) && (job.clientWallet?.toLowerCase() === walletAddress?.toLowerCase() || job.doerWallet?.toLowerCase() === walletAddress?.toLowerCase()));
      setJobs(ownJobs);
      setLoaded(true);
      if (showLoading) setFeedback(ownJobs.length ? null : { title: 'No jobs to manage yet', message: 'Jobs you create or claim will appear here. A claimed job can be unclaimed before submitting any work.', kind: 'info' });
    } catch (error) {
      setLoaded(true);
      setFeedback({ title: 'Could not load your work', message: error.message || 'JobsAI could not retrieve jobs for this wallet.', kind: 'error' });
    }
  }

  useEffect(() => { if (!loaded) refresh(false); }, [loaded, session.token, walletAddress]);
  useEffect(() => {
    const onWorkUpdated = () => refresh(false);
    document.addEventListener('jobsai:work-updated', onWorkUpdated);
    return () => document.removeEventListener('jobsai:work-updated', onWorkUpdated);
  }, [session.token, walletAddress]);

  async function doAction(title, message, action, successTitle, successMessage) {
    setBusy(true);
    setDialog(null);
    setFeedback({ title, message, kind: 'loading' });
    try {
      await action();
      setDialog(null);
      await refresh(false);
      setFeedback({ title: successTitle, message: successMessage, kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Action could not be completed', message: error.message || 'JobsAI could not complete this action.', kind: 'error' });
    } finally { setBusy(false); }
  }

  async function unclaim(job) {
    await doAction('Unclaiming job', 'Releasing this job back to the funded work board…', () => JobsAIAPI.unclaim(job.id, session.token), 'Job unclaimed', 'This job is back on the funded work board and can be claimed by another worker.');
  }

  async function openReview(job) {
    setFeedback({ title: 'Loading job history', message: 'Retrieving submissions and revision requests…', kind: 'loading' });
    try {
      const [submissionResponse, revisionResponse] = await Promise.all([JobsAIAPI.submissions(job.id, session.token), JobsAIAPI.revisions(job.id, session.token)]);
      setFeedback(null);
      setDialog({ mode: 'review', job, submissions: submissionResponse?.data || [], revisions: revisionResponse?.data || [], walletAddress, onRequestRevision: item => setDialog({ mode: 'revision', job: item }), onAccept: item => accept(item) });
    } catch (error) { setFeedback({ title: 'Could not load job history', message: error.message || 'JobsAI could not retrieve this job’s history.', kind: 'error' }); }
  }

  async function accept(job) {
    await doAction('Accepting the submission', 'JobsAI is starting escrow payment to the worker…', () => JobsAIAPI.acceptWork(job.id, session.token), 'Submission accepted', 'The acceptance was recorded and escrow release is processing.');
  }

  function submitDialog(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const job = dialog.job;
    if (dialog.mode === 'submit') {
      const evidence = String(form.get('evidence') || '').split('\n').map(value => value.trim()).filter(Boolean);
      void doAction('Submitting your work', 'Saving this submission to the job history…', () => JobsAIAPI.submitWork(job.id, { summary: form.get('summary'), deliverable: form.get('deliverable'), evidence }, session.token), 'Work submitted', 'Your submission is saved. The client can review it and accept it or request a revision.');
    } else if (dialog.mode === 'revision') {
      void doAction('Sending revision request', 'Adding the requested changes to the job history…', () => JobsAIAPI.requestRevision(job.id, form.get('message'), session.token), 'Revision requested', 'The worker can now submit another version. Earlier submissions remain in the job history.');
    } else {
      void doAction('Opening dispute', 'Locking the job while the team reviews its history…', () => JobsAIAPI.openDispute(job.id, form.get('message'), session.token), 'Dispute opened', 'The job is locked pending team review.');
    }
  }

  const statusLabels = { in_progress: 'In progress', revision_requested: 'Revision requested', submitted: 'Submitted', disputed: 'Disputed', settlement_pending: 'Settlement pending', completed: 'Completed', refunded: 'Refunded' };
  return <section className="my-work-section" aria-labelledby="my-work-title">
    <div className="my-work-heading"><div><span className="eyebrow">CLAIMED AND CREATED JOBS</span><h2 id="my-work-title">My work</h2></div><button className="pill outline" onClick={() => refresh()} disabled={busy}>Refresh</button></div>
    <div className="my-work-list">{jobs.map(job => {
      const isDoer = job.doerWallet?.toLowerCase() === walletAddress?.toLowerCase();
      const isClient = job.clientWallet?.toLowerCase() === walletAddress?.toLowerCase();
      const canSubmit = isDoer && ['in_progress', 'revision_requested'].includes(job.status);
      const canDispute = ['in_progress', 'revision_requested', 'submitted'].includes(job.status) && (isDoer || isClient);
      return <article className="my-work-card" key={job.id}><div className="my-work-summary"><div><h3>{job.title}</h3><span className="my-work-status">{statusLabels[job.status] || job.status.replaceAll('_', ' ')}</span></div><strong>{job.amount} {job.asset}</strong></div><div className="my-work-actions">
        <button className="pill outline" onClick={() => openReview(job)}>View job history</button>
        {canSubmit && <button className="pill primary" onClick={() => setDialog({ mode: 'submit', job })}>Submit work</button>}
        {isDoer && job.status === 'in_progress' && <button className="pill outline" disabled={busy} onClick={() => unclaim(job)}>Unclaim job</button>}
        {canDispute && <button className="pill outline" onClick={() => setDialog({ mode: 'dispute', job })}>Open dispute</button>}
      </div></article>;
    })}</div>
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="my-work-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="my-work-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <WorkflowDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={submitDialog} busy={busy} />
  </section>;
}

function goToAuth() {
  const next = `workspace.html${location.search}`;
  location.replace(`auth.html?next=${encodeURIComponent(next)}`);
}

function FundedJobs({ session }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState({ title: 'Loading funded jobs', message: 'Checking for currently funded work…', kind: 'loading' });
  const [jobInfo, setJobInfo] = useState(null);

  async function refresh() {
    setFeedback({ title: 'Loading funded jobs', message: 'Checking for currently funded work…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.readyJobs();
      const ready = Array.isArray(response?.data) ? response.data : [];
      setJobs(ready);
      setFeedback(ready.length ? null : { title: 'No funded jobs are ready', message: 'Check again later or refresh to look for newly funded work.', kind: 'info' });
    } catch (error) { setJobs([]); setFeedback({ title: 'Could not load funded jobs', message: error.message || 'JobsAI could not load funded jobs.', kind: 'error' }); }
  }

  useEffect(() => { refresh(); }, []);

  async function claim(job) {
    setBusy(job.id);
    setFeedback({ title: 'Claiming job', message: 'Assigning this job to your wallet…', kind: 'loading' });
    try {
      await JobsAIAPI.claim(job.id, session.token);
      setJobs(current => current.filter(item => item.id !== job.id));
      document.dispatchEvent(new Event('jobsai:work-updated'));
      setFeedback({ title: 'Job claimed', message: 'This job is now assigned to your wallet.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not claim job', message: error.message || 'The job could not be claimed.', kind: 'error' }); }
    finally { setBusy(''); }
  }

  return <>
    <div className="live-jobs-heading">
      <div><span className="eyebrow">LIVE · FUNDED ONCHAIN</span><h2 id="live-jobs-title">Jobs ready to claim</h2><button className="text-info-button" onClick={() => setJobInfo({ title: 'Review a funded job', paragraphs: ['Open job details to read the scope, acceptance criteria, listed asset, and deadline before claiming. Claiming assigns the work to you and does not move funds.'] })}>How funded work works</button></div>
      <button className="pill outline" onClick={refresh} disabled={!!busy}>Refresh</button>
    </div>
    <div className="live-jobs-list">{jobs.map(job => <article className="live-job-card" key={job.id}>
      <div className="live-job-top"><h3>{job.title}</h3><strong className="live-job-amount">{job.amount} {job.asset}</strong></div>
      <div className="live-job-actions"><button className="pill outline" onClick={() => setJobInfo({ title: job.title, paragraphs: [job.description, job.deadlineAt && !Number.isNaN(new Date(job.deadlineAt).valueOf()) ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided'], itemsLabel: 'Acceptance criteria', items: job.acceptanceCriteria || [] })}>View details</button><button className="pill primary live-job-claim" disabled={!!busy} onClick={() => claim(job)}>Claim job</button></div>
    </article>)}</div>
    {feedback && <div className="workspace-overlay" role="presentation"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="workspace-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <InformationDialog info={jobInfo} onClose={() => setJobInfo(null)} />
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
  const [jobInfo, setJobInfo] = useState(null);
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
      if (showLoading) setFeedback(ownJobs.length ? null : { title: 'No jobs created yet', message: 'Your jobs will appear here after you create one.', kind: 'info' });
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
    const invalidField = event.currentTarget.querySelector(':invalid');
    if (invalidField) {
      invalidField.focus();
      setFeedback({ title: 'Check the job details', message: 'Complete the required fields using the formats shown before creating this job.', kind: 'error' });
      return;
    }
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
    setFeedback({ title: 'Confirm funding in your wallet', message: `Review and approve the transaction in your wallet. Exactly ${job.amount} ${job.asset} will be deducted from your wallet and transferred to this job’s escrow address. Once the deposit is confirmed and verified, the job will be listed for workers to claim.`, kind: 'loading' });
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
    <form className="create-job-form" noValidate onSubmit={createJob}>
      <div className="create-job-form-heading"><span className="eyebrow">JOB DETAILS</span><h2>Describe the work.</h2><button type="button" className="text-info-button" onClick={() => setJobInfo({ title: 'Write a clear job brief', paragraphs: ['Describe the task and expected output. Add acceptance criteria that make completion easy to review. You can set an optional deadline. Creating a job does not move funds; funding is a separate wallet approval.'] })}>Writing a clear brief</button></div>
      <label>Job title<input required minLength="3" maxLength="160" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Description<textarea required maxLength="20000" rows="5" value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className="criteria-field"><div className="criteria-field-header"><label htmlFor="job-acceptance-criteria">Acceptance criteria</label><button type="button" className="inline-info-button" onClick={() => setJobInfo({ title: 'Acceptance criteria', paragraphs: ['Enter one clear condition per line. For example: “Works on mobile and desktop” or “Include the source files.” The worker and client use these conditions to review each submission and revision.'] })}>How to write criteria</button></div><textarea id="job-acceptance-criteria" required rows="4" value={criteria} onChange={event => setCriteria(event.target.value)} /></div>
      <div className="create-job-payment-row"><label>Payment asset<select value={asset} onChange={event => setAsset(event.target.value)}><option value="eth">ETH</option><option value="usdg">USDG</option></select></label><label>Amount<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?" value={amount} onChange={event => setAmount(event.target.value)} /></label></div>
      <label>Deadline<input type="datetime-local" value={deadlineAt} onChange={event => setDeadlineAt(event.target.value)} /></label>
      <button className="pill primary" type="submit" disabled={saving}>Create job</button>
    </form>
    <section className="created-jobs-card" aria-labelledby="created-jobs-title"><div className="created-jobs-heading"><div><span className="eyebrow">YOUR JOBS</span><h2 id="created-jobs-title">Created jobs</h2></div><button className="pill outline" onClick={() => loadJobs()} disabled={saving}>Refresh</button></div>
      <div className="created-jobs-list">{jobs.map(job => <article className="created-job-item" key={job.id}><div className="created-job-summary"><h3>{job.title}</h3><strong>{job.amount} {job.asset}</strong></div>
        <div className="created-job-actions"><button className="pill outline" onClick={() => setJobInfo({ title: job.title, paragraphs: [`Status: ${job.status.replaceAll('_', ' ')}.`, job.description, job.deadlineAt ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided.', ...(job.pendingFundingHash ? ['A transfer was sent. Verify it to publish the job; do not send funds again.'] : [])], itemsLabel: 'Acceptance criteria', items: job.acceptanceCriteria || [], code: job.status === 'awaiting_funding' ? job.escrowAddress : undefined, codeLabel: 'Escrow address' })}>View details</button>
          {job.status === 'awaiting_funding' && <button className="pill primary" onClick={() => fundJob(job)} disabled={saving}>{job.pendingFundingHash ? 'Verify deposit' : 'Fund job'}</button>}
        </div>
      </article>)}</div>
    </section>
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="create-job-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="create-job-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <InformationDialog info={jobInfo} onClose={() => setJobInfo(null)} />
  </div>;
}

function WorkspaceContext() {
  const { address, chainId, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session, setSession] = useState(readSession);
  const header = document.getElementById('wallet-header-root');
  const jobsRoot = document.getElementById('live-jobs-root');
  const workRoot = document.getElementById('work-management-root');
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

  if (!header || !jobsRoot || !workRoot || !createJobRoot || !session?.token) return null;
  return <>
    {createPortal(<><ConnectButton.Custom>{({ account, openAccountModal, mounted }) => <button className="workspace-account-button" onClick={openAccountModal} disabled={!mounted || !account} aria-label={`Connected wallet ${account?.displayName || ''}`}><span className="workspace-account-status" />{account?.displayName || 'Connected wallet'}</button>}</ConnectButton.Custom><button className="workspace-signout" onClick={signOut}>Sign out</button></>, header)}
    {createPortal(<FundedJobs session={session} />, jobsRoot)}
    {createPortal(<MyWork session={session} walletAddress={address} />, workRoot)}
    {createPortal(<CreateJobPanel session={session} walletAddress={address} chainId={chainId} />, createJobRoot)}
  </>;
}

createRoot(document.getElementById('workspace-wallet-context')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><WorkspaceContext /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
