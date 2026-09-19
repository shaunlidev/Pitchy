const form = document.querySelector('#companyForm');
const slideEl = document.querySelector('#slide');
const thumbsEl = document.querySelector('#thumbs');
const pageCount = document.querySelector('#pageCount');
const qualityScore = document.querySelector('#qualityScore');
const qualityBar = document.querySelector('#qualityBar');
const qualityHint = document.querySelector('#qualityHint');
let current = 0;
let deck = [];

const escapeHTML = (value = '') => value.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const clean = value => value.trim().replace(/[。；;]+$/, '');
const splitFacts = value => value.split(/[；;\n]/).map(clean).filter(Boolean);
const short = (value, fallback = '待补充') => clean(value) || fallback;

function values() {
  return Object.fromEntries(new FormData(form).entries());
}

function buildDeck(data) {
  const traction = splitFacts(data.traction);
  const uses = splitFacts(data.use);
  const ask = short(data.ask);
  const market = short(data.market);
  return [
    { theme: 'cover', kicker: 'Company pitch · Draft', title: short(data.name), lead: short(data.oneLiner), body: '<div class="accent-line"></div>' },
    { theme: 'light', kicker: '客户问题', title: '工厂需要更确定的用能成本', lead: short(data.problem), body: '<div class="accent-line"></div>' },
    { theme: '', kicker: '解决方案', title: short(data.solution), lead: `面向 ${escapeHTML(short(data.customer))}`, body: '<div class="accent-line"></div>' },
    { theme: 'teal', kicker: '产品路径', title: '从部署到持续优化', lead: '', body: '<div class="steps"><div class="step"><b>01 快速部署</b><span>标准化硬件减少现场改造</span></div><div class="step"><b>02 实时监测</b><span>追踪能耗、设备与节省金额</span></div><div class="step"><b>03 持续优化</b><span>基于负荷变化调整运行策略</span></div></div>' },
    { theme: 'light', kicker: '商业模式', title: short(data.model), lead: `客户：${escapeHTML(short(data.customer))}`, body: '<div class="accent-line"></div>' },
    { theme: '', kicker: '市场机会', title: market === '待补充' ? '<span class="missing">待补充市场</span>' : market, lead: '市场规模与增长率需要可信来源。正式版本应补充 TAM、SAM、SOM 及计算口径。', body: '<div class="accent-line"></div>' },
    { theme: 'teal', kicker: '业务进展', title: '已有客户正在使用并续约', lead: '', body: `<div class="fact-grid">${(traction.length ? traction : ['待补充客户数量','待补充收入','待补充留存']).slice(0,4).map((x,i) => `<div class="fact"><strong>${i < traction.length ? escapeHTML(x.match(/[\d,.+%MWh万元亿]+/)?.[0] || '已验证') : '待补充'}</strong><span>${escapeHTML(x)}</span></div>`).join('')}</div>` },
    { theme: 'cover', kicker: '融资计划', title: ask, lead: `${escapeHTML(short(data.team))}<br><br>资金用途：${escapeHTML(uses.join('；') || '待补充')}`, body: '<div class="accent-line"></div>' }
  ];
}

function render() {
  const item = deck[current];
  slideEl.className = `slide ${item.theme}`;
  slideEl.innerHTML = `<div class="slide-content"><span class="slide-number">${String(current + 1).padStart(2,'0')}</span><p class="slide-kicker">${item.kicker}</p><h3>${item.title}</h3>${item.lead ? `<p class="lead">${item.lead}</p>` : ''}${item.body}</div>`;
  pageCount.textContent = `${current + 1} / ${deck.length}`;
  [...thumbsEl.children].forEach((thumb, i) => thumb.classList.toggle('active', i === current));
}

function renderThumbs() {
  thumbsEl.innerHTML = '';
  deck.forEach((item, i) => {
    const button = document.createElement('button');
    button.className = `thumb${i === current ? ' active' : ''}`;
    button.dataset.number = String(i + 1).padStart(2,'0');
    button.type = 'button';
    button.innerHTML = `<strong>${item.kicker}</strong>`;
    button.addEventListener('click', () => { current = i; render(); });
    thumbsEl.appendChild(button);
  });
}

function regenerate() {
  deck = buildDeck(values());
  current = 0;
  renderThumbs();
  render();
}

function updateQuality() {
  const data = values();
  const keys = ['name','oneLiner','customer','problem','solution','model','market','traction','team','ask','use'];
  const filled = keys.filter(key => clean(data[key] || '')).length;
  const score = Math.round(filled / keys.length * 100);
  qualityScore.textContent = `${score}%`;
  qualityBar.style.width = `${score}%`;
  qualityHint.textContent = score >= 85 ? '信息足够生成一版投资人演示稿。' : score >= 60 ? '可以生成，但部分页面会显示“待补充”。' : '建议至少补充客户问题、方案和业务进展。';
}

form.addEventListener('input', updateQuality);
form.addEventListener('submit', event => { event.preventDefault(); regenerate(); document.querySelector('.preview-panel').scrollIntoView({behavior:'smooth'}); });
document.querySelector('#prevButton').addEventListener('click', () => { current = (current - 1 + deck.length) % deck.length; render(); });
document.querySelector('#nextButton').addEventListener('click', () => { current = (current + 1) % deck.length; render(); });
document.addEventListener('keydown', event => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (event.key === 'ArrowLeft') document.querySelector('#prevButton').click();
  if (event.key === 'ArrowRight') document.querySelector('#nextButton').click();
});
document.querySelector('#presentButton').addEventListener('click', async () => {
  try { await slideEl.requestFullscreen(); } catch (_) { /* Fullscreen may be blocked by embedded previews. */ }
});
document.querySelector('#copyButton').addEventListener('click', async event => {
  const text = deck.map((item, i) => `${i + 1}. ${item.kicker}\n${item.title.replace(/<[^>]+>/g,'')}\n${item.lead.replace(/<br>/g,'\n')}`).join('\n\n');
  await navigator.clipboard.writeText(text);
  const old = event.currentTarget.textContent;
  event.currentTarget.textContent = '已复制';
  setTimeout(() => event.currentTarget.textContent = old, 1300);
});
document.querySelector('#sampleButton').addEventListener('click', () => { form.reset(); updateQuality(); regenerate(); });

updateQuality();
regenerate();
