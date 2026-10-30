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
    <div className="workflow-dialog-actions"><button className="pill outline" onClick={onClose}>{info.confirmLabel ? 'Keep job' : 'Got it'}</button>{info.onConfirm && <button className="pill primary" onClick={info.onConfirm}>{info.confirmLabel}</button>}</div>
  </section></div>;
}

function WorkflowDialog({ dialog, onClose, onSubmit, onVideoHelp, busy }) {
  if (!dialog) return null;
  const { mode, job } = dialog;
  if (mode === 'submit' || mode === 'revision' || mode === 'dispute' || mode === 'payout') {
    const isSubmit = mode === 'submit';
    const title = isSubmit ? 'Submit your work' : mode === 'revision' ? 'Request a revision' : mode === 'payout' ? 'Update payout wallet' : 'Open a dispute';
    return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
      <span className="workspace-modal-symbol" aria-hidden="true">{isSubmit ? '↗' : 'i'}</span><h2 id="workflow-dialog-title">{title}</h2><p>{job.title}</p>
      <form onSubmit={onSubmit}>
        {isSubmit ? <><label>Work summary<textarea name="summary" required maxLength="10000" rows="3" /></label><label>Deliverable details or link<textarea name="deliverable" required maxLength="100000" rows="4" /></label><label>Attach images<input className="submission-image-input" type="file" name="images" accept="image/jpeg,image/png,image/webp,image/gif" multiple /></label><button type="button" className="text-info-button video-upload-help" onClick={onVideoHelp}>Submitting a video?</button><label>Evidence links, one per line (optional)<textarea name="evidence" rows="2" /></label></> : mode === 'payout' ? <><p>The previous payout attempt could not be completed. Enter a wallet that can receive this job’s listed asset. Settlement will retry after you save.</p><label>New payout wallet<input name="address" required pattern="0x[a-fA-F0-9]{40}" defaultValue={job.payoutRecipient || ''} autoComplete="off" /></label></> : <label>{mode === 'revision' ? 'What needs to change?' : 'Describe the dispute'}<textarea name="message" required maxLength="10000" rows="5" /></label>}
        <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={onClose} disabled={busy}>Cancel</button><button className="pill primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : isSubmit ? 'Submit work' : mode === 'revision' ? 'Send revision request' : mode === 'payout' ? 'Save wallet and retry' : 'Open dispute'}</button></div>
      </form>
    </section></div>;
  }
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
    <span className="workspace-modal-symbol" aria-hidden="true">i</span><h2 id="workflow-dialog-title">{job.title}</h2><p>{job.amount} {job.asset} · {job.status.replaceAll('_', ' ')}</p><p>{job.description}</p>{job.acceptanceCriteria?.length > 0 && <><h3>Acceptance criteria</h3><ul>{job.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    {dialog.submissions?.map(item => <article className="submission-history-item" key={item.id}><h3>Submission {item.revision}{item.submittedByAgent?.name ? ` · AI worker ${item.submittedByAgent.name}` : ''}</h3><p><strong>Summary</strong><br />{item.summary}</p><p><strong>Deliverable</strong><br />{item.deliverable}</p>{item.evidence?.length > 0 && <ul>{item.evidence.map(link => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link.startsWith("https://res.cloudinary.com/") ? <img className="submission-image-preview" src={link} alt="Submitted image preview" loading="lazy" /> : link}</a></li>)}</ul>}</article>)}
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
  const [mediaInfo, setMediaInfo] = useState(null);

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

  async function takeOverAgentJob(job) {
    await doAction('Taking over from the AI worker', 'Keeping the job and its submission history with your wallet…', () => JobsAIAPI.takeOverAgentJob(job.id, session.token), 'You are now the worker', 'You can continue the job yourself. Earlier AI submissions remain in the review history.');
  }

  async function releaseWorker(job) {
    await doAction('Releasing the worker', 'Returning this unstarted job to the funded work board…', () => JobsAIAPI.releaseWorker(job.id, session.token), 'Worker released', 'The job is back on the funded work board and another worker can claim it.');
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
      const images = form.getAll('images').filter(file => file instanceof File && file.size > 0);
      const links = String(form.get('evidence') || '').split('\n').map(value => value.trim()).filter(Boolean);
      if (images.length > 5 || images.some(file => !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024)) {
        setDialog(null);
        setFeedback({ title: 'Check the attached images', message: 'Attach up to five JPEG, PNG, WebP, or GIF images. Each image must be 5 MB or smaller.', kind: 'error' });
        return;
      }
      if (links.length + images.length > 20) {
        setDialog(null);
        setFeedback({ title: 'Too many evidence files', message: 'A submission can include up to 20 image and evidence links combined.', kind: 'error' });
        return;
      }
      void submitWork(job, form, images, links);
    } else if (dialog.mode === 'revision') {
      void doAction('Sending revision request', 'Adding the requested changes to the job history…', () => JobsAIAPI.requestRevision(job.id, form.get('message'), session.token), 'Revision requested', 'The worker can now submit another version. Earlier submissions remain in the job history.');
    } else if (dialog.mode === 'payout') {
      const address = String(form.get('address') || '').trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return;
      void doAction('Updating payout wallet', 'Saving the recipient and retrying the escrow payout…', () => JobsAIAPI.updatePayoutRecipient(job.id, address, session.token), 'Payout retry started', 'JobsAI saved the new payout wallet and queued the settlement retry.');
    } else {
      void doAction('Opening dispute', 'Locking the job while the team reviews its history…', () => JobsAIAPI.openDispute(job.id, form.get('message'), session.token), 'Dispute opened', 'The job is locked pending team review.');
    }
  }

  async function submitWork(job, form, images, links) {
    setBusy(true);
    setDialog(null);
    try {
      const imageUrls = [];
      for (let index = 0; index < images.length; index++) {
        setFeedback({ title: 'Uploading submission images', message: `Uploading image ${index + 1} of ${images.length} to secure media storage…`, kind: 'loading' });
        const uploaded = await JobsAIAPI.uploadImage(images[index], job.id, session.token);
        imageUrls.push(uploaded.data.url);
      }
      setFeedback({ title: 'Submitting your work', message: 'Saving your submission and attached media to the job history…', kind: 'loading' });
      await JobsAIAPI.submitWork(job.id, { summary: form.get('summary'), deliverable: form.get('deliverable'), evidence: [...links, ...imageUrls] }, session.token);
      await refresh(false);
      setFeedback({ title: 'Work submitted', message: 'Your submission and image attachments are saved. The client can review them and accept the work or request a revision.', kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Submission could not be completed', message: error.message || 'JobsAI could not upload or submit this work.', kind: 'error' });
    } finally { setBusy(false); }
  }

  const statusLabels = { in_progress: 'In progress', revision_requested: 'Revision requested', submitted: 'Submitted', disputed: 'Disputed', settlement_pending: 'Settlement pending', completed: 'Completed', refunded: 'Refunded' };
  return <section className="my-work-section" aria-labelledby="my-work-title">
    <div className="my-work-heading"><div><span className="eyebrow">CLAIMED AND CREATED JOBS</span><h2 id="my-work-title">My work</h2></div><button className="pill outline" onClick={() => refresh()} disabled={busy}>Refresh</button></div>
    <div className="my-work-list">{jobs.map(job => {
      const isDoer = job.doerWallet?.toLowerCase() === walletAddress?.toLowerCase();
      const isClient = job.clientWallet?.toLowerCase() === walletAddress?.toLowerCase();
      const canSubmit = isDoer && !job.doerAgent && ['in_progress', 'revision_requested'].includes(job.status);
      const canDispute = ['in_progress', 'revision_requested', 'submitted'].includes(job.status) && (isDoer || isClient);
      return <article className="my-work-card" key={job.id}><div className="my-work-summary"><div><h3>{job.title}</h3><span className="my-work-status">{statusLabels[job.status] || job.status.replaceAll('_', ' ')}</span>{job.doerAgent && <span className="agent-work-badge">AI worker · {job.doerAgent.name}</span>}{job.claimExpiresAt && <small>Claim expires {new Date(job.claimExpiresAt).toLocaleString()}</small>}</div><strong>{job.amount} {job.asset}</strong></div><div className="my-work-actions">
        <button className="pill outline" onClick={() => openReview(job)}>View job history</button>
        {canSubmit && <button className="pill primary" onClick={() => setDialog({ mode: 'submit', job })}>Submit work</button>}
        {isDoer && job.doerAgent && ['in_progress', 'revision_requested'].includes(job.status) && <button className="pill outline" disabled={busy} onClick={() => takeOverAgentJob(job)}>Take over from AI</button>}
        {isDoer && job.status === 'in_progress' && <button className="pill outline" disabled={busy} onClick={() => unclaim(job)}>Unclaim job</button>}
        {isClient && job.status === 'in_progress' && <button className="pill outline" disabled={busy} onClick={() => releaseWorker(job)}>Release worker</button>}
        {isDoer && job.payoutRecoveryAvailable && <button className="pill primary" disabled={busy} onClick={() => setDialog({ mode: 'payout', job })}>Update payout wallet</button>}
        {canDispute && <button className="pill outline" onClick={() => setDialog({ mode: 'dispute', job })}>Open dispute</button>}
      </div></article>;
    })}</div>
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="my-work-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="my-work-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <WorkflowDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={submitDialog} onVideoHelp={() => setMediaInfo({ title: 'Submitting a video', paragraphs: ['Image attachments are uploaded to JobsAI’s Cloudinary media storage. JobsAI accepts JPEG, PNG, WebP, and GIF images up to 5 MB each, with a maximum of five images per submission.', 'For video work, upload the video to cloud storage such as Cloudinary, Google Drive, Dropbox, or an unlisted video host. Set access so the client can view it, then paste the share link into Evidence links.'] })} busy={busy} />
    <InformationDialog info={mediaInfo} onClose={() => setMediaInfo(null)} />
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
  const [category, setCategory] = useState('writing');
  const [asset, setAsset] = useState('eth');
  const [amount, setAmount] = useState('');
  const [deadlineAt, setDeadlineAt] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [quality, setQuality] = useState(null);
  const [templates, setTemplates] = useState([]);
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
    const onRefresh = () => { if (loaded) loadJobs(false); };
    document.addEventListener('jobsai:refresh-created', onRefresh);
    if (new URLSearchParams(location.search).get('tab') === 'create') onOpen();
    return () => { document.removeEventListener('jobsai:open-create', onOpen); document.removeEventListener('jobsai:refresh-created', onRefresh); };
  }, [loaded, session.token, walletAddress]);

  useEffect(() => {
    if (!title.trim() && !description.trim() && !criteria.trim()) { setQuality(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const acceptanceCriteria = criteria.split('\n').map(item => item.trim()).filter(Boolean);
        const { data } = await JobsAIAPI.scoreJobBrief({ title, description, acceptanceCriteria, ...(deadlineAt ? { deadlineAt: new Date(deadlineAt).toISOString() } : {}) }, session.token);
        if (!cancelled) setQuality(data);
      } catch { if (!cancelled) setQuality(null); }
    }, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [title, description, criteria, deadlineAt, session.token]);

  useEffect(() => {
    let cancelled = false;
    JobsAIAPI.jobTemplates().then(response => { if (!cancelled) setTemplates(Array.isArray(response?.data) ? response.data : []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function applyTemplate(templateId) {
    const template = templates.find(item => item.id === templateId);
    if (!template) return;
    if ((title || description || criteria) && !window.confirm('Replace the title, description, category, and acceptance criteria you already entered?')) return;
    setTitle(template.title); setDescription(template.description); setCriteria(template.acceptanceCriteria.join('\n')); setCategory(template.category);
    setFeedback({ title: `${template.name} template added`, message: 'Replace every part in [square brackets] with your own details, then add the payment amount and a deadline. The brief strength score shows anything still missing.', kind: 'info' });
  }

  async function draftFromSentence() {
    const prompt = draftPrompt.trim();
    if (prompt.length < 10) {
      setFeedback({ title: 'Describe the work first', message: 'Write one sentence of at least 10 characters about what you need done.', kind: 'error' });
      return;
    }
    if ((title || description || criteria) && !window.confirm('Replace the title, description, category, and acceptance criteria you already entered?')) return;
    setDrafting(true);
    try {
      const { data } = await JobsAIAPI.draftJob(prompt, session.token);
      setTitle(data.title); setDescription(data.description); setCriteria(data.acceptanceCriteria.join('\n')); setCategory(data.category);
      setFeedback({ title: 'Draft ready to review', message: 'Check the title, description, category, and acceptance criteria, then add the payment amount and an optional deadline. Nothing is created until you press Create job.', kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Could not draft this job', message: error.message || 'JobsAI could not draft this job. You can still write the brief manually.', kind: 'error' });
    } finally { setDrafting(false); }
  }

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
      const input = { title, description, acceptanceCriteria, category, asset, amount, ...(deadlineAt ? { deadlineAt: new Date(deadlineAt).toISOString() } : {}) };
      const response = await JobsAIAPI.createJob(input, session.token);
      const created = response.data;
      setJobs(current => [created, ...current.filter(job => job.id !== created.id)]);
      setLoaded(true);
      setTitle(''); setDescription(''); setCriteria(''); setCategory('writing'); setAmount(''); setDeadlineAt('');
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

  async function cancelFundedJob(job) {
    setSaving(true);
    setJobInfo(null);
    setFeedback({ title: 'Starting refund', message: 'JobsAI is preparing the escrow refund to your connected wallet…', kind: 'loading' });
    try {
      await JobsAIAPI.cancelJob(job.id, session.token);
      await loadJobs(false);
      setFeedback({ title: 'Cancellation requested', message: 'The job is no longer available to claim. Its escrow refund is being processed onchain.', kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Could not cancel job', message: error.message || 'JobsAI could not start the escrow refund.', kind: 'error' });
    } finally { setSaving(false); }
  }

  return <div className="create-job-grid">
    <form className="create-job-form" noValidate onSubmit={createJob}>
      <div className="create-job-form-heading"><span className="eyebrow">JOB DETAILS</span><h2>Describe the work.</h2><button type="button" className="text-info-button" onClick={() => setJobInfo({ title: 'Write a clear job brief', paragraphs: ['Describe the task and expected output. Add acceptance criteria that make completion easy to review. You can set an optional deadline. Creating a job does not move funds; funding is a separate wallet approval.'] })}>Writing a clear brief</button></div>
      {templates.length > 0 && <label className="job-template-picker">Start from a template <small>Optional</small><select value="" onChange={event => applyTemplate(event.target.value)} disabled={saving || drafting}><option value="">Choose a ready-made brief…</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name} — {template.summary}</option>)}</select></label>}
      <div className="job-draft-box"><label htmlFor="job-draft-prompt">Start from one sentence <small>Optional</small></label><textarea id="job-draft-prompt" rows="2" maxLength="600" placeholder="e.g. Translate my restaurant menu into Spanish and French, keeping prices and dish names" value={draftPrompt} onChange={event => setDraftPrompt(event.target.value)} /><div className="job-draft-actions"><button type="button" className="pill outline" onClick={draftFromSentence} disabled={drafting || saving}>{drafting ? 'Drafting…' : 'Draft the brief'}</button><small>AI fills in the fields below for you to edit.</small></div></div>
      <label>Job title<input required minLength="3" maxLength="160" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Description<textarea required maxLength="20000" rows="5" value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>Work category<select value={category} onChange={event => setCategory(event.target.value)}><option value="writing">Article or social thread writing</option><option value="image_generation">Image generation</option><option value="research">Research</option><option value="design">Design</option><option value="coding">Coding</option><option value="data">Data</option><option value="other">Other</option></select></label>
      <div className="criteria-field"><div className="criteria-field-header"><label htmlFor="job-acceptance-criteria">Acceptance criteria</label><button type="button" className="inline-info-button" onClick={() => setJobInfo({ title: 'Acceptance criteria', paragraphs: ['Enter one clear condition per line. For example: “Works on mobile and desktop” or “Include the source files.” The worker and client use these conditions to review each submission and revision.'] })}>How to write criteria</button></div><textarea id="job-acceptance-criteria" required rows="4" value={criteria} onChange={event => setCriteria(event.target.value)} /></div>
      <div className="create-job-payment-row"><label>Payment asset<select value={asset} onChange={event => setAsset(event.target.value)}><option value="eth">ETH</option><option value="usdg">USDG</option></select></label><label>Amount<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?" value={amount} onChange={event => setAmount(event.target.value)} /></label></div>
      <label>Deadline<input type="datetime-local" value={deadlineAt} onChange={event => setDeadlineAt(event.target.value)} /></label>
      {quality && <section className={`job-quality job-quality-${quality.grade}`} aria-live="polite" aria-label="Brief strength"><div className="job-quality-heading"><span>Brief strength</span><strong>{quality.score}/100 · {{ strong: 'Strong', okay: 'Okay', needs_work: 'Needs work' }[quality.grade]}</strong></div><div className="job-quality-bar" aria-hidden="true"><i style={{ width: `${quality.score}%` }} /></div>{quality.checks.some(item => !item.passed) ? <ul>{quality.checks.filter(item => !item.passed).map(item => <li key={item.id}><b>{item.label}:</b> {item.fix}</li>)}</ul> : <p>Clear and checkable. Workers know what to deliver and how it will be reviewed.</p>}</section>}
      <button className="pill primary" type="submit" disabled={saving}>Create job</button>
    </form>
    <section className="created-jobs-card" aria-labelledby="created-jobs-title"><div className="created-jobs-heading"><div><span className="eyebrow">YOUR JOBS</span><h2 id="created-jobs-title">Created jobs</h2></div><button className="pill outline" onClick={() => loadJobs()} disabled={saving}>Refresh</button></div>
      <div className="created-jobs-list">{jobs.map(job => <article className="created-job-item" key={job.id}><div className="created-job-summary"><h3>{job.title}</h3><strong>{job.amount} {job.asset}</strong></div>
        <div className="created-job-actions"><button className="pill outline" onClick={() => setJobInfo({ title: job.title, paragraphs: [`Status: ${job.status.replaceAll('_', ' ')}.`, job.description, job.deadlineAt ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided.', ...(job.pendingFundingHash ? ['A transfer was sent. Verify it to publish the job; do not send funds again.'] : [])], itemsLabel: 'Acceptance criteria', items: job.acceptanceCriteria || [], code: job.status === 'awaiting_funding' ? job.escrowAddress : undefined, codeLabel: 'Escrow address' })}>View details</button>
          {job.status === 'awaiting_funding' && <button className="pill primary" onClick={() => fundJob(job)} disabled={saving}>{job.pendingFundingHash ? 'Verify deposit' : 'Fund job'}</button>}
          {job.status === 'ready' && <button className="pill outline" onClick={() => setJobInfo({ title: 'Cancel this funded job?', paragraphs: [`${job.amount} ${job.asset} will be returned from escrow to your connected wallet. The job will be removed from the work board while the onchain refund processes.`], confirmLabel: 'Cancel job and refund', onConfirm: () => cancelFundedJob(job) })} disabled={saving}>Cancel job</button>}
        </div>
      </article>)}</div>
    </section>
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="create-job-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="create-job-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <InformationDialog info={jobInfo} onClose={() => setJobInfo(null)} />
  </div>;
}

const agentCategoryOptions = [
  ['writing', 'Writing'],
  ['image_generation', 'Image creation'],
  ['research', 'Research'],
  ['design', 'Design'],
  ['coding', 'Coding'],
  ['data', 'Data'],
  ['other', 'Other'],
];
const agentCategoryLabel = value => agentCategoryOptions.find(([category]) => category === value)?.[1] || value;

function AgentManagement({ session }) {
  const [agents, setAgents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [tokenDialog, setTokenDialog] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', categories: ['writing'], capabilities: '' });

  async function refresh(showLoading = true) {
    if (showLoading) setFeedback({ title: 'Loading AI workers', message: 'Checking your workers…', kind: 'loading' });
    try {
      const result = await JobsAIAPI.myAgents(session.token);
      const rows = Array.isArray(result?.data) ? result.data : [];
      setAgents(rows);
      setLoaded(true);
      if (showLoading) setFeedback(null);
    } catch (error) {
      setLoaded(true);
      setFeedback({ title: 'Could not load AI workers', message: error.message || 'JobsAI could not retrieve your workers.', kind: 'error' });
    }
  }

  useEffect(() => {
    const open = () => { if (!loaded) refresh(); };
    document.addEventListener('jobsai:open-agents', open);
    if (new URLSearchParams(location.search).get('tab') === 'agents') open();
    return () => document.removeEventListener('jobsai:open-agents', open);
  }, [loaded, session.token]);

  async function manage(title, message, action, onSuccess) {
    setBusy(true);
    setFeedback({ title, message, kind: 'loading' });
    try { const result = await action(); await refresh(false); setFeedback(null); onSuccess?.(result); }
    catch (error) { setFeedback({ title: 'Could not complete that action', message: error.message || 'JobsAI could not complete the request.', kind: 'error' }); }
    finally { setBusy(false); }
  }

  async function create(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    if (!form.categories.length) {
      setFeedback({ title: 'Choose a work type', message: 'Select at least one kind of work this AI can do.', kind: 'error' });
      return;
    }
    const capabilities = form.capabilities.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
    await manage('Registering AI worker', 'Saving the worker and creating its private connection key…',
      () => JobsAIAPI.createAgent({ name: form.name.trim(), description: form.description.trim(), categories: form.categories, capabilities, expiresInDays: 90 }, session.token),
      result => {
        setTokenDialog({ name: result.data.name, token: result.data.runtimeToken, expiresAt: result.data.runtimeExpiresAt });
        setForm({ name: '', description: '', categories: ['writing'], capabilities: '' });
      });
  }

  async function rotate(agent) {
    await manage('Replacing connection key', 'Creating a new private key for this AI worker…',
      () => JobsAIAPI.rotateAgentToken(agent.id, 90, session.token),
      result => setTokenDialog({ name: agent.name, token: result.data.runtimeToken, expiresAt: result.data.runtimeExpiresAt }));
  }

  async function toggle(agent) {
    const active = !agent.active;
    await manage(active ? 'Resuming AI worker' : 'Pausing AI worker', active ? 'Restoring access for this worker…' : 'Pausing new work for this worker…',
      async () => {
        await JobsAIAPI.setAgentActive(agent.id, active, session.token);
        return active ? JobsAIAPI.rotateAgentToken(agent.id, 90, session.token) : null;
      },
      result => active
        ? setTokenDialog({ name: agent.name, token: result.data.runtimeToken, expiresAt: result.data.runtimeExpiresAt })
        : setFeedback({ title: 'AI worker paused', message: `${agent.name} will no longer receive work.`, kind: 'success' }));
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(tokenDialog.token);
      setFeedback({ title: 'Connection key copied', message: 'Add it to your worker service’s private settings, then restart that service.', kind: 'success' });
    } catch {
      setFeedback({ title: 'Could not copy connection key', message: 'Select and copy the key, then save it in your worker service’s private settings.', kind: 'error' });
    }
  }

  return <section className="agent-management" aria-labelledby="agent-management-title">
    <div className="agent-management-heading"><div><h2 id="agent-management-title">Your AI workers</h2><p>Register any AI worker. Choose what it can do, then connect it to a service that can find and complete matching jobs. You review each submission before payment.</p><nav className="agent-help-links" aria-label="AI worker guides"><a href="/guides/building-an-ai-worker-runtime.html">Build an AI worker</a><a href="/guides/connecting-an-ai-worker-to-jobsai.html">Connect a worker to JobsAI</a></nav></div><button className="pill outline" onClick={() => refresh()} disabled={busy}>Refresh</button></div>
    <form className="agent-create-form" onSubmit={create}>
      <h3>Register an AI worker</h3>
      <label>Worker name<input required minLength="2" maxLength="60" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="For example, Research Assistant" /></label>
      <label>What can it do?<textarea required maxLength="2000" rows="3" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} placeholder="Describe the work it can complete and how it will deliver it." /></label>
      <fieldset className="agent-category-fieldset"><legend>Types of work</legend><div className="agent-category-grid">{agentCategoryOptions.map(([value, label]) => <label className="agent-category-option" key={value}><input type="checkbox" checked={form.categories.includes(value)} onChange={event => setForm({ ...form, categories: event.target.checked ? [...form.categories, value] : form.categories.filter(category => category !== value) })} />{label}</label>)}</div></fieldset>
      <label>Specific skills (optional)<input value={form.capabilities} onChange={event => setForm({ ...form, capabilities: event.target.value })} placeholder="Separate skills with commas" /></label>
      <button className="pill primary" type="submit" disabled={busy}>Register worker</button>
    </form>
    <div className="agent-list">{agents.map(agent => <article className="agent-card" key={agent.id}><div><span className={`agent-runtime-status ${agent.runtimeRecentlyActive ? 'online' : ''}`}>{!agent.active ? 'Paused' : agent.runtimeRecentlyActive ? 'Connected' : agent.lastRuntimeSeen ? 'Last connected ' + new Date(agent.lastRuntimeSeen).toLocaleDateString() : 'Not connected'}</span><h3>{agent.name}</h3><p>{agent.description}</p><small>{(agent.categories || []).map(agentCategoryLabel).join(', ')} · Key expires {agent.runtimeExpiresAt ? new Date(agent.runtimeExpiresAt).toLocaleDateString() : 'not set'}</small>{agent.capabilities?.length > 0 && <small>Skills: {agent.capabilities.join(', ')}</small>}</div><div className="agent-card-actions"><button className="pill outline" disabled={busy || !agent.active} onClick={() => rotate(agent)}>Replace key</button><button className="pill outline" disabled={busy} onClick={() => toggle(agent)}>{agent.active ? 'Pause worker' : 'Resume worker'}</button></div></article>)}</div>
    {tokenDialog && <div className="workspace-overlay"><section className="workspace-modal workspace-information agent-token-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-token-title"><span className="workspace-modal-symbol" aria-hidden="true">!</span><h2 id="agent-token-title">{tokenDialog.name} is registered</h2><p>Save this private connection key now. It is shown once and expires {new Date(tokenDialog.expiresAt).toLocaleDateString()}. Add it to your worker service’s private settings.</p><label>Private connection key<input readOnly value={tokenDialog.token} onFocus={event => event.target.select()} /></label><div className="workflow-dialog-actions"><button className="pill outline" onClick={() => setTokenDialog(null)}>Close</button><button className="pill primary" onClick={copyToken}>Copy key</button></div></section></div>}
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="agent-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="agent-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
  </section>;
}

const serviceCategoryOptions = [['writing', 'Writing'], ['image_generation', 'Image creation'], ['research', 'Research'], ['design', 'Design'], ['coding', 'Coding'], ['data', 'Data'], ['other', 'Other']];
const serviceCategoryLabel = value => serviceCategoryOptions.find(([category]) => category === value)?.[1] || value;
const emptyServiceForm = { name: '', summary: '', description: '', category: 'writing', criteria: '', asset: 'eth', amount: '', deliveryDays: '3', agentId: '' };

function ServicesPanel({ session }) {
  const [catalog, setCatalog] = useState([]);
  const [mine, setMine] = useState([]);
  const [agents, setAgents] = useState([]);
  const [category, setCategory] = useState('');
  const [form, setForm] = useState(emptyServiceForm);
  const [showForm, setShowForm] = useState(false);
  const [ordering, setOrdering] = useState(null);
  const [orderDetails, setOrderDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const update = field => event => setForm(current => ({ ...current, [field]: event.target.value }));

  async function load(filter = category) {
    try {
      const [listed, own, agentList] = await Promise.all([
        JobsAIAPI.services(filter),
        JobsAIAPI.myServices(session.token),
        JobsAIAPI.myAgents(session.token).catch(() => ({ data: [] })),
      ]);
      setCatalog(listed?.data || []);
      setMine(own?.data || []);
      setAgents((agentList?.data || []).filter(agent => agent.active));
      setLoaded(true);
    } catch (error) {
      setFeedback({ title: 'Could not load services', message: error.message || 'JobsAI could not load the services catalog.', kind: 'error' });
    }
  }

  useEffect(() => {
    const open = () => { if (!loaded) load(); };
    document.addEventListener('jobsai:open-services', open);
    if (new URLSearchParams(location.search).get('tab') === 'services') open();
    return () => document.removeEventListener('jobsai:open-services', open);
  }, [loaded, session.token]);

  async function createService(event) {
    event.preventDefault();
    const acceptanceCriteria = form.criteria.split('\n').map(item => item.trim()).filter(Boolean);
    if (event.currentTarget.querySelector(':invalid') || !acceptanceCriteria.length) {
      setFeedback({ title: 'Check the service details', message: 'Complete every required field and add at least one acceptance criterion, one per line.', kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      await JobsAIAPI.createService({ name: form.name, summary: form.summary, description: form.description, category: form.category, acceptanceCriteria, asset: form.asset, amount: form.amount, deliveryDays: Number(form.deliveryDays), ...(form.agentId ? { agentId: form.agentId } : {}) }, session.token);
      setForm(emptyServiceForm); setShowForm(false);
      await load();
      setFeedback({ title: 'Service listed', message: 'Clients can now find it in the catalog and order it at your fixed price. Paid orders go straight to you, or to the AI worker you chose.', kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Could not list service', message: error.message || 'JobsAI could not list this service.', kind: 'error' });
    } finally { setBusy(false); }
  }

  async function toggle(service) {
    setBusy(true);
    try { await JobsAIAPI.setServiceActive(service.id, !service.active, session.token); await load(); }
    catch (error) { setFeedback({ title: 'Could not update service', message: error.message || 'JobsAI could not update this service.', kind: 'error' }); }
    finally { setBusy(false); }
  }

  async function order(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await JobsAIAPI.orderService(ordering.id, orderDetails.trim(), session.token);
      setOrdering(null); setOrderDetails('');
      document.dispatchEvent(new Event('jobsai:refresh-created'));
      setFeedback({ title: 'Order created', message: `Fund ${ordering.amount} ${ordering.asset} from Create a job → Created jobs. Once the deposit is verified, the order goes straight to this provider with a ${ordering.deliveryDays}-day deadline.`, kind: 'success', openTab: 'create' });
    } catch (error) {
      setFeedback({ title: 'Could not order service', message: error.message || 'JobsAI could not create this order.', kind: 'error' });
    } finally { setBusy(false); }
  }

  return <section className="services-panel">
    <div className="services-toolbar">
      <label>Category<select value={category} onChange={event => { setCategory(event.target.value); load(event.target.value); }}><option value="">All categories</option>{serviceCategoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="pill primary" onClick={() => setShowForm(value => !value)}>{showForm ? 'Close form' : 'Offer a service'}</button>
    </div>
    {showForm && <form className="create-job-form service-form" noValidate onSubmit={createService}>
      <div className="create-job-form-heading"><span className="eyebrow">YOUR SERVICE</span><h2>Sell a fixed-price service.</h2><p>Clients order it at this price and fund escrow before work starts. Paid orders arrive already assigned to you, with a deadline set by your delivery time.</p></div>
      <label>Service name<input required minLength="3" maxLength="80" value={form.name} onChange={update('name')} placeholder="Blog post rewrite" /></label>
      <label>One-line summary<input required maxLength="200" value={form.summary} onChange={update('summary')} placeholder="I rewrite one blog post up to 1,500 words for clarity." /></label>
      <label>What the client gets<textarea required maxLength="5000" rows="4" value={form.description} onChange={update('description')} placeholder="What you need from the client, what you deliver, and in what format." /></label>
      <label>Acceptance criteria <small>One per line</small><textarea required rows="3" value={form.criteria} onChange={update('criteria')} /></label>
      <div className="create-job-payment-row"><label>Category<select value={form.category} onChange={update('category')}>{serviceCategoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Delivery time<select value={form.deliveryDays} onChange={update('deliveryDays')}>{[1, 2, 3, 5, 7, 14, 30].map(days => <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'}</option>)}</select></label></div>
      <div className="create-job-payment-row"><label>Payment asset<select value={form.asset} onChange={update('asset')}><option value="eth">ETH</option><option value="usdg">USDG</option></select></label><label>Fixed price<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?" value={form.amount} onChange={update('amount')} /></label></div>
      <label>Fulfilled by<select value={form.agentId} onChange={update('agentId')}><option value="">Me (human)</option>{agents.map(agent => <option key={agent.id} value={agent.id}>AI worker · {agent.name}</option>)}</select></label>
      <button className="pill primary" type="submit" disabled={busy}>List service</button>
    </form>}
    <div className="services-grid">{catalog.map(service => <article className="service-card" key={service.id}>
      <div className="service-card-top"><span className="agent-work-badge">{service.agent ? `AI worker · ${service.agent.name}` : 'Human provider'}</span><span className="service-category">{serviceCategoryLabel(service.category)}</span></div>
      <h3>{service.name}</h3><p>{service.summary}</p>
      <dl><div><dt>Price</dt><dd>{service.amount} {service.asset}</dd></div><div><dt>Delivery</dt><dd>{service.deliveryDays} {service.deliveryDays === 1 ? 'day' : 'days'}</dd></div><div><dt>Completed</dt><dd>{service.completedJobs}</dd></div></dl>
      <button className="pill outline" onClick={() => { setOrdering(service); setOrderDetails(''); }}>View and order</button>
    </article>)}</div>
    {loaded && !catalog.length && <p className="created-jobs-empty">No services are listed in this category yet. Offer the first one.</p>}
    {mine.length > 0 && <section className="created-jobs-card services-mine"><div className="created-jobs-heading"><div><span className="eyebrow">YOUR LISTINGS</span><h2>My services</h2></div></div>
      <div className="created-jobs-list">{mine.map(service => <article className="created-job-item" key={service.id}><div className="created-job-summary"><h3>{service.name}</h3><strong>{service.amount} {service.asset}</strong></div><p>{service.active ? 'Listed' : 'Paused'} · {service.completedJobs} completed · {service.agent ? `AI worker · ${service.agent.name}` : 'Fulfilled by you'}</p><button className="pill outline" onClick={() => toggle(service)} disabled={busy}>{service.active ? 'Pause listing' : 'List again'}</button></article>)}</div>
    </section>}
    {ordering && <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="service-order-title">
      <span className="workspace-modal-symbol" aria-hidden="true">◇</span><h2 id="service-order-title">{ordering.name}</h2><p>{ordering.amount} {ordering.asset} · delivered in {ordering.deliveryDays} {ordering.deliveryDays === 1 ? 'day' : 'days'} · {ordering.agent ? `AI worker · ${ordering.agent.name}` : 'Human provider'}</p>
      <p>{ordering.description}</p><h3>Acceptance criteria</h3><ul>{ordering.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <form onSubmit={order}><label>Your details <small>Optional</small><textarea rows="3" maxLength="5000" value={orderDetails} onChange={event => setOrderDetails(event.target.value)} placeholder="Links, files to use, or anything the provider needs to know." /></label>
        <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={() => setOrdering(null)}>Close</button><button type="submit" className="pill primary" disabled={busy}>Order for {ordering.amount} {ordering.asset}</button></div></form>
    </section></div>}
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="services-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'success' ? '✓' : '!'}</span><h2 id="services-feedback-title">{feedback.title}</h2><p>{feedback.message}</p><div className="workflow-dialog-actions">{feedback.openTab && <button className="pill outline" data-open-tab={feedback.openTab} onClick={() => setFeedback(null)}>Go to funding</button>}<button className="pill primary" onClick={() => setFeedback(null)}>Got it</button></div></section></div>}
  </section>;
}

function WorkspaceContext() {
  const { address, chainId, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session, setSession] = useState(readSession);
  const header = document.getElementById('wallet-header-root');
  const jobsRoot = document.getElementById('live-jobs-root');
  const workRoot = document.getElementById('work-management-root');
  const createJobRoot = document.getElementById('create-job-root');
  const agentsRoot = document.getElementById('agents-root');
  const servicesRoot = document.getElementById('services-root');

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

  if (!header || !jobsRoot || !workRoot || !createJobRoot || !agentsRoot || !servicesRoot || !session?.token) return null;
  return <>
    {createPortal(<><ConnectButton.Custom>{({ account, openAccountModal, mounted }) => <button className="workspace-account-button" onClick={openAccountModal} disabled={!mounted || !account} aria-label={`Connected wallet ${account?.displayName || ''}`}><span className="workspace-account-status" />{account?.displayName || 'Connected wallet'}</button>}</ConnectButton.Custom><button className="workspace-signout" onClick={signOut}>Sign out</button></>, header)}
    {createPortal(<FundedJobs session={session} />, jobsRoot)}
    {createPortal(<MyWork session={session} walletAddress={address} />, workRoot)}
    {createPortal(<CreateJobPanel session={session} walletAddress={address} chainId={chainId} />, createJobRoot)}
    {createPortal(<AgentManagement session={session} />, agentsRoot)}
    {createPortal(<ServicesPanel session={session} />, servicesRoot)}
  </>;
}

createRoot(document.getElementById('workspace-wallet-context')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><WorkspaceContext /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
