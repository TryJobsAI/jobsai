(() => {
  const tabs = ['matches', 'tracker', 'interviews', 'create', 'jobs'];
  const panels = [...document.querySelectorAll('[data-panel]')];
  const buttons = [...document.querySelectorAll('[data-tab]')];
  const infoDialog = document.querySelector('#workspace-info');
  const infoTitle = document.querySelector('#workspace-info-title');
  const infoContent = document.querySelector('#workspace-info-content');
  const information = {
    workspace: { title: 'Your JobsAI workspace', paragraphs: ['Wallet sign-in connects your account to funded jobs and keeps your session in this browser. Career discovery, application tracking, and practice tools are separate workspace areas.'] },
    career: { title: 'Career discovery', paragraphs: ['Personalized career matching is not available yet. You can browse and claim live funded work from the Funded work tab.'] },
    applications: { title: 'Application board', paragraphs: ['Application tracking is not available yet. Your board will appear here when career application services are connected.'] },
    practice: { title: 'Practice guide and privacy', paragraphs: ['Use a real example. Set the situation, explain your contribution and decisions, then describe what changed or what you learned.', 'The structure checklist runs in this browser. It does not assess answer quality with AI or send your answer to JobsAI.'] },
    funding: { title: 'Payment and funding', paragraphs: ['Choose ETH or USDG and enter the exact amount you want held for the job. Creating the job does not move funds. You approve the separate escrow transfer in your wallet.'] },
    'funded-work': { title: 'How funded work operates', paragraphs: ['Open a job’s details and review its scope and acceptance criteria before claiming. Claiming assigns the work to your wallet. Funds are released after the client accepts a submission, or after the team resolves a dispute.'] },
    pass: { title: 'Career Pass', paragraphs: ['Career Pass checkout is not available yet. JobsAI will show the offer here when it is ready.'] },
  };

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-info]');
    if (trigger && infoDialog) {
      const copy = information[trigger.dataset.info];
      if (!copy) return;
      infoTitle.textContent = copy.title;
      infoContent.replaceChildren(...copy.paragraphs.map(text => {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        return paragraph;
      }));
      infoDialog.showModal();
    }
  });
  document.querySelector('[data-close-workspace-info]')?.addEventListener('click', () => infoDialog?.close());
  infoDialog?.addEventListener('click', event => {
    if (event.target !== infoDialog) return;
    const rect = infoDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) infoDialog.close();
  });

  function changeTab(tab, update = true) {
    if (!tabs.includes(tab)) tab = 'jobs';
    for (const panel of panels) panel.hidden = panel.dataset.panel !== tab;
    for (const button of buttons) {
      if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (update) {
      const url = new URL(location.href);
      url.searchParams.set('tab', tab);
      history.replaceState(null, '', url);
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-tab], [data-open-tab]');
    if (!button) return;
    const tab = button.dataset.tab || button.dataset.openTab;
    changeTab(tab);
    if (tab === 'create') document.dispatchEvent(new Event('jobsai:open-create'));
  });

  const practice = document.querySelector('#practice-check');
  practice?.addEventListener('click', () => {
    const answer = document.querySelector('#practice-answer').value.trim();
    const result = document.querySelector('#practice-result');
    const content = document.querySelector('#practice-result-content');
    content.replaceChildren();
    if (!answer) {
      const prompt = document.createElement('p');
      prompt.textContent = 'Add an answer before reviewing its structure.';
      content.append(prompt);
      result.showModal();
      return;
    }
    const words = answer.split(/\s+/).length;
    const summary = document.createElement('p');
    summary.textContent = `${words} words. This checklist is saved nowhere and does not assess answer quality.`;
    const list = document.createElement('ul');
    for (const prompt of [
      words >= 50 ? 'You have room for a specific example.' : 'Add context about the situation and the problem.',
      /\bI\b/i.test(answer) ? 'Your own contribution is present; make sure it is distinct from the team’s.' : 'Describe your contribution using “I” where accurate.',
      /result|learn|change|outcome|improv/i.test(answer) ? 'You mention an outcome or learning.' : 'Add what changed or what you learned.',
    ]) {
      const item = document.createElement('li');
      item.textContent = prompt;
      list.append(item);
    }
    content.append(summary, list);
    result.showModal();
  });

  document.querySelector('[data-close-practice]')?.addEventListener('click', () => document.querySelector('#practice-result')?.close());

  changeTab(new URLSearchParams(location.search).get('tab') || 'matches', false);
})();
