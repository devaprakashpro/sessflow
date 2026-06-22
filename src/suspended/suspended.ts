const params = new URLSearchParams(location.search);
const target = decodeURIComponent(params.get('u') ?? '');
const title = params.get('t') ?? target;
const fav = params.get('f');

document.title = title ? `💤 ${title}` : 'Suspended — Sessflow';

const titleEl = document.getElementById('title');
const urlEl = document.getElementById('url');
const favEl = document.getElementById('fav') as HTMLImageElement | null;

if (titleEl) titleEl.textContent = title || 'Tab suspended to save memory';
if (urlEl) urlEl.textContent = target;
if (favEl && fav) favEl.src = fav;
else if (favEl) favEl.style.display = 'none';

function restore() {
  if (target) location.replace(target);
}

document.getElementById('wrap')?.addEventListener('click', restore);
window.addEventListener('focus', restore);
document.addEventListener('keydown', restore, { once: true });
