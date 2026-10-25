import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, useAccount, useDisconnect } from 'wagmi';
import { JobsAIAPI, queryClient, readSession, sessionKey, walletConfig } from './wallet-config.jsx';
import './wallet-app.css';

function safeEvidenceUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function Feedback({ feedback, onClose }) {
  if (!feedback) return null;
  return <div className="workspace-overlay"><section className={`workspace-modal ${feedback.kind || ''}`} role="dialog" aria-modal="true" aria-labelledby="team-feedback-title">
    <span className="workspace-modal-symbol" aria-hidden="true">{feedback.kind === 'loading' ? <i /> : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span>
    <h2 id="team-feedback-title">{feedback.title}</h2><p>{feedback.message}</p>
    {feedback.kind !== 'loading' && <button className="pill primary" onClick={onClose}>Got it</button>}
  </section></div>;
}

function TeamReview() {
  const { address, isConnected, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [session] = useState(readSession);
  const [password, setPassword] = useState('');
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [disputes, setDisputes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [resolution, setResolution] = useState(null);
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    if (isReconnecting) return;
    if (!session?.token || !isConnected || !address || session.walletAddress.toLowerCase() !== address.toLowerCase()) {
      location.replace(`auth.html?next=${encodeURIComponent('team.html')}`);
    }
  }, [address, isConnected, isReconnecting, session]);

  async function loadDisputes(token = session?.token, keepSelection = false) {
    setFeedback({ title: 'Loading disputes', message: 'Retrieving the team review queue…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.teamDisputes(token);
      const rows = Array.isArray(response?.data) ? response.data : [];
      setDisputes(rows);
      if (!keepSelection) { setSelected(null); setDetail(null); }
      setFeedback(rows.length ? null : { title: 'No open disputes', message: 'New disputes will appear here with the job history and evidence for team review.', kind: 'info' });
      return rows;
    } catch (error) {
      setFeedback({ title: 'Could not load disputes', message: error.message || 'JobsAI could not retrieve the review queue.', kind: 'error' });
      return [];
    }
  }

  useEffect(() => {
    if (!session?.token || !isConnected || !address || session.walletAddress.toLowerCase() !== address.toLowerCase()) return;
    let active = true;
    setChecking(true);
    JobsAIAPI.teamStatus(session.token).then(async () => {
      if (!active) return;
      setVerified(true);
      await loadDisputes(session.token);
    }).catch(error => {
      if (!active) return;
      setVerified(false);
      if (error.code !== 'team_password_required')
        setFeedback({ title: 'Team access unavailable', message: error.message || 'Could not verify team access. Check this wallet is authorized for team review.', kind: 'error' });
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [address, isConnected, session]);

  async function signIn(event) {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setFeedback({ title: 'Checking team access', message: 'Verifying the team password…', kind: 'loading' });
    try {
      await JobsAIAPI.teamLogin(password, session.token);
      setPassword('');
      setVerified(true);
      setFeedback(null);
      await loadDisputes();
    } catch (error) {
      setFeedback({ title: 'Team sign-in failed', message: error.message || 'The team password could not be verified.', kind: 'error' });
    } finally { setBusy(false); }
  }

  async function openDispute(job) {
    setSelected(job.id);
    setFeedback({ title: 'Loading dispute record', message: 'Opening the job brief, submissions, revisions, and event history…', kind: 'loading' });
    try {
      const response = await JobsAIAPI.teamDispute(job.id, session.token);
      setDetail(response.data);
      setFeedback(null);
    } catch (error) {
      setSelected(null);
      setFeedback({ title: 'Could not open dispute', message: error.message || 'JobsAI could not retrieve this dispute record.', kind: 'error' });
    }
  }

  async function resolveDispute(event) {
    event.preventDefault();
    if (!detail || !resolution || !note.trim()) return;
    setBusy(true);
    setFeedback({ title: 'Recording team decision', message: 'Saving the decision and starting the selected escrow settlement…', kind: 'loading' });
    try {
      await JobsAIAPI.resolveTeamDispute(detail.job.id, resolution, note.trim(), session.token);
      setResolution(null);
      setNote('');
      setDetail(null);
      setSelected(null);
      const remaining = await JobsAIAPI.teamDisputes(session.token);
      setDisputes(Array.isArray(remaining?.data) ? remaining.data : []);
      setFeedback({ title: 'Decision recorded', message: resolution === 'pay_doer' ? 'Payment to the worker has been queued for settlement.' : 'A refund to the client has been queued for settlement.', kind: 'success' });
    } catch (error) {
      setFeedback({ title: 'Decision could not be recorded', message: error.message || 'JobsAI could not save this team decision.', kind: 'error' });
    } finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try { await JobsAIAPI.teamLogout(session.token); } catch {}
    try { await JobsAIAPI.logout(session.token); } catch {}
    sessionStorage.removeItem(sessionKey);
    try { await disconnectAsync(); } catch {}
    location.replace('auth.html?next=team.html');
  }

  if (isReconnecting || checking || !session?.token || !isConnected || !address || session.walletAddress.toLowerCase() !== address.toLowerCase()) {
    return <main className="team-review-page"><section className="team-review-loading"><span className="workspace-modal-symbol"><i /></span><h1>Opening team review</h1></section></main>;
  }

  return <main className="team-review-page">
    <header className="team-review-header">
      <a className="jobsai-auth-brand" href="index.html"><img src="assets/jobsai-approved-mark.svg" alt="" width="34" height="40" />JobsAI</a>
      <div className="team-review-header-actions"><span className="team-wallet-label">{address.slice(0, 6)}…{address.slice(-4)}</span><button className="pill outline" onClick={signOut} disabled={busy}>Sign out</button></div>
    </header>

    {!verified ? <section className="team-password-card" aria-labelledby="team-password-title">
      <span className="eyebrow">AUTHORIZED REVIEWERS</span><h1 id="team-password-title">Team dispute review</h1>
      <p>Connect with an authorized team wallet and enter the team password to open the review queue.</p>
      <form onSubmit={signIn}><label htmlFor="team-password">Team password</label><input id="team-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /><button className="pill primary" disabled={busy || !password}>{busy ? 'Checking…' : 'Open review queue'}</button></form>
    </section> : <>
      <section className="team-review-title"><div><span className="eyebrow">PRIVATE TEAM WORKSPACE</span><h1>Dispute review</h1><p>Review the job record and choose the settlement outcome.</p></div><button className="pill outline" onClick={() => loadDisputes(session.token, true)} disabled={busy}>Refresh queue</button></section>
      <div className="team-review-layout">
        <aside className="team-dispute-queue" aria-label="Open disputes">
          <div className="team-queue-heading"><h2>Open disputes</h2><span>{disputes.length}</span></div>
          {disputes.map(job => <button className={`team-dispute-item${selected === job.id ? ' selected' : ''}`} key={job.id} onClick={() => openDispute(job)}>
            <span className="team-dispute-item-title">{job.title}</span><span className="team-dispute-item-meta">{job.amount} {job.asset} · {job.status.replaceAll('_', ' ')}</span>
          </button>)}
        </aside>
        <section className="team-dispute-record" aria-live="polite">
          {!detail ? <div className="team-record-placeholder"><span className="eyebrow">REVIEW RECORD</span><h2>Select a dispute</h2><p>Each record includes the original brief, acceptance criteria, dispute reason, submissions, revision history, and event log.</p></div> : <>
            <div className="team-record-heading"><div><span className="eyebrow">DISPUTED JOB · {detail.job.amount} {detail.job.asset}</span><h2>{detail.job.title}</h2></div><span className="team-record-status">{detail.job.status.replaceAll('_', ' ')}</span></div>
            <section className="team-record-section"><h3>Participants</h3><p><strong>Client wallet</strong><br /><code>{detail.job.clientWallet}</code></p><p><strong>Worker wallet</strong><br /><code>{detail.job.doerWallet || 'No worker assigned'}</code></p></section>
            <section className="team-record-section"><h3>Job brief</h3><p>{detail.job.description}</p><h4>Acceptance criteria</h4><ul>{detail.job.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul></section>
            <section className="team-record-section"><h3>Dispute reason</h3><p>{detail.dispute.reason}</p><small>Opened {new Date(detail.dispute.createdAt).toLocaleString()}</small></section>
            <section className="team-record-section"><h3>Submissions</h3>{detail.submissions.map(item => <article className="team-submission" key={item.id}><h4>Version {item.revision}</h4><p><strong>Summary</strong><br />{item.summary}</p><p><strong>Deliverable</strong><br />{item.deliverable}</p>{item.evidence?.length > 0 && <ul>{item.evidence.map(link => { const safeUrl = safeEvidenceUrl(link); return <li key={link}>{safeUrl ? <a href={safeUrl} target="_blank" rel="noopener noreferrer">{link}</a> : link}</li>; })}</ul>}</article>)}</section>
            <section className="team-record-section"><h3>Revision requests</h3>{detail.revisions.length ? detail.revisions.map(item => <article className="team-revision" key={item.id}><strong>After version {item.revision}</strong><p>{item.feedback}</p></article>) : <p>No revision requests recorded.</p>}</section>
            <section className="team-record-section"><h3>Event history</h3><ol className="team-event-list">{detail.events.map((event, index) => <li key={`${event.event_type}-${index}`}><div><strong>{event.event_type.replaceAll('.', ' ').replaceAll('_', ' ')}</strong>{event.details && Object.keys(event.details).length > 0 && <code>{JSON.stringify(event.details)}</code>}</div><time>{new Date(event.created_at).toLocaleString()}</time></li>)}</ol></section>
            <div className="team-resolution-actions"><button className="pill outline" onClick={() => { setResolution('refund_client'); setNote(''); }}>Refund client</button><button className="pill primary" onClick={() => { setResolution('pay_doer'); setNote(''); }}>Pay worker</button></div>
          </>}
        </section>
      </div>
    </>}

    {resolution && <div className="workspace-overlay"><section className="workspace-modal workspace-information team-resolution-modal" role="dialog" aria-modal="true" aria-labelledby="team-resolution-title">
      <span className="workspace-modal-symbol" aria-hidden="true">?</span><h2 id="team-resolution-title">{resolution === 'pay_doer' ? 'Pay the worker?' : 'Refund the client?'}</h2><p>This records the team decision and queues settlement of the job’s listed principal.</p>
      <form onSubmit={resolveDispute}><label htmlFor="team-resolution-note">Decision note</label><textarea id="team-resolution-note" value={note} onChange={event => setNote(event.target.value)} maxLength={10000} rows={5} required /><div className="workflow-dialog-actions"><button type="button" className="pill outline" onClick={() => setResolution(null)} disabled={busy}>Back</button><button type="submit" className="pill primary" disabled={busy || !note.trim()}>{busy ? 'Saving…' : 'Confirm decision'}</button></div></form>
    </section></div>}
    <Feedback feedback={feedback} onClose={() => setFeedback(null)} />
  </main>;
}

createRoot(document.getElementById('jobsai-team-root')).render(
  <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><TeamReview /></QueryClientProvider></WagmiProvider>,
);
