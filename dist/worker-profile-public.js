(() => {
  const root = document.querySelector('#worker-public-root');
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const params = new URLSearchParams(location.search);
  const routeSlug = location.pathname.match(/^\/u\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/)?.[1];
  const slug = routeSlug || params.get('slug');
  const tag = params.get('tag');
  const loadProfile = slug
    ? JobsAIAPI.publicWorkerProfile(slug).then(({ data }) => renderProfile(data, data.userTag))
    : tag
      ? JobsAIAPI.publicUserTag(tag).then(async ({ data: identity }) => identity.workerProfileSlug
        ? renderProfile((await JobsAIAPI.publicWorkerProfile(identity.workerProfileSlug)).data, identity.userTag)
        : renderBasicIdentity(identity))
      : Promise.reject(new Error('Open a profile link from JobsAI.'));
  loadProfile.catch(error => {
    const card = el('section', undefined, 'worker-public-card');
    card.append(el('span', 'JOBS AI PROFILE', 'eyebrow'), el('h1', 'Profile not found'), el('p', error.message || 'This profile may be private or awaiting review.'));
    root.replaceChildren(card);
  });

  function renderProfile(profile, userTag) {
    document.title = `${profile.fullName} · JobsAI worker`;
    const card = el('section', undefined, 'worker-public-card');
    const banner = el('div', undefined, 'worker-public-banner');
    if (profile.bannerUrl) { const image = el('img'); image.src = profile.bannerUrl; image.alt = ''; banner.append(image); }
    const content = el('div', undefined, 'worker-public-content');
    const profileRow = el('header', undefined, 'worker-public-profile-row');
    const avatar = el('div', undefined, 'worker-public-avatar');
    const avatarImage = el('img'); avatarImage.src = profile.avatarUrl || 'assets/jobsai-approved-mark.svg'; avatarImage.alt = `${profile.fullName} profile photo`; avatar.append(avatarImage);
    const heading = el('div', undefined, 'worker-public-heading');
    const identity = el('div', undefined, 'worker-public-identity');
    const nameLine = el('div', undefined, 'worker-public-name-line');
    nameLine.append(el('h1', profile.fullName));
    if (profile.verified) {
      const seal = el('span', undefined, 'worker-verification-seal');
      seal.setAttribute('role', 'img'); seal.setAttribute('aria-label', 'JobsAI approved');
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      check.setAttribute('viewBox', '0 0 24 24'); check.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm5 12.5 4.5 4.5L19 7.5');
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '3'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
      check.append(path); seal.append(check);
      nameLine.append(seal);
    }
    if (userTag) nameLine.append(el('span', `@${userTag}`, 'worker-user-tag'));
    identity.append(nameLine);
    heading.append(identity);
    profileRow.append(avatar, heading);
    const details = el('dl', undefined, 'worker-public-details');
    for (const [label, value] of [['Location', `${profile.country} · ${profile.timeZone}`], ['Working hours', profile.workHours]]) {
      const detail = el('div'); detail.append(el('dt', label), el('dd', value)); details.append(detail);
    }
    content.append(profileRow, details);
    if (userTag) {
      const actions = el('div', undefined, 'worker-public-message-actions');
      const message = el('a', 'Message this worker', 'pill primary');
      message.href = `workspace.html?tab=messages&to=${encodeURIComponent(userTag)}&role=buyer`;
      actions.append(message);
      content.append(actions);
    }
    const stats = el('div', undefined, 'worker-profile-stats');
    const jobs = el('article', undefined, 'worker-stat-jobs'); jobs.append(el('span', 'Completed jobs'), el('strong', String(profile.completedJobs)));
    const speed = el('article', undefined, 'worker-stat-speed'); speed.append(el('span', 'Median time to first submission'), el('strong', duration(profile.medianFirstDeliverySeconds)), el('small', 'Across completed jobs · delivery speed, not quality'));
    stats.append(jobs, speed); content.append(stats);
    const rateSection = el('section', undefined, 'worker-public-section');
    rateSection.append(el('h2', 'Rates'));
    const rates = el('div', undefined, 'worker-public-rates');
    for (const tier of profile.rateTiers || []) {
      const item = el('article', undefined, 'worker-public-rate'); item.append(el('h3', tier.name), el('p', tier.scope), el('strong', `${tier.amount} ${tier.asset.toUpperCase()}`)); rates.append(item);
    }
    rateSection.append(rates); content.append(rateSection);
    const historySection = el('section', undefined, 'worker-public-section');
    historySection.append(el('h2', 'Completed work'));
    if (profile.completedJobHistory?.length) {
      const list = el('ul', undefined, 'worker-public-history');
      for (const job of profile.completedJobHistory) {
        const item = el('li'); item.append(el('strong', job.title), el('span', `${job.category.replaceAll('_', ' ')} · ${new Date(job.completedAt).toLocaleDateString()}`)); list.append(item);
      }
      historySection.append(list);
    } else historySection.append(el('p', 'Completed work will appear here after a job is settled.'));
    content.append(historySection);
    card.append(banner, content);
    root.replaceChildren(card);
  }

  function renderBasicIdentity(identity) {
    document.title = `@${identity.userTag} · JobsAI`;
    const card = el('section', undefined, 'worker-public-card');
    card.append(el('span', 'JOBS AI PROFILE', 'eyebrow'), el('h1', `@${identity.userTag}`), el('p', 'This wallet has a JobsAI usertag. Its public worker profile is not available yet. Buyer profiles are coming soon.'));
    root.replaceChildren(card);
  }
  function duration(seconds) {
    if (seconds == null) return 'Not enough completed work yet';
    if (seconds < 60) return 'Under a minute';
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hours`;
    return `${(seconds / 86400).toFixed(1)} days`;
  }
})();
