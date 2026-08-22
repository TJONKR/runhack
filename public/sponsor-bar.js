// Reusable sponsor marquee. Mount with:
//   <footer id="sponsor-bar"></footer>
//   <script src="/sponsor-bar.js"></script>
// Logos come from /api/brands (files in public/brands/): 01-/02- prefixed
// files are the anchors (RUN/HACK, ROXFIT, kept in brand colours), everything
// else rotates between them, whitened like the RUN/HACK site's partner bar.
// All logos render at one uniform height; speed is constant regardless of
// how many logos are in the strip.
(function () {
  const HEIGHT_PX = 22;
  const SPEED_PX_S = 30;

  const style = document.createElement('style');
  style.textContent = `
    #sponsor-bar { padding: 16px 0 22px; border-top: 1px solid rgba(244,243,239,0.1);
                   overflow: hidden; width: 100%; }
    #sponsor-bar .strip { display: flex; gap: 56px; align-items: center; width: max-content;
                          animation: sponsor-marquee 120s linear infinite; }
    #sponsor-bar img { height: ${HEIGHT_PX}px; width: auto; display: block; opacity: 0.8; }
    #sponsor-bar img.partner { filter: brightness(0) invert(1); }
    #sponsor-bar .sponsor-tile { font-family: 'Geist Mono', ui-monospace, monospace; font-size: 10px;
                   letter-spacing: 0.25em; text-transform: uppercase; color: rgba(244,243,239,0.35);
                   white-space: nowrap; border: 1px dashed rgba(244,243,239,0.25); padding: 6px 14px; }
    @keyframes sponsor-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  `;
  document.head.appendChild(style);

  async function mount() {
    const host = document.getElementById('sponsor-bar');
    if (!host) return;
    try {
      const files = await (await fetch('/api/brands')).json();
      const img = (f, cls = '') => `<img src="${f}" alt=""${cls ? ` class="${cls}"` : ''}>`;
      const anchors = files.filter((f) => /\/0[12]-/.test(f)).map((f) => img(f)).join('');
      const partners = files.filter((f) => !/\/0[12]-/.test(f));
      let strip = partners.length
        ? partners.map((p) => anchors + img(p, 'partner')).join('')
        : (anchors + `<span class="sponsor-tile">Sponsor</span>`).repeat(4);
      while (strip.length && (strip.match(/<img/g) || []).length < 24) strip += strip;
      host.innerHTML = `<div class="strip">${strip}${strip}</div>`; // doubled for a seamless loop
      const el = host.firstElementChild;
      await Promise.allSettled([...el.querySelectorAll('img')].map((i) => i.decode()));
      el.style.animationDuration = `${el.scrollWidth / 2 / SPEED_PX_S}s`;
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
