const menu = document.querySelector('.menu-button');
const mobileNav = document.querySelector('#mobile-nav');
if (menu && mobileNav) {
  const closeMenu = () => {
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open menu');
    mobileNav.hidden = true;
  };
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') === 'true';
    menu.setAttribute('aria-expanded', String(!open));
    menu.setAttribute('aria-label', open ? 'Open menu' : 'Close menu');
    mobileNav.hidden = open;
  });
  mobileNav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenu();
  });
}
const header = document.querySelector('.header');
const floating = document.querySelector('.floating-cta');
function updateScroll() {
  header?.classList.toggle('scrolled', window.scrollY > 25);
  const heroActions = document.querySelector('.hero-actions');
  const footer = document.querySelector('.footer');
  if (floating && heroActions && footer) {
    floating.classList.toggle('visible', heroActions.getBoundingClientRect().bottom < 0 && footer.getBoundingClientRect().top > window.innerHeight * 0.8);
  }
}
window.addEventListener('scroll', updateScroll, { passive: true });
updateScroll();
let motionPaused = false;
try { motionPaused = localStorage.getItem('jobsai-motion') === 'paused'; } catch {}
const motionButton = document.querySelector('#motion-toggle');
function syncMotion() {
  document.body.classList.toggle('motion-paused', motionPaused);
  motionButton?.setAttribute('aria-pressed', String(motionPaused));
  if (motionButton) motionButton.textContent = motionPaused ? 'Resume motion' : 'Pause motion';
  document.dispatchEvent(new Event('jobsai:motion'));
}
motionButton?.addEventListener('click', () => {
  motionPaused = !motionPaused;
  try { localStorage.setItem('jobsai-motion', motionPaused ? 'paused' : 'active'); } catch {}
  syncMotion();
});
syncMotion();
