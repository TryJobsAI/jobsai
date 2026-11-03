(() => {
  const root = document.querySelector('#worker-admin-root');
  const dialog = document.querySelector('#worker-admin-dialog');
  const title = document.querySelector('#worker-admin-dialog-title');
  const message = document.querySelector('#worker-admin-dialog-message');
  const noteWrap = document.querySelector('#worker-admin-note-wrap');
  const note = document.querySelector('#worker-admin-note');
  const confirm = document.querySelector('#worker-admin-confirm');
  const signout = document.querySelector('#worker-admin-signout');
  let decision = null;
  let selected = null;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  function feedback(heading, copy, kind = 'info') {
    title.textContent = heading; message.textContent = copy;
    document.querySelector('#worker-admin-symbol').textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
    noteWrap.hidden = true; confirm.hidden = true; dialog.showModal();
  }
  async function loadQueue() {
    root.replaceChildren(); feedback('Loading applications', 'Getting worker profiles waiting for review…', 'loading');
    try {
      const response = await JobsAIAPI.workerApplications();
      dialog.close(); renderQueue(response.data || []);
    } catch (error) {
      dialog.close();
      if (error.code === 'master_password_required') renderLogin();
      else feedback('Could not load applications', error.message || 'JobsAI could not load the review queue.', 'error');
    }
  }
  function renderLogin() {
    root.replaceChildren();
    const card = el('section', undefined, 'worker-admin-card');
    card.append(el('span', 'PRIVATE JOBSAI TEAM AREA', 'eyebrow'), el('h1', 'Worker applications'), el('p', 'Enter the master password to review worker profiles and approve public listings.'));
    const form = el('form', undefined, 'worker-admin-login');
    const label = el('label', 'Master password');
    const password = el('input'); password.type = 'password'; password.autocomplete = 'current-password'; password.required = true; label.append(password);
    const button = el('button', 'Open review queue', 'pill primary'); button.type = 'submit';
    form.append(label, button); form.addEventListener('submit', async event => {
      event.preventDefault(); button.disabled = true;
      try { await JobsAIAPI.masterLogin(password.value); password.value = ''; signout.hidden = false; await loadQueue(); }
      catch (error) { feedback('Sign-in failed', error.message || 'The master password was not accepted.', 'error'); }
      finally { button.disabled = false; }
    });
    card.append(form); root.append(card);
  }
  function renderQueue(profiles) {
    root.replaceChildren(); signout.hidden = false;
    const heading = el('div', undefined, 'worker-admin-title');
    heading.append(el('div', undefined), el('button', 'Refresh queue', 'pill outline'));
    heading.firstChild.append(el('span', 'PRIVATE JOBSAI TEAM AREA', 'eyebrow'), el('h1', 'Worker applications'), el('p', `${profiles.length} profile${profiles.length === 1 ? '' : 's'} awaiting review.`));
    heading.lastChild.addEventListener('click', loadQueue); root.append(heading);
    if (!profiles.length) { root.append(el('section', 'There are no worker applications waiting for review.', 'worker-admin-card')); return; }
    const list = el('div', undefined, 'worker-admin-list');
    for (const profile of profiles) {
      const card = el('article', undefined, 'worker-admin-card');
      card.append(el('span', profile.status.replaceAll('_', ' '), 'eyebrow'), el('h2', profile.fullName), el('p', `${profile.country} · ${profile.timeZone} · ${profile.workHours}`));
      const contact = el('dl', undefined, 'worker-admin-contact');
      for (const [key, value] of [['Email', profile.email], ['Phone', profile.phone], ['Rate tiers', null]]) {
        const row = el('div'); row.append(el('dt', key));
        if (value) row.append(el('dd', value));
        if (key === 'Rate tiers') {
          const tiers = el('dd');
          for (const tier of profile.rateTiers || []) tiers.append(el('p', `${tier.name} · ${tier.amount} ${tier.asset.toUpperCase()} — ${tier.scope}`));
          row.append(tiers);
        }
        contact.append(row);
      }
      card.append(contact);
      const actions = el('div', undefined, 'worker-admin-actions');
      for (const [label, value] of [['Approve profile', 'approved'], ['Request changes', 'changes_requested'], ['Reject', 'rejected']]) {
        const button = el('button', label, value === 'approved' ? 'pill primary' : 'pill outline'); button.type = 'button';
        button.addEventListener('click', () => review(profile, value)); actions.append(button);
      }
      card.append(actions); list.append(card);
    }
    root.append(list);
  }
  function review(profile, value) {
    selected = profile; decision = value; note.value = '';
    title.textContent = value === 'approved' ? `Approve ${profile.fullName}?` : value === 'rejected' ? `Reject ${profile.fullName}?` : `Request changes from ${profile.fullName}?`;
    message.textContent = value === 'approved' ? 'The profile becomes publicly viewable if the worker selected public visibility. It will receive a blue JobsAI approved badge.' : 'The worker will see this note and can update and resubmit their profile.';
    noteWrap.hidden = value === 'approved'; confirm.hidden = false; confirm.textContent = value === 'approved' ? 'Approve profile' : value === 'rejected' ? 'Reject application' : 'Request changes';
    dialog.showModal();
  }
  confirm.addEventListener('click', async event => {
    event.preventDefault();
    if (!selected || !decision) return;
    if (decision !== 'approved' && note.value.trim().length < 5) { message.textContent = 'Enter a review note of at least five characters.'; return; }
    confirm.disabled = true;
    try { await JobsAIAPI.reviewWorkerApplication(selected.id, decision, note.value.trim()); dialog.close(); await loadQueue(); }
    catch (error) { feedback('Review could not be saved', error.message || 'JobsAI could not record this decision.', 'error'); }
    finally { confirm.disabled = false; selected = null; decision = null; }
  });
  signout.addEventListener('click', async () => { await JobsAIAPI.masterLogout().catch(() => {}); signout.hidden = true; renderLogin(); });
  document.querySelector('#worker-admin-cancel').addEventListener('click', () => { selected = null; decision = null; });
  JobsAIAPI.masterStatus().then(loadQueue).catch(error => error.code === 'master_password_required' ? renderLogin() : feedback('Could not open review queue', error.message || 'Try again.', 'error'));
})();
