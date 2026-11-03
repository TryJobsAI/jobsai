(() => {
  const root = document.querySelector('#worker-public-root');
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const params = new URLSearchParams(location.search);
  const slug = params.get('slug');
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
    const heading = el('div', undefined, 'worker-public-heading');
    const eyebrow = el('span', 'JOBS AI WORKER', 'eyebrow');
    const title = el('h1', profile.fullName);
    heading.append(eyebrow, title);
    if (userTag) heading.append(el('span', `@${userTag}`, 'worker-user-tag'));
    if (profile.verified) heading.append(el('span', '✓ JobsAI approved', 'worker-verified-badge'));
    card.append(heading, el('p', `${profile.country} · ${profile.timeZone}`, 'worker-public-location'));
    card.append(el('h2', 'Working hours'), el('p', profile.workHours));
    const stats = el('div', undefined, 'worker-profile-stats');
    const jobs = el('article'); jobs.append(el('span', 'Completed jobs'), el('strong', String(profile.completedJobs)));
    const speed = el('article'); speed.append(el('span', 'Median time to first submission'), el('strong', duration(profile.medianFirstDeliverySeconds)), el('small', 'Across completed jobs. This measures delivery speed, not quality.'));
    stats.append(jobs, speed); card.append(stats);
    const rateSection = el('section', undefined, 'worker-public-section');
    rateSection.append(el('h2', 'Rates'));
    const rates = el('div', undefined, 'worker-public-rates');
    for (const tier of profile.rateTiers || []) {
      const item = el('article'); item.append(el('h3', tier.name), el('p', tier.scope), el('strong', `${tier.amount} ${tier.asset.toUpperCase()}`)); rates.append(item);
    }
    rateSection.append(rates); card.append(rateSection);
    const historySection = el('section', undefined, 'worker-public-section');
    historySection.append(el('h2', 'Completed work'));
    if (profile.completedJobHistory?.length) {
      const list = el('ul', undefined, 'worker-public-history');
      for (const job of profile.completedJobHistory) {
        const item = el('li'); item.append(el('strong', job.title), el('span', `${job.category.replaceAll('_', ' ')} · ${new Date(job.completedAt).toLocaleDateString()}`)); list.append(item);
      }
      historySection.append(list);
    } else historySection.append(el('p', 'Completed work will appear here after a job is settled.'));
    card.append(historySection);
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
