import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ConnectButton, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useDisconnect, usePublicClient, useSendTransaction, useWriteContract } from 'wagmi';
import { erc20Abi } from 'viem';
import { JobsAIAPI, queryClient, readSession, robinhood, sessionKey, walletConfig } from './wallet-config.jsx';
import './wallet-app.css';

const WORK_CATEGORY_NAMES = { writing: 'Writing', translation: 'Translation', image_generation: 'Image generation', research: 'Research', design: 'Design', coding: 'Coding', data: 'Data', other: 'Other' };
const workCategoryName = value => WORK_CATEGORY_NAMES[value] || String(value || 'other').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const COUNTRY_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_OPTIONS = COUNTRY_CODES.map(code => COUNTRY_DISPLAY_NAMES.of(code)).filter(Boolean).sort((a, b) => a.localeCompare(b));
const COMMON_TIME_ZONES = ['Africa/Accra', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Pacific/Auckland', 'UTC'];
const TIME_ZONE_OPTIONS = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : COMMON_TIME_ZONES;

function InformationDialog({ info, onClose }) {
  const titleId = useId();
  if (!info) return null;
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <span className="workspace-modal-symbol" aria-hidden="true">i</span>
    <h2 id={titleId}>{info.title}</h2>
    {info.paragraphs?.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    {info.items?.length > 0 && <><h3>{info.itemsLabel || 'Details'}</h3><ul>{info.items.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    {info.code && <><h3>{info.codeLabel || 'Reference'}</h3><code>{info.code}</code></>}
    {info.link && <p><a href={info.link} target="_blank" rel="noreferrer">{info.linkLabel || 'Open document'}</a></p>}
    <div className="workflow-dialog-actions"><button className="pill outline" onClick={onClose}>{info.confirmLabel ? 'Keep job' : 'Got it'}</button>{info.onConfirm && <button className="pill primary" onClick={info.onConfirm}>{info.confirmLabel}</button>}</div>
  </section></div>;
}

function WorkflowDialog({ dialog, onClose, onSubmit, onVideoHelp, busy, userTag }) {
  if (!dialog) return null;
  const { mode, job } = dialog;
  const isClient = job.clientWallet?.toLowerCase() === dialog.walletAddress?.toLowerCase();
  const otherUserTag = isClient ? job.doerUserTag : job.clientUserTag;
  const otherWallet = isClient ? job.doerWallet : job.clientWallet;
  if (mode === 'submit' || mode === 'revision' || mode === 'dispute' || mode === 'payout') {
    const isSubmit = mode === 'submit';
    const title = isSubmit ? 'Submit your work' : mode === 'revision' ? 'Request a revision' : mode === 'payout' ? 'Update payout wallet' : 'Open a dispute';
    return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
      <span className="workspace-modal-symbol" aria-hidden="true">{isSubmit ? '↗' : 'i'}</span><h2 id="workflow-dialog-title">{title}</h2><p>{job.title}</p>{isSubmit && userTag && <p>Submitting as <UserTagLink userTag={userTag} walletAddress={null}>Worker</UserTagLink></p>}
      <form onSubmit={onSubmit}>
        {isSubmit ? <><label>Work summary<textarea name="summary" required maxLength="10000" rows="3" /></label><label>Deliverable details or link<textarea name="deliverable" required maxLength="100000" rows="4" /></label><label>Attach images<input className="submission-image-input" type="file" name="images" accept="image/jpeg,image/png,image/webp,image/gif" multiple /></label><button type="button" className="text-info-button video-upload-help" onClick={onVideoHelp}>Submitting a video?</button><label>Evidence links, one per line (optional)<textarea name="evidence" rows="2" /></label></> : mode === 'payout' ? <><p>The previous payout attempt could not be completed. Enter a wallet that can receive this job’s listed asset. Settlement will retry after you save.</p><label>New payout wallet<input name="address" required pattern="0x[a-fA-F0-9]{40}" defaultValue={job.payoutRecipient || ''} autoComplete="off" /></label></> : <label>{mode === 'revision' ? 'What needs to change?' : 'Describe the dispute'}<textarea name="message" required maxLength="10000" rows="5" /></label>}
        <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={onClose} disabled={busy}>Cancel</button><button className="pill primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : isSubmit ? 'Submit work' : mode === 'revision' ? 'Send revision request' : mode === 'payout' ? 'Save wallet and retry' : 'Open dispute'}</button></div>
      </form>
    </section></div>;
  }
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
    <span className="workspace-modal-symbol" aria-hidden="true">i</span><h2 id="workflow-dialog-title">{job.title}</h2><p>{job.amount} {job.asset} · {job.status.replaceAll('_', ' ')}</p>{otherWallet && <p>With <UserTagLink userTag={otherUserTag} walletAddress={otherWallet} /></p>}<p>{job.description}</p>{job.sourceFileUrl && <p><a href={job.sourceFileUrl} target="_blank" rel="noreferrer">Open source document</a></p>}{job.acceptanceCriteria?.length > 0 && <><h3>Acceptance criteria</h3><ul>{job.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    {dialog.submissions?.map(item => <article className="submission-history-item" key={item.id}><h3>Submission {item.revision}{item.submittedByAgent?.name ? ` · AI worker ${item.submittedByAgent.name}` : ''}</h3><p className="submission-worker-identity">Submitted by <UserTagLink userTag={item.submittedByUserTag} walletAddress={null}>Worker</UserTagLink></p><p><strong>Summary</strong><br />{item.summary}</p><p><strong>Deliverable</strong><br />{item.deliverable}</p>{item.evidence?.length > 0 && <ul>{item.evidence.map(link => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link.startsWith("https://res.cloudinary.com/") ? <img className="submission-image-preview" src={link} alt="Submitted image preview" loading="lazy" /> : link}</a></li>)}</ul>}</article>)}
    {dialog.revisions?.length > 0 && <><h3>Revision requests</h3>{dialog.revisions.map(item => <p className="submission-revision" key={item.id}>Revision {item.revision}: {item.feedback}</p>)}</>}
    {dialog.submissions?.length === 0 && <p>No submissions have been recorded yet.</p>}
    <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={onClose}>Close</button>{job.clientWallet?.toLowerCase() === dialog.walletAddress?.toLowerCase() && job.status === 'submitted' && <><button type="button" className="pill outline" onClick={() => dialog.onRequestRevision(job)}>Request revision</button><button type="button" className="pill primary" onClick={() => dialog.onAccept(job)}>Accept and release payment</button></>}</div>
  </section></div>;
}

function MyWork({ session, walletAddress, userTag }) {
  const [jobs, setJobs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [mediaInfo, setMediaInfo] = useState(null);
  const [selectedStatus, setSelectedStatus] = useState('all');

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

  const statusLabels = { in_progress: 'In progress', revision_requested: 'Revision requested', submitted: 'Awaiting review', disputed: 'In dispute', settlement_pending: 'Pending settlement', completed: 'Completed', refunded: 'Refunded', expired: 'Expired', cancelled: 'Cancelled' };
  const statusFilters = [['all', 'All work'], ['submitted', 'Awaiting review'], ['in_progress', 'In progress'], ['revision_requested', 'Revision requested'], ['disputed', 'In dispute'], ['settlement_pending', 'Pending settlement'], ['completed', 'Completed'], ['refunded', 'Refunded'], ['expired', 'Expired'], ['cancelled', 'Cancelled']];
  const visibleJobs = selectedStatus === 'all' ? jobs : jobs.filter(job => job.status === selectedStatus);
  const activeCount = jobs.filter(job => ['in_progress', 'revision_requested'].includes(job.status)).length;
  const pendingReviewJobs = jobs.filter(job => job.status === 'submitted' && job.clientWallet?.toLowerCase() === walletAddress?.toLowerCase());
  const pendingReviewIds = new Set(pendingReviewJobs.map(job => job.id));
  const listedJobs = visibleJobs.filter(job => selectedStatus !== 'all' || !pendingReviewIds.has(job.id));
  const reviewCount = pendingReviewJobs.length;
  const completedCount = jobs.filter(job => job.status === 'completed').length;
  return <section className="my-work-section" aria-labelledby="my-work-title">
    <div className="my-work-heading"><div><span className="eyebrow">YOUR JOBS, BY STATUS</span><h2 id="my-work-title">My work</h2><p>Choose a status to filter your jobs and see which ones need attention.</p></div><button className="pill outline" onClick={() => refresh()} disabled={busy}>Refresh</button></div>
    <div className="my-work-overview" aria-label="Work status summary"><article><span>Total jobs</span><strong>{jobs.length}</strong></article><article><span>In progress</span><strong>{activeCount}</strong></article><article className={reviewCount ? 'has-pending-review' : ''}><span>Awaiting your review</span><strong>{reviewCount}</strong></article><article><span>Completed</span><strong>{completedCount}</strong></article></div>
    {pendingReviewJobs.length > 0 && selectedStatus === 'all' && <section className="my-work-review-queue" aria-labelledby="my-work-review-title"><div className="my-work-review-heading"><div><span className="eyebrow">CLIENT REVIEW</span><h3 id="my-work-review-title">Submissions waiting for you</h3><p>Review the work, request a revision, or accept it to release payment.</p></div><span className="my-work-review-count">{pendingReviewJobs.length}</span></div><div className="my-work-review-list">{pendingReviewJobs.map(job => <article key={job.id}><div className="my-work-review-summary"><span className="my-work-category-tag">{workCategoryName(job.category)}</span><h4>{job.title}</h4><p>From <UserTagLink userTag={job.doerUserTag} walletAddress={job.doerWallet} /> · {job.amount} {job.asset}{job.submittedAt ? ` · Submitted ${new Date(job.submittedAt).toLocaleDateString()}` : ''}</p></div><button className="pill primary" onClick={() => openReview(job)}>Review submission</button></article>)}</div></section>}
    <div className="my-work-category-section"><div className="my-work-section-title"><h3>Status</h3><span>Click a status to filter</span></div>
      <div className="my-work-category-grid" role="group" aria-label="Filter work by status">
        {statusFilters.map(([key, label]) => {
          const count = key === 'all' ? jobs.length : jobs.filter(job => job.status === key).length;
          const selected = selectedStatus === key;
          return <button type="button" key={key} className={`my-work-category-card ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={() => setSelectedStatus(key)}><span className="my-work-category-name">{label}</span><strong>{count}</strong><span className="my-work-category-detail">{key === 'all' ? 'Every job you created or claimed' : key === 'submitted' ? 'Waiting for client review' : key === 'settlement_pending' ? 'Payment is being completed' : key === 'disputed' ? 'Waiting for team review' : label}</span><span className="my-work-category-bar"><i style={{ width: `${jobs.length ? Math.max(count ? 8 : 0, Math.round(count / jobs.length * 100)) : 0}%` }} /></span></button>;
        })}
      </div>
    </div>
    <div className="my-work-section-title my-work-jobs-title"><h3>{selectedStatus === 'all' ? reviewCount ? 'Other jobs' : 'All jobs' : statusLabels[selectedStatus] || selectedStatus}</h3><span>{listedJobs.length} {listedJobs.length === 1 ? 'job' : 'jobs'}</span></div>
    {listedJobs.length ? <div className="my-work-list">{listedJobs.map(job => {
      const isDoer = job.doerWallet?.toLowerCase() === walletAddress?.toLowerCase();
      const isClient = job.clientWallet?.toLowerCase() === walletAddress?.toLowerCase();
      const canSubmit = isDoer && !job.doerAgent && ['in_progress', 'revision_requested'].includes(job.status);
      const canDispute = ['in_progress', 'revision_requested', 'submitted'].includes(job.status) && (isDoer || isClient);
      return <article className="my-work-card" key={job.id}><header className="my-work-card-header"><div className="my-work-card-title"><span className="my-work-category-tag">{workCategoryName(job.category)}</span><h4>{job.title}</h4></div><strong className="my-work-reward">{job.amount} <small>{job.asset}</small></strong></header><div className="my-work-card-meta"><span className={`my-work-status status-${job.status}`}>{statusLabels[job.status] || job.status.replaceAll('_', ' ')}</span>{job.doerAgent && <span className="my-work-agent-tag">AI worker · {job.doerAgent.name}</span>}<span className="my-work-participant">{isClient ? 'Worker' : 'Client'} <UserTagLink userTag={isClient ? job.doerUserTag : job.clientUserTag} walletAddress={isClient ? job.doerWallet : job.clientWallet} /></span></div>{job.claimExpiresAt && <div className="my-work-deadline"><span>Claim deadline</span><time dateTime={new Date(job.claimExpiresAt).toISOString()}>{new Date(job.claimExpiresAt).toLocaleString()}</time></div>}<div className="my-work-actions">
        <button className={isClient && job.status === 'submitted' ? 'pill primary' : 'pill outline'} onClick={() => openReview(job)}>{isClient && job.status === 'submitted' ? 'Review submission' : 'View job history'}</button>
        {canSubmit && <button className="pill primary" onClick={() => setDialog({ mode: 'submit', job })}>Submit work</button>}
        {isDoer && job.doerAgent && ['in_progress', 'revision_requested'].includes(job.status) && <button className="pill outline" disabled={busy} onClick={() => takeOverAgentJob(job)}>Take over from AI</button>}
        {isDoer && job.status === 'in_progress' && <button className="pill outline" disabled={busy} onClick={() => unclaim(job)}>Unclaim job</button>}
        {isClient && job.status === 'in_progress' && <button className="pill outline" disabled={busy} onClick={() => releaseWorker(job)}>Release worker</button>}
        {isClient && job.status === 'completed' && job.doerWallet && <button className="pill outline" data-open-tab="create" onClick={() => document.dispatchEvent(new CustomEvent('jobsai:hire-worker', { detail: { wallet: job.doerWallet, title: job.title } }))}>Hire again</button>}
        {isDoer && job.payoutRecoveryAvailable && <button className="pill primary" disabled={busy} onClick={() => setDialog({ mode: 'payout', job })}>Update payout wallet</button>}
        {canDispute && <button className="pill outline" onClick={() => setDialog({ mode: 'dispute', job })}>Open dispute</button>}
      </div></article>;
    })}</div> : <div className="my-work-empty"><span className="my-work-empty-mark">✓</span><h4>{pendingReviewJobs.length && visibleJobs.some(job => pendingReviewIds.has(job.id)) ? 'These jobs are above, waiting for your review' : jobs.length ? `No jobs with status “${statusLabels[selectedStatus] || selectedStatus}”` : 'Your work will appear here'}</h4><p>{jobs.length ? 'Choose another status to see the rest of your work.' : 'Claim a funded job or create one to start building your work history.'}</p>{selectedStatus !== 'all' && <button className="pill outline" onClick={() => setSelectedStatus('all')}>Show all work</button>}</div>}
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="my-work-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="my-work-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <WorkflowDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={submitDialog} onVideoHelp={() => setMediaInfo({ title: 'Submitting a video', paragraphs: ['Image attachments are uploaded to JobsAI’s Cloudinary media storage. JobsAI accepts JPEG, PNG, WebP, and GIF images up to 5 MB each, with a maximum of five images per submission.', 'For video work, upload the video to cloud storage such as Cloudinary, Google Drive, Dropbox, or an unlisted video host. Set access so the client can view it, then paste the share link into Evidence links.'] })} busy={busy} userTag={userTag} />
    <InformationDialog info={mediaInfo} onClose={() => setMediaInfo(null)} />
  </section>;
}

function goToAuth() {
  const next = `workspace.html${location.search}`;
  location.replace(`auth.html?next=${encodeURIComponent(next)}`);
}

const shortWallet = wallet => wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : '';
function UserTagLink({ userTag, walletAddress, children }) {
  const label = userTag ? `@${userTag}` : children || shortWallet(walletAddress) || 'JobsAI member';
  return userTag
    ? <a className="user-tag-link" href={`worker.html?tag=${encodeURIComponent(userTag)}`}>{label}</a>
    : <span className="user-tag-fallback">{label}</span>;
}

function ProposalDialog({ job, agents, existing, busy, onClose, onSend, onWithdraw }) {
  const eligibleAgents = agents.filter(agent => agent.categories?.includes(job.category));
  const [pitch, setPitch] = useState(existing?.status === 'pending' ? existing.pitch : '');
  const [deliveryDays, setDeliveryDays] = useState(existing?.deliveryDays ? String(existing.deliveryDays) : '');
  const [agentId, setAgentId] = useState(existing?.agent?.id || '');
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-dialog-title">
    <span className="workspace-modal-symbol" aria-hidden="true">✎</span><h2 id="proposal-dialog-title">{existing?.status === 'pending' ? 'Update your proposal' : 'Send a proposal'}</h2>
    <p>{job.title} · {job.amount} {job.asset} · {job.proposalCount || 0} {job.proposalCount === 1 ? 'proposal' : 'proposals'} so far</p>
    <p>The client reads every proposal and picks one worker. The payment is already in escrow, so the price is fixed. Tell them why you are the right fit.</p>
    <form onSubmit={event => { event.preventDefault(); onSend({ pitch: pitch.trim(), ...(deliveryDays ? { deliveryDays: Number(deliveryDays) } : {}), ...(agentId ? { agentId } : {}) }); }}>
      <label>Your pitch <small>{pitch.trim().length}/2000 · at least 20 characters</small><textarea required minLength="20" maxLength="2000" rows="5" value={pitch} onChange={event => setPitch(event.target.value)} placeholder="Relevant work you have done, how you would approach this job, and anything you need from the client." /></label>
      <div className="create-job-payment-row"><label>Delivery time <small>Optional</small><select value={deliveryDays} onChange={event => setDeliveryDays(event.target.value)}><option value="">Not stated</option>{[1, 2, 3, 5, 7, 14, 30].map(days => <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'}</option>)}</select></label>
        <label>Who does the work<select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">Me (human)</option>{eligibleAgents.map(agent => <option key={agent.id} value={agent.id}>AI worker · {agent.name}</option>)}</select></label></div>
      <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={onClose} disabled={busy}>Close</button>{existing?.status === 'pending' && <button type="button" className="pill outline" onClick={() => onWithdraw(existing)} disabled={busy}>Withdraw</button>}<button type="submit" className="pill primary" disabled={busy || pitch.trim().length < 20}>{busy ? 'Sending…' : existing?.status === 'pending' ? 'Update proposal' : 'Send proposal'}</button></div>
    </form>
  </section></div>;
}

function FundedJobs({ session }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState('');
  const [proposing, setProposing] = useState(null);
  const [myProposals, setMyProposals] = useState({});
  const [agents, setAgents] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [invitationAgent, setInvitationAgent] = useState({});
  const [feedback, setFeedback] = useState({ title: 'Loading funded jobs', message: 'Checking for currently funded work…', kind: 'loading' });
  const [jobInfo, setJobInfo] = useState(null);

  async function refresh() {
    setFeedback({ title: 'Loading funded jobs', message: 'Checking for currently funded work…', kind: 'loading' });
    try {
      const [response, proposalResponse, agentResponse, invitationResponse] = await Promise.all([
        JobsAIAPI.readyJobs(),
        JobsAIAPI.myProposals(session.token).catch(() => ({ data: [] })),
        JobsAIAPI.myAgents(session.token).catch(() => ({ data: [] })),
        JobsAIAPI.myInvitations(session.token).catch(() => ({ data: [] })),
      ]);
      const ready = Array.isArray(response?.data) ? response.data : [];
      const invited = invitationResponse?.data || [];
      setInvitations(invited);
      setJobs(ready);
      setMyProposals(Object.fromEntries((proposalResponse?.data || []).map(item => [item.jobId, item])));
      setAgents((agentResponse?.data || []).filter(agent => agent.active));
      setFeedback(ready.length || invited.length ? null : { title: 'No funded jobs are ready', message: 'Check again later or refresh to look for newly funded work.', kind: 'info' });
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

  async function sendProposal(input) {
    const job = proposing;
    setBusy(job.id);
    try {
      const { data } = await JobsAIAPI.sendProposal(job.id, input, session.token);
      const isNew = myProposals[job.id]?.status !== 'pending';
      setMyProposals(current => ({ ...current, [job.id]: data }));
      if (isNew) setJobs(current => current.map(item => item.id === job.id ? { ...item, proposalCount: (item.proposalCount || 0) + 1 } : item));
      setProposing(null);
      setFeedback({ title: isNew ? 'Proposal sent' : 'Proposal updated', message: 'The client will compare proposals and choose one worker. If they choose yours, the job appears in My work, already assigned to you.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not send proposal', message: error.message || 'JobsAI could not send this proposal.', kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function respondToInvitation(invitation, accept) {
    const job = invitation.job;
    setBusy(job.id);
    setFeedback({ title: accept ? 'Accepting the invitation' : 'Declining the invitation', message: accept ? 'Assigning this job to you…' : 'Letting the client know…', kind: 'loading' });
    try {
      const agentId = invitationAgent[job.id];
      if (accept) await JobsAIAPI.acceptInvitation(job.id, agentId, session.token);
      else await JobsAIAPI.declineInvitation(job.id, session.token);
      setInvitations(current => current.filter(item => item.id !== invitation.id));
      if (accept) document.dispatchEvent(new Event('jobsai:work-updated'));
      const agent = agents.find(item => item.id === agentId);
      setFeedback(accept
        ? { title: 'Invitation accepted', message: agent ? `AI worker ${agent.name} now has this job and will pick it up from its assigned jobs.` : 'The job is now assigned to you. Find it in My work to submit when it is ready.', kind: 'success' }
        : { title: 'Invitation declined', message: 'The client can invite someone else or open the job to every worker. The escrow stays with the client.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not respond to the invitation', message: error.message || 'JobsAI could not update this invitation.', kind: 'error' }); }
    finally { setBusy(''); }
  }

  async function withdrawProposal(proposal) {
    setBusy(proposal.jobId);
    try {
      await JobsAIAPI.withdrawProposal(proposal.jobId, proposal.id, session.token);
      setMyProposals(current => ({ ...current, [proposal.jobId]: { ...proposal, status: 'withdrawn' } }));
      setJobs(current => current.map(item => item.id === proposal.jobId ? { ...item, proposalCount: Math.max(0, (item.proposalCount || 1) - 1) } : item));
      setProposing(null);
      setFeedback({ title: 'Proposal withdrawn', message: 'The client can no longer choose it. You can send a new proposal while the job is still open.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not withdraw proposal', message: error.message || 'JobsAI could not withdraw this proposal.', kind: 'error' }); }
    finally { setBusy(''); }
  }

  return <>
    <div className="live-jobs-heading">
      <div><span className="eyebrow">LIVE · FUNDED ONCHAIN</span><h2 id="live-jobs-title">Jobs ready to claim</h2><button className="text-info-button" onClick={() => setJobInfo({ title: 'Review a funded job', paragraphs: ['Open job details to read the scope, acceptance criteria, listed asset, and deadline before claiming. Claiming assigns the work to you and does not move funds.'] })}>How funded work works</button></div>
      <button className="pill outline" onClick={refresh} disabled={!!busy}>Refresh</button>
    </div>
    {invitations.length > 0 && <section className="invitation-inbox" aria-labelledby="invitation-inbox-title"><h3 id="invitation-inbox-title">Invited to you <span>{invitations.length}</span></h3>
      {invitations.map(invitation => { const job = invitation.job; const eligible = agents.filter(agent => agent.categories?.includes(job.category)); return <article className="live-job-card invitation-card" key={invitation.id}>
        <div className="live-job-top"><h3>{job.title}</h3><strong className="live-job-amount">{job.amount} {job.asset}</strong></div>
        <p className="live-job-mode"><span className="invite-mode-badge">Only you can take this</span>From <UserTagLink userTag={job.clientUserTag} walletAddress={job.clientWallet} /></p>
        {invitation.message && <blockquote className="invitation-message">{invitation.message}</blockquote>}
        {eligible.length > 0 && <label className="invitation-worker">Who does the work<select value={invitationAgent[job.id] || ''} onChange={event => setInvitationAgent(current => ({ ...current, [job.id]: event.target.value }))}><option value="">Me (human)</option>{eligible.map(agent => <option key={agent.id} value={agent.id}>AI worker · {agent.name}</option>)}</select></label>}
        <div className="live-job-actions"><button className="pill outline" onClick={() => setJobInfo({ title: job.title, paragraphs: [job.description, job.deadlineAt ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided'], itemsLabel: 'Acceptance criteria', items: job.acceptanceCriteria || [], link: job.sourceFileUrl, linkLabel: 'Open source document' })}>View details</button><button className="pill outline" disabled={!!busy} onClick={() => respondToInvitation(invitation, false)}>Decline</button><button className="pill primary live-job-claim" disabled={!!busy} onClick={() => respondToInvitation(invitation, true)}>Accept job</button></div>
      </article>; })}
    </section>}
    <div className="live-jobs-list">{jobs.map(job => <article className="live-job-card" key={job.id}>
      <div className="live-job-top"><h3>{job.title}</h3><strong className="live-job-amount">{job.amount} {job.asset}</strong></div>
      <p className="live-job-identity">Posted by <UserTagLink userTag={job.clientUserTag} walletAddress={job.clientWallet} /></p>
      {job.selectionMode === 'proposals' && <p className="live-job-mode"><span className="proposal-mode-badge">Client picks from proposals</span>{job.proposalCount || 0} {job.proposalCount === 1 ? 'proposal' : 'proposals'}{myProposals[job.id]?.status === 'pending' && <b> · Yours is waiting</b>}</p>}
        <div className="live-job-actions"><button className="pill outline" onClick={() => setJobInfo({ title: job.title, paragraphs: [job.description, job.deadlineAt && !Number.isNaN(new Date(job.deadlineAt).valueOf()) ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided'], itemsLabel: 'Acceptance criteria', items: job.acceptanceCriteria || [], link: job.sourceFileUrl, linkLabel: 'Open source document' })}>View details</button>{job.selectionMode === 'proposals'
        ? <button className="pill primary live-job-claim" disabled={!!busy || ['accepted', 'released'].includes(myProposals[job.id]?.status) || job.clientWallet?.toLowerCase() === session.walletAddress?.toLowerCase()} onClick={() => setProposing(job)}>{myProposals[job.id]?.status === 'pending' ? 'Edit proposal' : 'Send proposal'}</button>
        : <button className="pill primary live-job-claim" disabled={!!busy} onClick={() => claim(job)}>Claim job</button>}</div>
    </article>)}</div>
    {feedback && <div className="workspace-overlay" role="presentation"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="workspace-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    <InformationDialog info={jobInfo} onClose={() => setJobInfo(null)} />
    {proposing && <ProposalDialog job={proposing} agents={agents} existing={myProposals[proposing.id]} busy={busy === proposing.id} onClose={() => setProposing(null)} onSend={sendProposal} onWithdraw={withdrawProposal} />}
  </>;
}

function CreateJobPanel({ session, walletAddress, chainId }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [voiceDialog, setVoiceDialog] = useState(null);
  const [voiceListening, setVoiceListening] = useState(false);
  const speechRecognitionRef = useRef(null);
  const firefoxRecorderRef = useRef(null);
  const firefoxStreamRef = useRef(null);
  const firefoxChunksRef = useRef([]);
  const firefoxTimerRef = useRef(null);
  const voiceTranscriptRef = useRef('');
  const voiceErrorRef = useRef(false);
  const [codeRepo, setCodeRepo] = useState('');
  const [codeFiles, setCodeFiles] = useState([]);
  const [translationSourceFile, setTranslationSourceFile] = useState(null);
  const [criteria, setCriteria] = useState('');
  const [category, setCategory] = useState('writing');
  const [asset, setAsset] = useState('eth');
  const [amount, setAmount] = useState('');
  const [deadlineAt, setDeadlineAt] = useState('');
  const [selectionMode, setSelectionMode] = useState('claim');
  const [inviteWallet, setInviteWallet] = useState('');
  const [inviteMessage, setInviteMessage] = useState('');
  const [reinviting, setReinviting] = useState(null);
  const [reviewing, setReviewing] = useState(null);
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

  useEffect(() => () => {
    speechRecognitionRef.current?.abort();
    clearTimeout(firefoxTimerRef.current);
    const recorder = firefoxRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    firefoxStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  function stopVoiceCapture() {
    if (firefoxRecorderRef.current?.state === 'recording') {
      firefoxRecorderRef.current.stop();
      return;
    }
    speechRecognitionRef.current?.stop();
  }

  async function startFirefoxVoiceCapture() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceDialog({ kind: 'error', title: 'Voice recording is unavailable', message: 'This Firefox setup cannot record audio. Check microphone permissions or type your brief instead.' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      firefoxStreamRef.current = stream;
      const mimeOptions = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/webm'];
      const mimeType = mimeOptions.find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      firefoxRecorderRef.current = recorder;
      firefoxChunksRef.current = [];
      voiceErrorRef.current = false;
      recorder.ondataavailable = event => { if (event.data?.size) firefoxChunksRef.current.push(event.data); };
      recorder.onerror = () => {
        voiceErrorRef.current = true;
        setVoiceDialog({ kind: 'error', title: 'Recording stopped', message: 'Firefox could not finish recording. Check your microphone and try again.' });
      };
      recorder.onstop = async () => {
        clearTimeout(firefoxTimerRef.current);
        firefoxRecorderRef.current = null;
        firefoxStreamRef.current?.getTracks().forEach(track => track.stop());
        firefoxStreamRef.current = null;
        setVoiceListening(false);
        if (voiceErrorRef.current) return;
        const audio = new Blob(firefoxChunksRef.current, { type: recorder.mimeType || mimeType || 'audio/ogg' });
        firefoxChunksRef.current = [];
        if (!audio.size) {
          setVoiceDialog({ kind: 'unavailable', title: 'No audio recorded', message: 'No audio was captured. Check your microphone and try again.' });
          return;
        }
        if (audio.size > 4 * 1024 * 1024) {
          setVoiceDialog({ kind: 'error', title: 'Recording is too large', message: 'Keep voice recordings under 4 MB. Record for less time and try again.' });
          return;
        }
        setVoiceDialog({ kind: 'transcribing', title: 'Transcribing your brief', message: 'Turning your recording into text…' });
        try {
          const response = await JobsAIAPI.transcribeAudio(audio, session.token);
          const transcript = response?.data?.transcript?.trim();
          if (!transcript) throw new Error('No speech was detected. Please record again.');
          voiceTranscriptRef.current = transcript;
          setDescription(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${transcript}`);
          setVoiceDialog({ kind: 'done', title: 'Voice added to your brief', message: 'Review and edit the transcript in the job description before creating your job.' });
        } catch (error) {
          setVoiceDialog({ kind: 'error', title: 'Could not transcribe your recording', message: error.message || 'The speech service could not transcribe this recording. Please try again.' });
        }
      };
      recorder.start(500);
      setVoiceListening(true);
      setVoiceDialog({ kind: 'recording', title: 'Recording your brief', message: 'Speak in English. Stop whenever you’re ready; recording ends after 60 seconds.' });
      firefoxTimerRef.current = setTimeout(() => stopVoiceCapture(), 60_000);
    } catch (error) {
      firefoxStreamRef.current?.getTracks().forEach(track => track.stop());
      firefoxStreamRef.current = null;
      setVoiceListening(false);
      setVoiceDialog({ kind: 'error', title: 'Could not access your microphone', message: error?.name === 'NotAllowedError' ? 'Allow microphone access for this site in Firefox, then try again.' : 'Check that a microphone is connected and try again.' });
    }
  }

  function confirmFirefoxVoiceCapture() {
    setVoiceDialog(null);
    void startFirefoxVoiceCapture();
  }

  function startVoiceCapture() {
    if (/(Firefox|FxiOS)\//.test(navigator.userAgent)) {
      setVoiceDialog({ kind: 'firefox-consent', title: 'Voice typing in Firefox', message: 'If you continue, your recording will be sent through JobsAI to Groq for English transcription. JobsAI does not save the recording. Groq may temporarily retain request data for up to 30 days for reliability and abuse monitoring unless Zero Data Retention is enabled for our account. The transcript is added to your brief for you to review.' });
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceDialog({ kind: 'unavailable', title: 'Voice typing is unavailable', message: 'This browser does not support voice typing. Try your device’s built-in dictation or type your brief instead.' });
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      speechRecognitionRef.current = recognition;
      voiceTranscriptRef.current = '';
      voiceErrorRef.current = false;
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = event => {
        const text = Array.from(event.results).slice(event.resultIndex).filter(result => result.isFinal).map(result => result[0]?.transcript?.trim()).filter(Boolean).join(' ');
        if (!text) return;
        voiceTranscriptRef.current = [voiceTranscriptRef.current, text].filter(Boolean).join(' ');
        setDescription(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`);
      };
      recognition.onerror = event => {
        voiceErrorRef.current = true;
        setVoiceDialog({ kind: 'error', title: 'Could not record your voice', message: event.error === 'not-allowed' ? 'Allow microphone access in your browser settings, then try again.' : 'The browser could not turn that recording into text. Check your microphone and try again.' });
      };
      recognition.onend = () => {
        speechRecognitionRef.current = null;
        setVoiceListening(false);
        if (voiceErrorRef.current) return;
        setVoiceDialog(voiceTranscriptRef.current
          ? { kind: 'done', title: 'Voice added to your brief', message: 'Review and edit the text in the job description before creating your job.' }
          : { kind: 'unavailable', title: 'No speech detected', message: 'No text was captured. Check your microphone and try again.' });
      };
      recognition.start();
      setVoiceListening(true);
      setVoiceDialog({ kind: 'listening', title: 'Listening', message: 'Speak in English. Your browser handles speech recognition and may use its speech service. JobsAI adds the transcript to your brief for you to review.' });
    } catch {
      speechRecognitionRef.current = null;
      setVoiceListening(false);
      setVoiceDialog({ kind: 'error', title: 'Could not start voice typing', message: 'Allow microphone access in your browser, then try again.' });
    }
  }

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
    const onHire = event => { setSelectionMode('invite'); setInviteWallet(event.detail?.wallet || ''); onOpen(); };
    document.addEventListener('jobsai:hire-worker', onHire);
    if (new URLSearchParams(location.search).get('tab') === 'create') onOpen();
    return () => { document.removeEventListener('jobsai:open-create', onOpen); document.removeEventListener('jobsai:refresh-created', onRefresh); document.removeEventListener('jobsai:hire-worker', onHire); };
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
    let jobDescription = description.trim();
    if (category === 'coding' && (codeRepo.trim() || codeFiles.length)) {
      if (codeRepo.trim() && !/^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.*)?$/.test(codeRepo.trim())) {
        setFeedback({ title: 'Check the repository link', message: 'Enter an HTTPS link to a public GitHub repository.', kind: 'error' });
        return;
      }
      const attached = await Promise.all(codeFiles.map(async file => ({ name: file.name, text: await file.text() })));
      const sourceBlock = [codeRepo.trim() ? `Public GitHub repository for review: ${codeRepo.trim()}` : '', ...attached.map(file => `[SOURCE FILE: ${file.name}]\n\`\`\`\n${file.text}\n\`\`\``)].filter(Boolean).join('\n\n');
      jobDescription = `${jobDescription}\n\n${sourceBlock}`.trim();
      if (jobDescription.length > 20000) {
        setFeedback({ title: 'Source files are too large', message: 'Keep the job brief and attached source files under 20,000 characters, or provide a public GitHub repository link instead.', kind: 'error' });
        return;
      }
    }
    if (selectionMode === 'invite' && !/^0x[a-fA-F0-9]{40}$/.test(inviteWallet.trim())) {
      setFeedback({ title: 'Check the worker wallet', message: 'Enter the 0x wallet address of the person or AI worker owner you want to invite.', kind: 'error' });
      return;
    }
    setSaving(true);
    setFeedback({ title: 'Creating your job', message: 'Setting up its escrow address and funding terms…', kind: 'loading' });
    try {
      const sourceFile = category === 'translation' ? translationSourceFile : null;
      const input = { title, description: jobDescription, acceptanceCriteria, category, asset, amount, selectionMode, sourceFileRequired: Boolean(sourceFile), ...(selectionMode === 'invite' ? { inviteWallet: inviteWallet.trim(), ...(inviteMessage.trim() ? { inviteMessage: inviteMessage.trim() } : {}) } : {}), ...(deadlineAt ? { deadlineAt: new Date(deadlineAt).toISOString() } : {}) };
      const response = await JobsAIAPI.createJob(input, session.token);
      const created = response.data;
      let sourceUploadFailed = false;
      if (sourceFile) {
        setFeedback({ title: 'Uploading the source document', message: 'Adding the translation file to this job before it can be funded…', kind: 'loading' });
        try {
          const uploaded = await JobsAIAPI.uploadJobSource(sourceFile, created.id, session.token);
          created.sourceFileUrl = uploaded.data.url;
        } catch { sourceUploadFailed = true; }
      }
      setJobs(current => [created, ...current.filter(job => job.id !== created.id)]);
      setLoaded(true);
      setTitle(''); setDescription(''); setCriteria(''); setCategory('writing'); setAmount(''); setDeadlineAt(''); setCodeRepo(''); setCodeFiles([]); setTranslationSourceFile(null); setSelectionMode('claim'); setInviteWallet(''); setInviteMessage('');
      setFeedback(sourceUploadFailed
        ? { title: 'Job created, source not attached', message: 'The source file did not upload. Use Attach source document in Created jobs to retry; the job cannot be funded until the required source is attached.', kind: 'error' }
        : { title: 'Job created', message: created.selectionMode === 'invite' ? `Fund ${created.amount} ${created.asset} from your connected wallet. The job then appears only for ${created.invitation?.userTag ? `@${created.invitation.userTag}` : shortWallet(created.invitation?.wallet)}, who can accept or decline it.` : created.selectionMode === 'proposals' ? `Fund ${created.amount} ${created.asset} from your connected wallet to publish this job. Workers then send proposals, and you choose one from Created jobs → Proposals.` : `Fund ${created.amount} ${created.asset} from your connected wallet to publish this job for claiming.`, kind: 'success' });
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
      setFeedback({ title: 'Job funded and published', message: job.selectionMode === 'invite' ? 'Your invited worker can now accept it from their funded jobs board.' : 'Your job is now visible to eligible workers.', kind: 'success' });
    } catch (error) {
      if (hash) localStorage.setItem(`jobsai-pending-funding-${job.id}`, hash);
      setFeedback({ title: hash ? 'Verify your escrow deposit' : 'Funding was not completed', message: hash ? 'Your transfer was sent, but verification did not finish. Retry verification from your jobs list; do not send the funds again.' : error.message || 'The escrow deposit could not be completed.', kind: 'error' });
    } finally { setSaving(false); }
  }

  async function attachSourceDocument(job, file) {
    setSaving(true);
    setFeedback({ title: 'Uploading the source document', message: 'Adding the translation file to the job…', kind: 'loading' });
    try {
      const uploaded = await JobsAIAPI.uploadJobSource(file, job.id, session.token);
      setJobs(current => current.map(item => item.id === job.id ? { ...item, sourceFileUrl: uploaded.data.url } : item));
      setFeedback({ title: 'Source document attached', message: 'The source file is saved with the job and will be available to workers after funding.', kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Could not attach the source document', message: error.message || 'Try uploading the file again.', kind: 'error' });
    } finally { setSaving(false); }
  }

  async function openProposals(job) {
    setFeedback({ title: 'Loading proposals', message: 'Retrieving the proposals workers sent for this job…', kind: 'loading' });
    try {
      const { data } = await JobsAIAPI.proposals(job.id, session.token);
      setFeedback(null);
      setReviewing({ job, proposals: data || [] });
    } catch (error) { setFeedback({ title: 'Could not load proposals', message: error.message || 'JobsAI could not load proposals for this job.', kind: 'error' }); }
  }

  async function chooseProposal(proposal) {
    const job = reviewing.job;
    setSaving(true);
    setFeedback({ title: 'Assigning the job', message: 'Giving this job to the worker you chose…', kind: 'loading' });
    try {
      await JobsAIAPI.acceptProposal(job.id, proposal.id, session.token);
      setReviewing(null);
      await loadJobs(false);
      document.dispatchEvent(new Event('jobsai:work-updated'));
      setFeedback({ title: 'Worker chosen', message: `${proposal.agent ? `AI worker ${proposal.agent.name} · @${proposal.proposerUserTag || shortWallet(proposal.proposerWallet)}` : `@${proposal.proposerUserTag || shortWallet(proposal.proposerWallet)}`} is now assigned. Follow the work and review submissions in My work. Funds stay in escrow until you accept.`, kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Could not choose this proposal', message: error.message || 'JobsAI could not assign this worker.', kind: 'error' });
    } finally { setSaving(false); }
  }

  async function sendInvitation(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const wallet = String(form.get('wallet') || '').trim(), message = String(form.get('message') || '').trim();
    const job = reinviting;
    setSaving(true);
    try {
      const invited = await JobsAIAPI.inviteWorker(job.id, wallet, message || undefined, session.token);
      setReinviting(null);
      await loadJobs(false);
      setFeedback({ title: 'Invitation sent', message: `${invited?.data?.userTag ? `@${invited.data.userTag}` : shortWallet(wallet.toLowerCase())} can now accept this job${job.status === 'ready' ? '' : ' once you fund it'}. Any earlier invitation was withdrawn.`, kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not send invitation', message: error.message || 'JobsAI could not invite this worker.', kind: 'error' }); }
    finally { setSaving(false); }
  }

  async function openToEveryone(job, mode) {
    setSaving(true);
    setJobInfo(null);
    try {
      await JobsAIAPI.openJob(job.id, mode, session.token);
      await loadJobs(false);
      setFeedback({ title: mode === 'proposals' ? 'Now taking proposals' : 'Open to every worker', message: mode === 'proposals' ? 'Any pending invitation was withdrawn. Workers can now send proposals, and you choose one from Created jobs.' : 'Any pending invitation was withdrawn. The first eligible worker can now claim this job from the funded board.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Could not open this job', message: error.message || 'JobsAI could not change who can take this job.', kind: 'error' }); }
    finally { setSaving(false); }
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
      <label>Description<div className="voice-input-wrap"><textarea required maxLength="20000" rows="5" value={description} onChange={event => setDescription(event.target.value)} /><button className={`voice-input-button${voiceListening ? ' is-listening' : ''}`} type="button" aria-label={voiceListening ? 'Stop voice typing' : 'Add to brief by voice'} aria-pressed={voiceListening} title={voiceListening ? 'Stop voice typing' : 'Add to brief by voice'} onClick={voiceListening ? stopVoiceCapture : startVoiceCapture} disabled={saving || drafting}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8"/></svg></button></div></label>
      <label>Work category<select value={category} onChange={event => setCategory(event.target.value)}><option value="writing">Article or social thread writing</option><option value="translation">Translation</option><option value="image_generation">Image generation</option><option value="research">Research</option><option value="design">Design</option><option value="coding">Coding or code review</option><option value="data">Data</option><option value="other">Other</option></select></label>
      {category === 'translation' && <fieldset className="job-code-source"><legend>Source document <small>Optional</small></legend><label>Attach a PDF, DOCX, Markdown, or text file<input type="file" accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain" onChange={event => { const file = event.target.files?.[0] || null; if (file && file.size > 12 * 1024 * 1024) { event.target.value = ''; setTranslationSourceFile(null); setFeedback({ title: 'This document is too large', message: 'Choose a source document that is 12 MB or smaller.', kind: 'error' }); return; } setTranslationSourceFile(file); }} /></label><small>{translationSourceFile ? `${translationSourceFile.name} selected` : 'Source files are available to workers after the job is funded.'}</small><button type="button" className="text-info-button" onClick={() => setJobInfo({ title: 'How source documents are shared', paragraphs: ['The uploaded file is stored as a public cloud link. Workers can open it after the job is funded, and anyone with the link may be able to view it. Only attach material you have permission to share.', 'For short text, you can paste the source into the job description instead. Jayla returns a PDF by default; a revision can request DOCX or Markdown.'] })}>File sharing details</button></fieldset>}
      {category === 'coding' && <fieldset className="job-code-source"><legend>Code review source <small>Optional</small></legend><label>Public GitHub repository<input type="url" inputMode="url" placeholder="https://github.com/owner/repository" value={codeRepo} onChange={event => setCodeRepo(event.target.value)} /></label><label>Or attach source files<input type="file" accept=".c,.cc,.cpp,.cs,.css,.go,.h,.hpp,.html,.java,.js,.jsx,.kt,.md,.php,.py,.rb,.rs,.sh,.sql,.swift,.ts,.tsx,.vue,.xml,.yaml,.yml,.json,.txt" multiple onChange={event => { const files = Array.from(event.target.files || []); const total = files.reduce((sum, file) => sum + file.size, 0); if (files.length > 8 || total > 12000) { event.target.value = ''; setCodeFiles([]); setFeedback({ title: 'Choose fewer or smaller files', message: 'Attach up to 8 text files with a combined size under 12 KB. For larger codebases, provide a public GitHub repository link.', kind: 'error' }); return; } setCodeFiles(files); }} /></label><small>{codeFiles.length ? `${codeFiles.length} source file${codeFiles.length === 1 ? '' : 's'} selected` : 'Only attach code you are comfortable sharing with workers on the public job board. Larger codebases can use a public GitHub link.'}</small></fieldset>}
      <div className="criteria-field"><div className="criteria-field-header"><label htmlFor="job-acceptance-criteria">Acceptance criteria</label><button type="button" className="inline-info-button" onClick={() => setJobInfo({ title: 'Acceptance criteria', paragraphs: ['Enter one clear condition per line. For example: “Works on mobile and desktop” or “Include the source files.” The worker and client use these conditions to review each submission and revision.'] })}>How to write criteria</button></div><textarea id="job-acceptance-criteria" required rows="4" value={criteria} onChange={event => setCriteria(event.target.value)} /></div>
      <div className="create-job-payment-row"><label>Payment asset<select value={asset} onChange={event => setAsset(event.target.value)}><option value="eth">ETH</option><option value="usdg">USDG</option></select></label><label>Amount<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?" value={amount} onChange={event => setAmount(event.target.value)} /></label></div>
      <label>Deadline<input type="datetime-local" value={deadlineAt} onChange={event => setDeadlineAt(event.target.value)} /></label>
      <fieldset className="selection-mode-field"><legend>How workers start</legend>
        <label className={selectionMode === 'claim' ? 'selected' : ''}><input type="radio" name="selection-mode" value="claim" checked={selectionMode === 'claim'} onChange={() => setSelectionMode('claim')} /><span><b>Instant start</b><small>The first eligible worker to claim it starts right away.</small></span></label>
        <label className={selectionMode === 'proposals' ? 'selected' : ''}><input type="radio" name="selection-mode" value="proposals" checked={selectionMode === 'proposals'} onChange={() => setSelectionMode('proposals')} /><span><b>Review proposals</b><small>Workers and AI workers pitch for it. You compare them and choose one.</small></span></label>
        <label className={selectionMode === 'invite' ? 'selected' : ''}><input type="radio" name="selection-mode" value="invite" checked={selectionMode === 'invite'} onChange={() => setSelectionMode('invite')} /><span><b>Invite a worker</b><small>Send it to one wallet you already trust. It stays off the public board.</small></span></label>
        {selectionMode === 'invite' && <div className="invite-fields"><label>Worker wallet<input required pattern="0x[a-fA-F0-9]{40}" autoComplete="off" spellCheck="false" placeholder="0x…" value={inviteWallet} onChange={event => setInviteWallet(event.target.value)} /></label><label>Note to the worker <small>Optional</small><textarea rows="2" maxLength="1000" value={inviteMessage} onChange={event => setInviteMessage(event.target.value)} placeholder="Why you picked them, or anything they should know first." /></label><small>If the wallet owns AI workers, they can hand the job to one of them.</small></div>}
      </fieldset>
      {quality && <section className={`job-quality job-quality-${quality.grade}`} aria-live="polite" aria-label="Brief strength"><div className="job-quality-heading"><span>Brief strength</span><strong>{quality.score}/100 · {{ strong: 'Strong', okay: 'Okay', needs_work: 'Needs work' }[quality.grade]}</strong></div><div className="job-quality-bar" aria-hidden="true"><i style={{ width: `${quality.score}%` }} /></div>{quality.checks.some(item => !item.passed) ? <ul>{quality.checks.filter(item => !item.passed).map(item => <li key={item.id}><b>{item.label}:</b> {item.fix}</li>)}</ul> : <p>Clear and checkable. Workers know what to deliver and how it will be reviewed.</p>}</section>}
      <button className="pill primary" type="submit" disabled={saving}>Create job</button>
    </form>
    <section className="created-jobs-card" aria-labelledby="created-jobs-title"><div className="created-jobs-heading"><div><span className="eyebrow">YOUR JOBS</span><h2 id="created-jobs-title">Created jobs</h2></div><button className="pill outline" onClick={() => loadJobs()} disabled={saving}>Refresh</button></div>
      <div className="created-jobs-list">{jobs.map(job => <article className="created-job-item" key={job.id}><div className="created-job-summary"><h3>{job.title}</h3><strong>{job.amount} {job.asset}</strong></div>
        {job.selectionMode === 'invite' && job.invitation && ['awaiting_funding', 'ready'].includes(job.status) && <p className={`invitation-status invitation-${job.invitation.status}`}>Invited <UserTagLink userTag={job.invitation.userTag} walletAddress={job.invitation.wallet} /> · {{ pending: job.status === 'ready' ? 'waiting for their answer' : 'they see it once funded', declined: 'declined — invite someone else or open it to everyone', released: 'released — invite someone else or open it to everyone', cancelled: 'withdrawn', accepted: 'accepted' }[job.invitation.status] || job.invitation.status}</p>}
        <div className="created-job-actions"><button className="pill outline" onClick={() => setJobInfo({ title: job.title, paragraphs: [`Status: ${job.status.replaceAll('_', ' ')}.`, job.description, job.deadlineAt ? `Deadline: ${new Date(job.deadlineAt).toLocaleString()}` : 'No deadline provided.', ...(job.pendingFundingHash ? ['A transfer was sent. Verify it to publish the job; do not send funds again.'] : [])], itemsLabel: 'Acceptance criteria', items: job.acceptanceCriteria || [], link: job.sourceFileUrl, linkLabel: 'Open source document', code: job.status === 'awaiting_funding' ? job.escrowAddress : undefined, codeLabel: 'Escrow address' })}>View details</button>
          {job.sourceFileRequired && !job.sourceFileUrl && <label className="pill outline source-file-retry">Attach source document<input type="file" accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain" onChange={event => { const file = event.target.files?.[0]; if (file) void attachSourceDocument(job, file); event.target.value = ''; }} /></label>}
          {job.status === 'awaiting_funding' && <button className="pill primary" onClick={() => fundJob(job)} disabled={saving || (job.sourceFileRequired && !job.sourceFileUrl)}>{job.pendingFundingHash ? 'Verify deposit' : job.sourceFileRequired && !job.sourceFileUrl ? 'Attach source first' : 'Fund job'}</button>}
          {job.status === 'ready' && job.selectionMode === 'proposals' && <button className="pill primary" onClick={() => openProposals(job)} disabled={saving}>Proposals ({job.proposalCount || 0})</button>}
          {job.selectionMode === 'invite' && ['awaiting_funding', 'ready'].includes(job.status) && <><button className="pill outline" onClick={() => setReinviting(job)} disabled={saving}>{job.invitation?.status === 'pending' ? 'Invite someone else' : 'Invite a worker'}</button><button className="pill outline" onClick={() => setJobInfo({ title: 'Open this job to everyone?', paragraphs: ['Any pending invitation is withdrawn. The job moves to the funded board, where the first eligible worker can claim it.'], confirmLabel: 'Open to everyone', onConfirm: () => openToEveryone(job, 'claim') })} disabled={saving}>Open to everyone</button></>}
          {job.status === 'ready' && <button className="pill outline" onClick={() => setJobInfo({ title: 'Cancel this funded job?', paragraphs: [`${job.amount} ${job.asset} will be returned from escrow to your connected wallet. The job will be removed from the work board while the onchain refund processes.`], confirmLabel: 'Cancel job and refund', onConfirm: () => cancelFundedJob(job) })} disabled={saving}>Cancel job</button>}
        </div>
      </article>)}</div>
    </section>
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="create-job-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="create-job-modal-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
    {voiceDialog && <div className="workspace-overlay"><section className={`workspace-modal ${['listening', 'recording', 'transcribing'].includes(voiceDialog.kind) ? 'loading' : voiceDialog.kind === 'done' ? 'success' : voiceDialog.kind === 'unavailable' || voiceDialog.kind === 'firefox-consent' ? 'info' : 'error'}`} role="dialog" aria-modal="true" aria-labelledby="voice-dialog-title"><span className="workspace-modal-symbol" aria-hidden="true">{['listening', 'recording', 'transcribing'].includes(voiceDialog.kind) ? <i /> : voiceDialog.kind === 'done' ? '✓' : voiceDialog.kind === 'unavailable' || voiceDialog.kind === 'firefox-consent' ? 'i' : '!'}</span><h2 id="voice-dialog-title">{voiceDialog.title}</h2><p>{voiceDialog.message}</p>{voiceDialog.kind === 'firefox-consent' ? <div className="workflow-dialog-actions"><button className="pill outline" onClick={() => setVoiceDialog(null)}>Cancel</button><button className="pill primary" onClick={confirmFirefoxVoiceCapture}>Continue</button></div> : ['listening', 'recording'].includes(voiceDialog.kind) ? <button className="pill primary" onClick={stopVoiceCapture}>Stop recording</button> : voiceDialog.kind === 'transcribing' ? null : <button className="pill primary" onClick={() => setVoiceDialog(null)}>Got it</button>}</section></div>}
    <InformationDialog info={jobInfo} onClose={() => setJobInfo(null)} />
    {reinviting && <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="reinvite-dialog-title">
      <span className="workspace-modal-symbol" aria-hidden="true">✉</span><h2 id="reinvite-dialog-title">Invite a worker</h2><p>{reinviting.title} · {reinviting.amount} {reinviting.asset}</p><p>Only this wallet will see the job. Sending a new invitation withdraws any earlier one.</p>
      <form onSubmit={sendInvitation}><label>Worker wallet<input name="wallet" required pattern="0x[a-fA-F0-9]{40}" autoComplete="off" spellCheck="false" placeholder="0x…" /></label><label>Note to the worker <small>Optional</small><textarea name="message" rows="2" maxLength="1000" /></label>
        <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={() => setReinviting(null)} disabled={saving}>Cancel</button><button type="submit" className="pill primary" disabled={saving}>Send invitation</button></div></form>
    </section></div>}
    {reviewing && <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog proposals-dialog" role="dialog" aria-modal="true" aria-labelledby="proposals-dialog-title">
      <span className="workspace-modal-symbol" aria-hidden="true">✎</span><h2 id="proposals-dialog-title">Proposals</h2><p>{reviewing.job.title} · {reviewing.job.amount} {reviewing.job.asset}</p>
      {reviewing.proposals.filter(item => item.status === 'pending').length === 0 && <p>No proposals are waiting yet. Workers see this job on the funded board with a Send proposal button. Check back soon.</p>}
      <div className="proposal-list">{reviewing.proposals.filter(item => item.status === 'pending').map(proposal => <article className="proposal-card" key={proposal.id}>
        <div className="proposal-card-top"><span className="agent-work-badge">{proposal.agent ? `AI worker · ${proposal.agent.name}` : 'Human worker'}</span><UserTagLink userTag={proposal.proposerUserTag} walletAddress={proposal.proposerWallet} /></div>
        <p>{proposal.pitch}</p>
        <dl><div><dt>Delivery</dt><dd>{proposal.deliveryDays ? `${proposal.deliveryDays} ${proposal.deliveryDays === 1 ? 'day' : 'days'}` : 'Not stated'}</dd></div><div><dt>Completed jobs</dt><dd>{proposal.completedJobs}</dd></div><div><dt>Active now</dt><dd>{proposal.activeJobs}</dd></div></dl>
        <button className="pill primary" onClick={() => chooseProposal(proposal)} disabled={saving}>Choose this worker</button>
      </article>)}</div>
      <div className="workflow-dialog-actions"><button className="pill outline" onClick={() => setReviewing(null)}>Close</button><button className="pill outline" onClick={() => openProposals(reviewing.job)}>Refresh</button></div>
    </section></div>}
  </div>;
}

const mcpCommand = token => `claude mcp add --transport http jobsai ${location.origin}/mcp --header "Authorization: Bearer ${token}"`;

const agentCategoryOptions = [
  ['writing', 'Writing'],
  ['translation', 'Translation'],
  ['image_generation', 'Image creation'],
  ['research', 'Research'],
  ['design', 'Design'],
  ['coding', 'Code review and coding'],
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

  async function copyMcpCommand() {
    try {
      await navigator.clipboard.writeText(mcpCommand(tokenDialog.token));
      setFeedback({ title: 'Claude Code command copied', message: 'Paste it into your terminal. Claude Code can then find, claim, and submit JobsAI work as this AI worker. Treat the command like a password.', kind: 'success' });
    } catch {
      setFeedback({ title: 'Could not copy the command', message: 'Select the command and copy it manually.', kind: 'error' });
    }
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
    {tokenDialog && <div className="workspace-overlay"><section className="workspace-modal workspace-information agent-token-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-token-title"><span className="workspace-modal-symbol" aria-hidden="true">!</span><h2 id="agent-token-title">{tokenDialog.name} is registered</h2><p>Save this private connection key now. It is shown once and expires {new Date(tokenDialog.expiresAt).toLocaleDateString()}. Add it to your worker service’s private settings.</p><label>Private connection key<input readOnly value={tokenDialog.token} onFocus={event => event.target.select()} /></label><div className="agent-mcp-connect"><h3>Or work jobs from an AI coding agent</h3><p>JobsAI runs an MCP server, so Claude Code, Cursor, and other MCP clients can find, claim, and submit work as {tokenDialog.name}. Run this once in your terminal:</p><code>{mcpCommand(tokenDialog.token)}</code><small>Other clients: add <b>{`${location.origin}/mcp`}</b> as a remote HTTP server with the header <b>Authorization: Bearer</b> and this key. <a href="/guides/connecting-an-ai-worker-to-jobsai.html#6-connect-an-ai-coding-agent-with-mcp">Setup guide</a></small></div><div className="workflow-dialog-actions"><button className="pill outline" onClick={() => setTokenDialog(null)}>Close</button><button className="pill outline" onClick={copyMcpCommand}>Copy Claude Code command</button><button className="pill primary" onClick={copyToken}>Copy key</button></div></section></div>}
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="agent-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="agent-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
  </section>;
}

const serviceCategoryOptions = [['writing', 'Writing'], ['image_generation', 'Image creation'], ['research', 'Research'], ['design', 'Design'], ['coding', 'Coding'], ['data', 'Data'], ['other', 'Other']];
const serviceCategoryLabel = value => serviceCategoryOptions.find(([category]) => category === value)?.[1] || value;
const emptyServiceForm = { name: '', summary: '', description: '', category: 'writing', criteria: '', asset: 'eth', amount: '', deliveryDays: '3', agentId: '' };

function ServicesPanel({ session, view = 'catalog' }) {
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

  useEffect(() => { load(); }, [session.token]);

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

  const offersView = view === 'offers';
  return <section className={`services-panel ${offersView ? 'services-offers-view' : 'services-catalog-view'}`}>
    {offersView && <div className="created-jobs-heading"><div><span className="eyebrow">YOUR SERVICES</span><h2>Services you offer</h2><p>Add fixed-price work to your profile. You can pause a listing whenever it is unavailable.</p></div><button className="pill primary" onClick={() => setShowForm(value => !value)}>{showForm ? 'Close form' : 'Add a service'}</button></div>}
    {!offersView && <div className="services-toolbar">
      <label>Category<select value={category} onChange={event => { setCategory(event.target.value); load(event.target.value); }}><option value="">All categories</option>{serviceCategoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>}
    {offersView && showForm && <form className="create-job-form service-form" noValidate onSubmit={createService}>
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
    {!offersView && <div className="services-grid">{catalog.map(service => <article className="service-card" key={service.id}>
      <div className="service-card-top"><span className="agent-work-badge">{service.agent ? `AI worker · ${service.agent.name}` : 'Human provider'}</span><span className="service-category">{serviceCategoryLabel(service.category)}</span></div>
      <h3>{service.name}</h3><p>{service.summary}</p><p className="service-provider-identity">By <UserTagLink userTag={service.providerUserTag} walletAddress={service.providerWallet} /></p>
      <dl><div><dt>Price</dt><dd>{service.amount} {service.asset}</dd></div><div><dt>Delivery</dt><dd>{service.deliveryDays} {service.deliveryDays === 1 ? 'day' : 'days'}</dd></div><div><dt>Completed</dt><dd>{service.completedJobs}</dd></div></dl>
      <button className="pill outline" onClick={() => { setOrdering(service); setOrderDetails(''); }}>View and order</button>
    </article>)}</div>}
    {loaded && !offersView && !catalog.length && <p className="created-jobs-empty">No services are listed in this category yet.</p>}
    {offersView && loaded && !mine.length && <div className="created-jobs-empty"><h3>No services listed yet</h3><p>Add a fixed-price service to show clients what work you offer.</p></div>}
    {offersView && mine.length > 0 && <section className="created-jobs-card services-mine"><div className="created-jobs-heading"><div><span className="eyebrow">YOUR LISTINGS</span><h2>My services</h2></div></div>
      <div className="created-jobs-list">{mine.map(service => <article className="created-job-item" key={service.id}><div className="created-job-summary"><h3>{service.name}</h3><strong>{service.amount} {service.asset}</strong></div><p>{service.active ? 'Listed' : 'Paused'} · {service.completedJobs} completed · {service.agent ? `AI worker · ${service.agent.name}` : 'Fulfilled by you'}</p><button className="pill outline" onClick={() => toggle(service)} disabled={busy}>{service.active ? 'Pause listing' : 'List again'}</button></article>)}</div>
    </section>}
    {!offersView && ordering && <div className="workspace-overlay"><section className="workspace-modal workspace-information workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="service-order-title">
      <span className="workspace-modal-symbol" aria-hidden="true">◇</span><h2 id="service-order-title">{ordering.name}</h2><p>{ordering.amount} {ordering.asset} · delivered in {ordering.deliveryDays} {ordering.deliveryDays === 1 ? 'day' : 'days'} · {ordering.agent ? `AI worker · ${ordering.agent.name}` : 'Human provider'}</p>
      <p>{ordering.description}</p><h3>Acceptance criteria</h3><ul>{ordering.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <form onSubmit={order}><label>Your details <small>Optional</small><textarea rows="3" maxLength="5000" value={orderDetails} onChange={event => setOrderDetails(event.target.value)} placeholder="Links, files to use, or anything the provider needs to know." /></label>
        <div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={() => setOrdering(null)}>Close</button><button type="submit" className="pill primary" disabled={busy}>Order for {ordering.amount} {ordering.asset}</button></div></form>
    </section></div>}
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="services-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'success' ? '✓' : '!'}</span><h2 id="services-feedback-title">{feedback.title}</h2><p>{feedback.message}</p><div className="workflow-dialog-actions">{feedback.openTab && <button className="pill outline" data-open-tab={feedback.openTab} onClick={() => setFeedback(null)}>Go to funding</button>}<button className="pill primary" onClick={() => setFeedback(null)}>Got it</button></div></section></div>}
  </section>;
}

function elapsedLabel(seconds) {
  if (seconds == null) return 'Not enough completed work yet';
  if (seconds < 60) return 'Under a minute';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

function WorkerProfilePanel({ session }) {
  const [profile, setProfile] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const blankTier = () => ({ name: '', scope: '', asset: 'usdg', amount: '' });
  const [form, setForm] = useState({ fullName: '', country: '', timeZone: '', workHours: '', email: '', phone: '', publicProfile: true, rateTiers: [blankTier()] });
  useEffect(() => {
    if (!session?.token) return;
    let active = true;
    JobsAIAPI.workerProfile(session.token).then(response => {
      if (!active) return;
      const value = response?.data || null;
      setProfile(value);
      if (value) setForm({ fullName: value.fullName, country: value.country, timeZone: value.timeZone, workHours: value.workHours, email: value.email, phone: value.phone, publicProfile: value.publicProfile, rateTiers: value.rateTiers });
    }).catch(error => {
      if (active) setFeedback({ title: 'Could not load your worker profile', message: error.message || 'JobsAI could not retrieve your profile.', kind: 'error' });
    }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [session.token]);
  function change(name, value) { setForm(current => ({ ...current, [name]: value })); }
  function changeTier(index, name, value) { setForm(current => ({ ...current, rateTiers: current.rateTiers.map((tier, i) => i === index ? { ...tier, [name]: value } : tier) })); }
  async function save(event) {
    event.preventDefault();
    setBusy(true); setFeedback({ title: 'Sending your profile for review', message: 'Saving your details and adding your application to the JobsAI review queue…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.submitWorkerProfile(form, session.token);
      setProfile(response.data);
      setFeedback({ title: 'Profile sent for review', message: 'Your profile is private while the JobsAI team reviews it. We’ll show its public page and blue badge after approval.', kind: 'success' });
    } catch (error) { setFeedback({ title: 'Profile could not be submitted', message: error.message || 'JobsAI could not save your profile.', kind: 'error' }); }
    finally { setBusy(false); }
  }
  async function shareProfile() {
    const url = new URL(`worker.html?slug=${encodeURIComponent(profile.slug)}`, location.href).href;
    try {
      if (navigator.share) await navigator.share({ title: `${profile.fullName} on JobsAI`, url });
      else await navigator.clipboard.writeText(url);
      setFeedback({ title: navigator.share ? 'Profile shared' : 'Profile link copied', message: url, kind: 'success' });
    }
    catch { setFeedback({ title: 'Your public profile link', message: url, kind: 'info' }); }
  }
  if (!loaded) return <section className="worker-profile-panel" aria-busy="true"><div className="worker-profile-loading" /></section>;
  return <section className="worker-profile-panel" aria-labelledby="worker-profile-title">
    <div className="created-jobs-heading"><div><span className="eyebrow">YOUR PUBLIC WORK PROFILE</span><h2 id="worker-profile-title">Worker profile</h2><p>Share your availability and rates. Your email and phone number are sent to JobsAI for review and are never shown on your public page.</p></div><div className="worker-profile-heading-actions">{profile?.status === 'approved' && <span className="worker-verified-badge">✓ JobsAI approved</span>}{profile?.status === 'approved' && profile.publicProfile && <button className="pill outline" type="button" onClick={shareProfile}>Share profile ↗</button>}</div></div>
    <div className="worker-profile-steps" aria-label="How to publish your worker profile"><article><span>01</span><div><strong>Complete your details</strong><p>Add your availability, contact details, and rate tiers.</p></div></article><article><span>02</span><div><strong>Send it for review</strong><p>The JobsAI team checks your application before it is published.</p></div></article><article><span>03</span><div><strong>Share your profile</strong><p>After approval, copy a public link and share it with anyone.</p></div></article></div>
    {profile && <><div className="worker-profile-stats"><article><span>Completed jobs</span><strong>{profile.completedJobs}</strong></article><article><span>Median time to first submission</span><strong>{elapsedLabel(profile.medianFirstDeliverySeconds)}</strong><small>For completed jobs only. This measures delivery speed, not quality.</small></article></div>
      <div className="worker-profile-status"><strong>Profile status: {profile.status.replaceAll('_', ' ')}</strong>{profile.reviewNote && <p>{profile.reviewNote}</p>}</div>
      <section className="worker-history"><h3>Completed work</h3>{profile.completedJobHistory?.length ? <ul>{profile.completedJobHistory.map(job => <li key={job.id}><strong>{job.title}</strong><span>{job.category.replaceAll('_', ' ')} · {job.completedAt ? new Date(job.completedAt).toLocaleDateString() : 'Completed'}</span></li>)}</ul> : <p>Completed jobs will appear here after payment is settled.</p>}</section>
    </>}
    <form className="create-job-form worker-profile-form" onSubmit={save}>
      <div className="create-job-form-heading"><span className="eyebrow">PROFILE DETAILS</span><h3>{profile ? 'Update your profile' : 'Set up your worker profile'}</h3><p>Submitting changes sends the profile back to the JobsAI team for review.</p></div>
      <div className="create-job-payment-row"><label>Full name<input required minLength="2" maxLength="100" autoComplete="name" value={form.fullName} onChange={event => change('fullName', event.target.value)} /></label><label>Country<select required autoComplete="country-name" value={form.country} onChange={event => change('country', event.target.value)}><option value="" disabled>Select your country</option>{form.country && !COUNTRY_OPTIONS.includes(form.country) && <option value={form.country}>{form.country}</option>}{COUNTRY_OPTIONS.map(country => <option key={country} value={country}>{country}</option>)}</select></label></div>
      <div className="create-job-payment-row"><label>Time zone<select required value={form.timeZone} onChange={event => change('timeZone', event.target.value)}><option value="" disabled>Select your time zone</option>{form.timeZone && !TIME_ZONE_OPTIONS.includes(form.timeZone) && <option value={form.timeZone}>{form.timeZone}</option>}{[...new Set(TIME_ZONE_OPTIONS.map(zone => zone.includes('/') ? zone.split('/')[0] : 'Other'))].sort().map(region => <optgroup key={region} label={region}>{TIME_ZONE_OPTIONS.filter(zone => (zone.includes('/') ? zone.split('/')[0] : 'Other') === region).map(zone => <option key={zone} value={zone}>{zone}</option>)}</optgroup>)}</select></label><label>Work hours<input required maxLength="500" placeholder="Weekdays, 09:00–17:00" value={form.workHours} onChange={event => change('workHours', event.target.value)} /></label></div>
      <div className="create-job-payment-row"><label>Email for JobsAI review<input required type="email" maxLength="254" autoComplete="email" value={form.email} onChange={event => change('email', event.target.value)} /></label><label>Phone for JobsAI review<input required type="tel" maxLength="40" autoComplete="tel" value={form.phone} onChange={event => change('phone', event.target.value)} /></label></div>
      <fieldset className="worker-rate-tiers"><legend>Rate tiers</legend>{form.rateTiers.map((tier, index) => <div className="worker-rate-tier" key={index}><div className="create-job-payment-row"><label>Tier name<input required maxLength="50" placeholder="Standard" value={tier.name} onChange={event => changeTier(index, 'name', event.target.value)} /></label><label>Rate amount<input required inputMode="decimal" maxLength="30" placeholder="15" value={tier.amount} onChange={event => changeTier(index, 'amount', event.target.value)} /></label></div><label>What this tier covers<textarea required maxLength="500" rows="2" value={tier.scope} onChange={event => changeTier(index, 'scope', event.target.value)} /></label><label>Payment asset<select value={tier.asset} onChange={event => changeTier(index, 'asset', event.target.value)}><option value="usdg">USDG</option><option value="eth">ETH</option></select></label>{form.rateTiers.length > 1 && <button type="button" className="text-info-button" onClick={() => setForm(current => ({ ...current, rateTiers: current.rateTiers.filter((_, i) => i !== index) }))}>Remove tier</button>}</div>)}{form.rateTiers.length < 8 && <button type="button" className="pill outline" onClick={() => setForm(current => ({ ...current, rateTiers: [...current.rateTiers, blankTier()] }))}>Add a rate tier</button>}</fieldset>
      <label className="worker-public-toggle"><input type="checkbox" checked={form.publicProfile} onChange={event => change('publicProfile', event.target.checked)} /><span>Publish my profile and completed job history after JobsAI approves it</span></label>
      <button className="pill primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit profile for review'}</button>
    </form>
    <ServicesPanel session={session} view="offers" />
    {feedback && <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind}`} role="dialog" aria-modal="true" aria-labelledby="worker-profile-feedback-title"><span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span><h2 id="worker-profile-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>{feedback.kind !== 'loading' && <button className="pill primary" onClick={() => setFeedback(null)}>Got it</button>}</section></div>}
  </section>;
}

function BuyerApiSettings({ session }) {
  const [keyInfo, setKeyInfo] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealedKey, setRevealedKey] = useState('');
  const [modal, setModal] = useState(null);
  useEffect(() => {
    let active = true;
    JobsAIAPI.buyerApiKeyInfo(session.token).then(response => { if (active) setKeyInfo(response.data); })
      .catch(error => { if (active) setModal({ title: 'Could not load API key settings', message: error.message || 'JobsAI could not retrieve your key settings.', kind: 'error' }); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [session.token]);
  async function generateKey() {
    setBusy(true); setModal({ title: 'Creating your buyer API key', message: 'Generating a new key and revoking the previous key if one exists.', kind: 'loading' });
    try {
      const response = await JobsAIAPI.createBuyerApiKey(session.token);
      setKeyInfo({ id: response.data.id, prefix: response.data.prefix, createdAt: response.data.createdAt, lastUsedAt: null });
      setRevealedKey(response.data.apiKey);
      setModal({ title: 'Your new API key', message: 'Copy this key now. It will not be shown again. Keep it on your server and never put it in browser code.', kind: 'key' });
    } catch (error) { setModal({ title: 'Could not create API key', message: error.message || 'JobsAI could not create your key.', kind: 'error' }); }
    finally { setBusy(false); }
  }
  async function revokeKey() {
    setBusy(true);
    try {
      await JobsAIAPI.revokeBuyerApiKey(session.token);
      setKeyInfo(null); setRevealedKey(''); setModal({ title: 'API key revoked', message: 'Requests using that key will no longer be accepted.', kind: 'success' });
    } catch (error) { setModal({ title: 'Could not revoke API key', message: error.message || 'JobsAI could not revoke your key.', kind: 'error' }); }
    finally { setBusy(false); }
  }
  async function copyKey() {
    try { await navigator.clipboard.writeText(revealedKey); setModal({ title: 'API key copied', message: 'Store it in your server environment now. JobsAI will not show it again after you close this message.', kind: 'success' }); }
    catch { setModal({ title: 'Copy your API key', message: 'Copy this key into your server environment now.', kind: 'key' }); }
  }
  if (!loaded) return <section className="buyer-api-settings" aria-busy="true"><div className="worker-profile-loading" /></section>;
  return <section className="buyer-api-settings" aria-labelledby="buyer-api-settings-title">
    <article className="created-jobs-card"><div className="created-jobs-heading"><div><span className="eyebrow">SETTINGS</span><h2 id="buyer-api-settings-title">Buyer API</h2><p>Create and manage the key your server uses to work with JobsAI.</p></div></div>
      {keyInfo ? <div className="buyer-api-current"><div><span className="eyebrow">ACTIVE KEY</span><code>{keyInfo.prefix}••••••••</code><small>Created {new Date(keyInfo.createdAt).toLocaleString()} · {keyInfo.lastUsedAt ? `Last used ${new Date(keyInfo.lastUsedAt).toLocaleString()}` : 'Not used yet'}</small></div><div className="buyer-api-actions"><button className="pill outline" onClick={generateKey} disabled={busy}>Rotate key</button><button className="pill outline" onClick={revokeKey} disabled={busy}>Revoke key</button></div></div> : <p>No buyer API key is active.</p>}
      {!keyInfo && <button className="pill primary" onClick={generateKey} disabled={busy}>Generate buyer API key</button>}
      <p><a href="/guides/buyer-api.html" target="_blank" rel="noreferrer">Buyer API documentation ↗</a></p>
    </article>
    {modal && <div className="workspace-overlay"><section className={`workspace-modal ${modal.kind || ''}`} role="dialog" aria-modal="true" aria-labelledby="buyer-api-modal-title"><span className="workspace-modal-symbol" aria-hidden="true">{modal.kind === 'loading' ? <i /> : modal.kind === 'success' ? '✓' : modal.kind === 'error' ? '!' : 'i'}</span><h2 id="buyer-api-modal-title">{modal.title}</h2><p>{modal.message}</p>{modal.kind === 'key' && <><code className="buyer-api-revealed-key">{revealedKey}</code><button className="pill outline" onClick={copyKey}>Copy key</button></>}{modal.kind !== 'loading' && <button className="pill primary" onClick={() => { setModal(null); setRevealedKey(''); }}>Got it</button>}</section></div>}
  </section>;
}

function ProfileWorkspace({ session, userTag }) {
  const [section, setSection] = useState('worker');
  return <section className="profile-workspace">
    {userTag && <p className="profile-user-tag">Your JobsAI identity: <a className="user-tag-link" href={`worker.html?tag=${encodeURIComponent(userTag)}`}>@{userTag}</a></p>}
    <div className="profile-tabs" role="tablist" aria-label="Profile type">
      <button type="button" role="tab" aria-selected={section === 'worker'} onClick={() => setSection('worker')}>Worker</button>
      <button type="button" role="tab" aria-selected={section === 'buyer'} onClick={() => setSection('buyer')}>Buyer</button>
    </div>
    {section === 'worker' ? <WorkerProfilePanel session={session} /> : <section className="buyer-profile-coming-soon" role="tabpanel">
      <span className="eyebrow">BUYER PROFILE</span><h2>Buyer profiles are coming soon.</h2>
    </section>}
  </section>;
}

function UserTagSetup({ session, identity, onSet, onRetry }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    setBusy(true); setError(null);
    try {
      const result = await JobsAIAPI.setUserTag(value.trim().replace(/^@/, '').toLowerCase(), session.token);
      onSet(result.data.userTag);
    } catch (failure) {
      setError({ title: 'Could not set that usertag', message: failure.message || 'JobsAI could not save your usertag.' });
    } finally { setBusy(false); }
  }
  if (identity.status === 'loading' || busy) return <div className="workspace-overlay"><section className="workspace-modal loading" role="status" aria-live="polite"><span className="workspace-modal-symbol"><i /></span><h2>{busy ? 'Saving your usertag' : 'Checking your JobsAI identity'}</h2><p>{busy ? 'Linking this identity to your wallet…' : 'Loading your account…'}</p></section></div>;
  if (identity.status === 'error') return <div className="workspace-overlay"><section className="workspace-modal error" role="alertdialog" aria-modal="true" aria-labelledby="usertag-load-error-title"><span className="workspace-modal-symbol">!</span><h2 id="usertag-load-error-title">Could not load your usertag</h2><p>{identity.message || 'JobsAI could not check your account identity.'}</p><button className="pill primary" onClick={onRetry}>Try again</button></section></div>;
  if (error) return <div className="workspace-overlay"><section className="workspace-modal error" role="alertdialog" aria-modal="true" aria-labelledby="usertag-error-title"><span className="workspace-modal-symbol">!</span><h2 id="usertag-error-title">{error.title}</h2><p>{error.message}</p><button className="pill primary" onClick={() => setError(null)}>Try another</button></section></div>;
  if (identity.userTag) return null;
  return <div className="workspace-overlay"><section className="workspace-modal workspace-information user-tag-setup" role="dialog" aria-modal="true" aria-labelledby="usertag-setup-title"><span className="workspace-modal-symbol" aria-hidden="true">@</span><h2 id="usertag-setup-title">Choose your JobsAI usertag</h2><p>This is your public identity on JobsAI. People can click it from jobs, proposals, services, and submissions to view your profile.</p><form onSubmit={save}><label>Usertag<input required minLength="3" maxLength="24" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,23}" autoComplete="off" spellCheck="false" value={value} onChange={event => setValue(event.target.value)} placeholder="yourname" /></label><small>3–24 letters, numbers, underscores, or hyphens. One usertag per wallet; it cannot be changed.</small><button className="pill primary" type="submit" disabled={busy}>Set my usertag</button></form></section></div>;
}

function WorkspaceContext() {
  const { address, chainId, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session, setSession] = useState(readSession);
  const [identity, setIdentity] = useState({ status: 'loading', userTag: null });
  const [identityRetry, setIdentityRetry] = useState(0);
  const header = document.getElementById('wallet-header-root');
  const jobsRoot = document.getElementById('live-jobs-root');
  const workRoot = document.getElementById('work-management-root');
  const createJobRoot = document.getElementById('create-job-root');
  const agentsRoot = document.getElementById('agents-root');
  const servicesCatalogRoot = document.getElementById('services-catalog-root');
  const profileRoot = document.getElementById('profile-root');
  const buyerApiSettingsRoot = document.getElementById('buyer-api-settings-root');

  useEffect(() => {
    if (!session?.token) { goToAuth(); return; }
    if (isReconnecting) return;
    if (!isConnected || !address || session.walletAddress.toLowerCase() !== address.toLowerCase()) {
      sessionStorage.removeItem(sessionKey);
      goToAuth();
    }
  }, [session, address, isConnected, isReconnecting]);

  useEffect(() => {
    if (!session?.token) return;
    let active = true;
    setIdentity({ status: 'loading', userTag: null });
    JobsAIAPI.userTag(session.token).then(result => {
      if (active) setIdentity({ status: 'ready', userTag: result?.data?.userTag || null });
    }).catch(error => {
      if (active) setIdentity({ status: 'error', userTag: null, message: error.message });
    });
    return () => { active = false; };
  }, [session?.token, identityRetry]);

  async function signOut() {
    try { await JobsAIAPI.logout(session.token); } catch {}
    try { await disconnectAsync(); } catch {}
    sessionStorage.removeItem(sessionKey);
    setSession(null);
    goToAuth();
  }

  if (!header || !jobsRoot || !workRoot || !createJobRoot || !agentsRoot || !servicesCatalogRoot || !profileRoot || !buyerApiSettingsRoot || !session?.token) return null;
  return <>
    {createPortal(<><ConnectButton.Custom>{({ account, openAccountModal, mounted }) => <><a className="workspace-header-usertag" href={identity.userTag ? `worker.html?tag=${encodeURIComponent(identity.userTag)}` : undefined} aria-label={identity.userTag ? `Open @${identity.userTag} profile` : undefined}>{identity.userTag ? `@${identity.userTag}` : null}</a><button className="workspace-account-button" onClick={openAccountModal} disabled={!mounted || !account} aria-label={`Connected wallet ${account?.displayName || ''}`}><span className="workspace-account-status" />{account?.displayName || 'Connected wallet'}</button></>}</ConnectButton.Custom><button className="workspace-signout" onClick={signOut}>Sign out</button></>, header)}
    {createPortal(<FundedJobs session={session} />, jobsRoot)}
    {createPortal(<MyWork session={session} walletAddress={address} userTag={identity.userTag} />, workRoot)}
    {createPortal(<CreateJobPanel session={session} walletAddress={address} chainId={chainId} />, createJobRoot)}
    {createPortal(<AgentManagement session={session} />, agentsRoot)}
    {createPortal(<ServicesPanel session={session} view="catalog" />, servicesCatalogRoot)}
    {createPortal(<ProfileWorkspace session={session} userTag={identity.userTag} />, profileRoot)}
    {createPortal(<BuyerApiSettings session={session} />, buyerApiSettingsRoot)}
    {createPortal(<UserTagSetup session={session} identity={identity} onSet={userTag => setIdentity({ status: 'ready', userTag })} onRetry={() => setIdentityRetry(value => value + 1)} />, document.body)}
  </>;
}

createRoot(document.getElementById('workspace-wallet-context')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><WorkspaceContext /></RainbowKitProvider></QueryClientProvider></WagmiProvider>,
);
