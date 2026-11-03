(() => {
  const root = document.querySelector('#worker-admin-root');
  const dialog = document.querySelector('#worker-admin-dialog');
  const title = document.querySelector('#worker-admin-dialog-title');
  const message = document.querySelector('#worker-admin-dialog-message');
  const noteWrap = document.querySelector('#worker-admin-note-wrap');
  const note = document.querySelector('#worker-admin-note');
  const confirm = document.querySelector('#worker-admin-confirm');
  const signout = document.querySelector('#worker-admin-signout');
  const sessionKey = 'jobsai-wallet-session-v1';
  let session = readSession();
  let decision = null;
  let selected = null;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  function readSession() {
    try { const value = JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); return value && typeof value.token === 'string' ? value : null; }
    catch { return null; }
  }
  function feedback(heading, copy, kind = 'info') {
    title.textContent = heading; message.textContent = copy;
    document.querySelector('#worker-admin-symbol').textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
    noteWrap.hidden = true; confirm.hidden = true;
    if (!dialog.open) dialog.showModal();
  }
  function renderSignIn() {
    root.replaceChildren();
    const card = el('section', undefined, 'worker-admin-card');
    card.append(el('span', 'ADMIN', 'eyebrow'), el('h1', 'Sign in to JobsAI'), el('p', 'Sign in with an admin wallet to manage worker reviews and admin access.'));
    const link = el('a', 'Sign in with your wallet', 'pill primary'); link.href = '/auth.html?next=admin.html';
    card.append(link); root.append(card);
  }
  function renderDenied() {
    root.replaceChildren();
    const card = el('section', undefined, 'worker-admin-card');
    card.append(el('span', 'ADMIN', 'eyebrow'), el('h1', 'Admin access required'), el('p', 'This JobsAI account does not have admin access.'));
    const link = el('a', 'Return to JobsAI', 'pill primary'); link.href = '/workspace.html';
    card.append(link); root.append(card);
  }
  function renderAdminList(users) {
    const section = el('section', undefined, 'worker-admin-card');
    section.append(el('span', 'ACCESS', 'eyebrow'), el('h2', 'Admins'), el('p', 'Add an existing JobsAI account by usertag.'));
    const form = el('form', undefined, 'worker-admin-login');
    const label = el('label', 'Usertag');
    const input = el('input'); input.name = 'userTag'; input.required = true; input.minLength = 3; input.maxLength = 24; input.pattern = '@?[A-Za-z0-9][A-Za-z0-9_-]{2,23}'; input.placeholder = '@usertag';
    label.append(input);
    const add = el('button', 'Add admin', 'pill primary'); add.type = 'submit';
    form.append(label, add);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const userTag = input.value.trim().replace(/^@/, '').toLowerCase();
      add.disabled = true;
      try { await JobsAIAPI.addAdmin(userTag, session.token); await loadAll(); feedback('Admin added', `@${userTag} can now access the JobsAI admin page.`, 'success'); }
      catch (error) { feedback('Could not add admin', error.message || 'JobsAI could not update admin access.', 'error'); }
      finally { add.disabled = false; }
    });
    section.append(form);
    const list = el('div', undefined, 'worker-admin-list');
    if (!users.length) section.append(el('p', 'No admin accounts were returned.'));
    users.forEach(user => {
      const card = el('article', undefined, 'worker-admin-card');
      card.append(el('h3', user.userTag ? `@${user.userTag}` : user.walletAddress), el('p', user.walletAddress));
      if (user.userTag !== 'adminmachine') {
        const remove = el('button', 'Remove admin access', 'pill outline'); remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!window.confirm(`Remove admin access from @${user.userTag}?`)) return;
          remove.disabled = true;
          try { await JobsAIAPI.removeAdmin(user.userTag, session.token); await loadAll(); feedback('Admin access removed', `@${user.userTag} no longer has admin access.`, 'success'); }
          catch (error) { feedback('Could not remove admin', error.message || 'JobsAI could not update admin access.', 'error'); }
          finally { remove.disabled = false; }
        });
        card.append(remove);
      } else card.append(el('span', 'Initial admin', 'worker-verified-badge'));
      list.append(card);
    });
    section.append(list); return section;
  }
  function renderQueue(profiles) {
    const section = el('section', undefined, 'worker-admin-card');
    const heading = el('div', undefined, 'worker-admin-title');
    const text = el('div');
    text.append(el('span', 'WORKER PROFILES', 'eyebrow'), el('h2', 'Applications'), el('p', `${profiles.length} profile${profiles.length === 1 ? '' : 's'} waiting for review.`));
    const refresh = el('button', 'Refresh', 'pill outline'); refresh.type = 'button'; refresh.addEventListener('click', loadAll);
    heading.append(text, refresh); section.append(heading);
    if (!profiles.length) { section.append(el('p', 'There are no worker applications waiting for review.')); return section; }
    const list = el('div', undefined, 'worker-admin-list');
    for (const profile of profiles) {
      const card = el('article', undefined, 'worker-admin-card');
      card.append(el('span', profile.status.replaceAll('_', ' '), 'eyebrow'), el('h3', profile.fullName), el('p', `${profile.userTag ? `@${profile.userTag} · ` : ''}${profile.country} · ${profile.timeZone} · ${profile.workHours}`));
      const contact = el('dl', undefined, 'worker-admin-contact');
      for (const [key, value] of [['Email', profile.email], ['Phone', profile.phone], ['Rate tiers', null]]) {
        const row = el('div'); row.append(el('dt', key));
        if (value) row.append(el('dd', value));
        if (key === 'Rate tiers') {
          const tiers = el('dd');
          for (const tier of profile.rateTiers || []) tiers.append(el('p', `${tier.name} · ${tier.amount} ${tier.asset.toUpperCase()} · ${tier.scope}`));
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
    section.append(list); return section;
  }
  async function loadAll() {
    root.replaceChildren();
    const status = await JobsAIAPI.adminStatus(session.token);
    if (!status?.data?.isAdmin) { renderDenied(); return; }
    signout.hidden = false;
    root.append(el('div', 'Loading admin workspace…', 'worker-admin-card'));
    try {
      const [usersResult, applicationsResult] = await Promise.all([
        JobsAIAPI.adminUsers(session.token), JobsAIAPI.workerApplications(session.token),
      ]);
      root.replaceChildren();
      const heading = el('div', undefined, 'worker-admin-title');
      heading.append(el('div', undefined));
      heading.firstChild.append(el('span', 'JOBSAI ADMIN', 'eyebrow'), el('h1', 'Admin'), el('p', 'Manage worker applications and admin access.'));
      root.append(heading, renderAdminList(usersResult.data || []), renderQueue(applicationsResult.data || []));
    } catch (error) {
      root.replaceChildren();
      const card = el('section', undefined, 'worker-admin-card');
      card.append(el('h1', 'Could not load admin tools'), el('p', error.message || 'JobsAI could not load this page.'));
      const retry = el('button', 'Try again', 'pill primary'); retry.addEventListener('click', loadAll); card.append(retry); root.append(card);
    }
  }
  function review(profile, value) {
    selected = profile; decision = value; note.value = '';
    title.textContent = value === 'approved' ? `Approve ${profile.fullName}?` : value === 'rejected' ? `Reject ${profile.fullName}?` : `Request changes from ${profile.fullName}?`;
    message.textContent = value === 'approved' ? 'The profile becomes public if the worker chose public visibility and receives a blue JobsAI approved badge.' : 'The worker will see your note and can update and resubmit their profile.';
    document.querySelector('#worker-admin-symbol').textContent = 'i';
    noteWrap.hidden = value === 'approved'; confirm.hidden = false; confirm.disabled = false;
    confirm.textContent = value === 'approved' ? 'Approve profile' : value === 'rejected' ? 'Reject application' : 'Request changes';
    dialog.showModal();
  }
  confirm.addEventListener('click', async event => {
    event.preventDefault();
    if (!selected || !decision) return;
    if (decision !== 'approved' && note.value.trim().length < 5) { message.textContent = 'Enter a review note of at least five characters.'; return; }
    confirm.disabled = true;
    try { await JobsAIAPI.reviewWorkerApplication(selected.id, decision, note.value.trim(), session.token); dialog.close(); await loadAll(); }
    catch (error) { feedback('Review could not be saved', error.message || 'JobsAI could not record this decision.', 'error'); }
    finally { confirm.disabled = false; selected = null; decision = null; }
  });
  document.querySelector('#worker-admin-cancel').addEventListener('click', () => { selected = null; decision = null; });
  signout.addEventListener('click', async () => {
    await JobsAIAPI.logout(session.token).catch(() => {});
    sessionStorage.removeItem(sessionKey);
    location.replace('/auth.html?next=admin.html');
  });
  if (!session) renderSignIn();
  else loadAll().catch(error => { root.replaceChildren(); feedback('Could not open admin', error.message || 'Try again.', 'error'); });
})();
