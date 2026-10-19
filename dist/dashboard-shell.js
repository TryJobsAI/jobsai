(() => {
  const tabs = ['matches', 'tracker', 'interviews', 'jobs'];
  const panels = [...document.querySelectorAll('[data-panel]')];
  const buttons = [...document.querySelectorAll('[data-tab]')];

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
    changeTab(button.dataset.tab || button.dataset.openTab);
  });

  const practice = document.querySelector('#practice-check');
  practice?.addEventListener('click', () => {
    const answer = document.querySelector('#practice-answer').value.trim();
    const result = document.querySelector('#practice-result');
    result.hidden = false;
    result.replaceChildren();
    if (!answer) {
      result.textContent = 'Add an answer to review its structure.';
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
    result.append(summary, list);
  });

  changeTab(new URLSearchParams(location.search).get('tab') || 'matches', false);
})();
