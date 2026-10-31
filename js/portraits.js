/* Deterministic stylised portraits — STATIC SVG images, not photographs.
   Every player gets a different combination of skin tone, face width,
   hair style/colour, beard, jersey colour and shirt number, derived from
   a hash of their name, so the same player always looks the same and
   different players do not look like clones. No licensed photo is used. */
function hashName(s){ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; }
function portraitAttrs(name){
  const h=hashName(name);
  const skins=['#f2c89b','#e0ac69','#c68642','#8d5524','#ffdbac','#a67c52','#d99e6a','#b97a56'];
  const hairs=['#111111','#2b1d0e','#4a2c14','#6b3a1a','#1a1a1a','#3d2b1f','#000000','#5a3a22'];
  const jerseys=['#0b4f8a','#8a0b0b','#0b7a3a','#5b0b8a','#b36b00','#0b7a7a','#8a0b5b','#223344','#7a1f1f','#1f4d2e'];
  return {
    skin: skins[h%skins.length],
    hair: hairs[(h>>3)%hairs.length],
    hairStyle: (h>>6)%5, // 0 short, 1 curly, 2 bald, 3 side-part, 4 cap
    beard: (h>>9)%3, // 0 none, 1 short, 2 full
    jersey: jerseys[(h>>11)%jerseys.length],
    number: 1+((h>>13)%99),
    faceW: 34+((h>>16)%14),
    smile: (h>>19)%2===0
  };
}
function playerPortraitSVG(p, size){
  size=size||160;
  const a=portraitAttrs(p.name);
  const w=a.faceW, cx=100, cy=98;
  let hair='';
  if(a.hairStyle===0) hair=`<path d="M${cx-w} ${cy-18} Q${cx} ${cy-62} ${cx+w} ${cy-18} L${cx+w} ${cy-2} Q${cx+w-6} ${cy-28} ${cx} ${cy-30} Q${cx-w+6} ${cy-28} ${cx-w} ${cy-2} Z" fill="${a.hair}"/>`;
  else if(a.hairStyle===1) hair=`<g fill="${a.hair}"><circle cx="${cx-22}" cy="${cy-34}" r="13"/><circle cx="${cx}" cy="${cy-44}" r="14"/><circle cx="${cx+22}" cy="${cy-34}" r="13"/><circle cx="${cx-12}" cy="${cy-42}" r="11"/><circle cx="${cx+12}" cy="${cy-42}" r="11"/></g>`;
  else if(a.hairStyle===2) hair=`<path d="M${cx-w} ${cy-10} Q${cx} ${cy-28} ${cx+w} ${cy-10} L${cx+w} ${cy-18} Q${cx} ${cy-34} ${cx-w} ${cy-18} Z" fill="${a.hair}" opacity="0.25"/>`;
  else if(a.hairStyle===3) hair=`<path d="M${cx-w} ${cy-14} Q${cx-10} ${cy-58} ${cx+w} ${cy-20} L${cx+w} ${cy-2} Q${cx+10} ${cy-26} ${cx-w} ${cy-2} Z" fill="${a.hair}"/>`;
  else hair=`<path d="M${cx-w-4} ${cy-16} Q${cx} ${cy-52} ${cx+w+4} ${cy-16} L${cx+w+4} ${cy-6} L${cx-w-4} ${cy-6} Z" fill="${a.jersey}"/><rect x="${cx-w-10}" y="${cy-18}" width="${w*2+20}" height="8" rx="4" fill="${a.jersey}"/>`;
  let beard='';
  if(a.beard===1) beard=`<path d="M${cx-w+4} ${cy+18} Q${cx} ${cy+46} ${cx+w-4} ${cy+18} Q${cx+w-8} ${cy+34} ${cx} ${cy+36} Q${cx-w+8} ${cy+34} ${cx-w+4} ${cy+18} Z" fill="${a.hair}" opacity="0.85"/>`;
  if(a.beard===2) beard=`<path d="M${cx-w} ${cy+8} Q${cx-w-2} ${cy+48} ${cx} ${cy+56} Q${cx+w+2} ${cy+48} ${cx+w} ${cy+8} Q${cx+w-6} ${cy+30} ${cx} ${cy+32} Q${cx-w+6} ${cy+30} ${cx-w} ${cy+8} Z" fill="${a.hair}"/>`;
  const mouth = a.smile ? `<path d="M${cx-12} ${cy+22} Q${cx} ${cy+32} ${cx+12} ${cy+22}" stroke="#7a3b2e" stroke-width="3" fill="none" stroke-linecap="round"/>` : `<line x1="${cx-10}" y1="${cy+24}" x2="${cx+10}" y2="${cy+24}" stroke="#7a3b2e" stroke-width="3" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200" role="img" aria-label="Stylised illustration of ${p.name} (not a photograph)">
  <rect width="200" height="200" fill="#0e2233"/>
  <circle cx="100" cy="100" r="92" fill="#162f45"/>
  <path d="M30 200 L70 148 Q100 138 130 148 L170 200 Z" fill="${a.jersey}"/>
  <text x="100" y="188" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#ffffff" opacity="0.9">${a.number}</text>
  <ellipse cx="${cx}" cy="${cy+4}" rx="${w}" ry="44" fill="${a.skin}"/>
  ${hair}
  <circle cx="${cx-14}" cy="${cy+2}" r="4" fill="#1a1a1a"/><circle cx="${cx+14}" cy="${cy+2}" r="4" fill="#1a1a1a"/>
  <path d="M${cx-4} ${cy+6} L${cx+4} ${cy+6} L${cx} ${cy+14} Z" fill="#c68642" opacity="0.6"/>
  ${beard}
  ${mouth}
  <text x="100" y="14" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#8fb8d8">ILLUSTRATION • NOT A PHOTO</text>
</svg>`;
}
function portraitDataURI(p, size){
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(playerPortraitSVG(p, size||160));
}
if(typeof module!=='undefined'){ module.exports={portraitAttrs,playerPortraitSVG,portraitDataURI,hashName}; }

