const copyButtons = document.querySelectorAll('[data-copy-address]');
for (const button of copyButtons) {
  button.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(button.dataset.copyAddress);
      } else {
        const field = document.createElement('textarea');
        field.value = button.dataset.copyAddress;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Clipboard unavailable');
      }
      window.JobsAIShowInfo?.('ca-copy-success');
    } catch {
      window.JobsAIShowInfo?.('ca-copy-failure');
    }
  });
}
