import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import '@fontsource-variable/outfit/wght.css';
import './style.css';

gsap.registerPlugin(ScrollTrigger);

// Copy buttons work without motion and without GSAP.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    const label = button.querySelector('.copy-label');
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      if (label) label.textContent = 'Copied';
    } catch {
      if (label) label.textContent = 'Select and copy';
    }
    window.setTimeout(() => label && (label.textContent = 'Copy'), 1800);
  });
}

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!reduce) {
  gsap.from('.hero-title, .hero-sub, .hero-actions, .hero-note', { y: 28, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08 });
  gsap.from('.hero-shot', { y: 40, opacity: 0, scale: 0.96, duration: 1.1, ease: 'power3.out', delay: 0.15 });
  gsap.to('.nav .spark', { rotate: 360, duration: 18, ease: 'none', repeat: -1 });

  // Images grow in as they arrive and dim as they leave.
  for (const media of gsap.utils.toArray<HTMLElement>('.card-media img, .hero-shot img')) {
    gsap.fromTo(media, { scale: 0.86 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: media, start: 'top bottom', end: 'top 40%', scrub: true } });
    gsap.to(media, { opacity: 0.35, ease: 'none', scrollTrigger: { trigger: media, start: 'bottom 35%', end: 'bottom top', scrub: true } });
  }

  for (const card of gsap.utils.toArray<HTMLElement>('.bento .card')) {
    gsap.from(card, { y: 36, opacity: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: card, start: 'top 85%' } });
  }

  const mm = gsap.matchMedia();
  mm.add('(min-width: 900px)', () => {
    // The section title stays pinned on the left while the finding cards stack on the right.
    ScrollTrigger.create({ trigger: '.pinned', start: 'top top+=96', end: 'bottom bottom', pin: '.pinned-side', pinSpacing: false });
    const cards = gsap.utils.toArray<HTMLElement>('.finding-card');
    cards.forEach((card, i) => {
      gsap.from(card, { y: 120, opacity: 0, rotate: i % 2 ? 1.5 : -1.5, ease: 'power2.out', scrollTrigger: { trigger: card, start: 'top 90%', end: 'top 55%', scrub: true } });
      if (i < cards.length - 1) {
        gsap.to(card, { scale: 0.94, opacity: 0.55, ease: 'none', scrollTrigger: { trigger: cards[i + 1], start: 'top 70%', end: 'top 30%', scrub: true } });
      }
    });
  });

  gsap.from('.cta-title', { yPercent: 40, opacity: 0, duration: 1, ease: 'power4.out', scrollTrigger: { trigger: '.cta', start: 'top 75%' } });
}