/* ---- Real photos (added 2026-10-28, at the user's "like this" request) ----
   The user wants a real match photo like the Virat Kohli India-jersey photo
   they sent — not a cartoon. Official IPL / press-agency photos cannot be
   copied here without a licence, so the site uses freely-licensed photos
   from Wikipedia / Wikimedia Commons where they exist:
   - A small verified set below, checked against Wikipedia search results
     (e.g. Kohli: Wikimedia Commons photo from India vs Australia, 2023).
   - For every other player, the browser asks the Wikipedia summary API
     (en.wikipedia.org/api/rest_v1/page/summary/<Player Name>) for that
     player's thumbnail. That API returns the photo Wikipedia itself uses.
   - If there is no free photo, no page, or the user is offline, the
     stylised illustration stays visible underneath — the card never goes
     blank, and no photo is ever presented as an official IPL photo.
   Attribution is shown on the player card: "Real photo: Wikipedia /
   Wikimedia Commons (licence on that page)".
   Photo URLs below are NOT guessed: Kohli's is the Commons thumbnail
   returned in the Wikipedia search result for "Virat Kohli". */
const VERIFIED_PHOTOS = {
  'Virat Kohli': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Virat_Kohli_during_the_India_vs_Aus_4th_Test_match_at_Narendra_Modi_Stadium_on_09_March_2023.jpg/500px-Virat_Kohli_during_the_India_vs_Aus_4th_Test_match_at_Narendra_Modi_Stadium_on_09_March_2023.jpg'
};
const wikiThumbCache = {};
try {
  const saved = (typeof localStorage !== 'undefined') ? localStorage.getItem('wiki-thumb-cache') : null;
  if (saved) Object.assign(wikiThumbCache, JSON.parse(saved));
} catch (e) {}
function portraitHTML(p, size) {
  size = size || 160;
  const verified = VERIFIED_PHOTOS[p.name];
  const cached = wikiThumbCache[p.name];
  const img = (verified || cached)
    ? `<img class="real-photo" src="${verified || cached}" alt="Real photo of ${p.name} (Wikipedia / Wikimedia Commons)" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top" onerror="this.style.display='none'">`
    : `<img class="real-photo" data-wiki-name="${p.name.replace(/"/g, '')}" alt="Real photo of ${p.name} (Wikipedia / Wikimedia Commons)" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top;display:none" onerror="this.style.display='none'">`;
  return `<div class="portrait" style="width:${size}px;height:${size}px;position:relative;overflow:hidden;border-radius:12px;flex-shrink:0">${playerPortraitSVG(p, size)}${img}</div>`;
}
async function loadRealPhotos(scope) {
  if (typeof fetch === 'undefined') return;
  if (typeof document === 'undefined' && !scope) return;
  const imgs = (scope || document).querySelectorAll('img[data-wiki-name]:not([data-wiki-tried])');
  const queue = Array.from(imgs);
  // 4 at a time, so the pool list does not fire 80 requests at once
  async function worker() {
    while (queue.length) {
      const img = queue.shift();
      img.setAttribute('data-wiki-tried', '1');
      const name = img.getAttribute('data-wiki-name');
      if (wikiThumbCache[name]) { img.src = wikiThumbCache[name]; img.style.display = 'block'; continue; }
      try {
        const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name));
        if (!res.ok) continue;
        const data = await res.json();
        if (data.thumbnail && data.thumbnail.source) {
          wikiThumbCache[name] = data.thumbnail.source;
          try { localStorage.setItem('wiki-thumb-cache', JSON.stringify(wikiThumbCache)); } catch (e) {}
          img.src = data.thumbnail.source; img.style.display = 'block';
        }
      } catch (e) { /* offline / no page — illustration stays */ }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}
if (typeof module !== 'undefined') { module.exports.VERIFIED_PHOTOS = VERIFIED_PHOTOS; module.exports.portraitHTML = portraitHTML; module.exports.loadRealPhotos = loadRealPhotos; }
