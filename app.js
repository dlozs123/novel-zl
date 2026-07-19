/* ============================================================
   藏书阁 · 小说整理站
   Static single-page app. Routing via location.hash so that the
   browser Back/Forward buttons work for free:
     #/                          -> home
     #/user/<userId>             -> user page
     #/novel/<novelId>/<userId>  -> novel content page
   ============================================================ */

const DATA_BASE = 'https://v1.dlozs.top/data';
const NOVEL_BASE = 'https://v1.dlozs.top/novels';
const SPLIT_MARKER = '----- 下面是正文 -----';

let fabHideTimeout = null;

const state = {
  users: [],
  config: null,
  sb: null,               // supabase client
  markedIds: new Set(),   // novel ids (string) marked for deletion, synced with supabase
  markedUserIds: new Set(), // user ids (string) marked as read
  userMarkMode: false,      // toggles whether clicking user card marks them
  currentUserId: null,
  currentNovels: [],
  deleteMode: false,
  hideDeleted: false,
  pendingSelection: new Set(),
  highlightNovelId: null,  // set right before leaving to a novel page, consumed once back on the user page
};

/* ---------------- bootstrap ---------------- */

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('hashchange', route);

async function init(){
  await loadConfig();
  initSupabase();
  try{
    await loadUsers();
  }catch(e){
    document.getElementById('app').innerHTML =
      `<div class="error">users.json 加载失败：${escapeHtml(e.message)}<br>请确认 users.json 与 index.html 放在同一目录。</div>`;
    return;
  }
  await refreshMarkedIds();
  await refreshMarkedUserIds();
  subscribeRealtime();
  
  route();
}

function startFabHideTimer() {
  const fab = document.getElementById('seriesFab');
  if (fab) {
    clearTimeout(fabHideTimeout);
    fabHideTimeout = setTimeout(() => {
      if (!fab.matches(':hover')) {
        fab.classList.add('hide-side');
      }
    }, 2000);
  }
}

async function loadConfig(){
  try{
    const res = await fetch('./config.json', { cache: 'no-store' });
    if(res.ok) state.config = await res.json();
  }catch(e){
    state.config = null;
  }
}

function initSupabase(){
  if(state.config && state.config.SUPABASE_URL && state.config.SUPABASE_KEY && window.supabase){
    try{
      state.sb = window.supabase.createClient(state.config.SUPABASE_URL, state.config.SUPABASE_KEY);
    }catch(e){
      console.error('Supabase 初始化失败', e);
      state.sb = null;
    }
  } else {
    state.sb = null;
  }
}

async function loadUsers(){
  const res = await fetch('./users.json', { cache: 'no-store' });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  state.users = await res.json();
}

async function refreshMarkedIds(){
  state.markedIds = new Set();
  if(!state.sb) return;
  try{
    const { data, error } = await state.sb.from('deleted_novels').select('novel_id');
    if(error) throw error;
    (data || []).forEach(r => state.markedIds.add(String(r.novel_id)));
  }catch(e){
    console.error('加载删除标记失败', e);
  }
}

async function refreshMarkedUserIds(){
  state.markedUserIds = new Set();
  if(!state.sb) return;
  try{
    const { data, error } = await state.sb.from('marked_users').select('user_id');
    if(error) throw error;
    (data || []).forEach(r => state.markedUserIds.add(String(r.user_id)));
  }catch(e){
    console.error('加载标记作者失败', e);
  }
}

function subscribeRealtime(){
  if(!state.sb) return;
  state.sb.channel('deleted_novels_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'deleted_novels' }, payload => {
      if(payload.eventType === 'INSERT' && payload.new){
        state.markedIds.add(String(payload.new.novel_id));
      } else if(payload.eventType === 'DELETE' && payload.old){
        state.markedIds.delete(String(payload.old.novel_id));
      }
      const parts = parseHash();
      if(parts[0] === 'user' && !state.deleteMode){
        renderNovelList();
      }
    })
    .subscribe();

  state.sb.channel('marked_users_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'marked_users' }, payload => {
      if(payload.eventType === 'INSERT' && payload.new){
        state.markedUserIds.add(String(payload.new.user_id));
      } else if(payload.eventType === 'DELETE' && payload.old){
        state.markedUserIds.delete(String(payload.old.user_id));
      }
      const parts = parseHash();
      if(!parts[0] || parts[0] === ''){
        renderHome();
      }
    })
    .subscribe();
}

/* ---------------- routing ---------------- */

function parseHash(){
  const raw = location.hash.replace(/^#\/?/, '');
  return raw.split('/').filter(Boolean).map(decodeURIComponent);
}

function go(hash){
  location.hash = hash;
}

function route(){
  const parts = parseHash();
  if(parts[0] === 'user' && parts[1]){
    renderUserPage(parts[1]);
  } else if(parts[0] === 'novel' && parts[1]){
    renderNovelPage(parts[1], parts[2] || null);
  } else {
    renderHome();
  }
  window.scrollTo(0, 0);
}

/* ---------------- home page ---------------- */

function renderHome(){
  const app = document.getElementById('app');
  const sorted = [...state.users].sort((a, b) => (b.count || 0) - (a.count || 0));

  app.innerHTML = `
    <header class="topbar">
      <h1>藏书阁</h1>
      <button id="exportBtn" class="btn">导出删除列表</button>
    </header>
    <div class="grid" id="userGrid"></div>
    <button id="userMarkFab" class="fab right" style="bottom: 20px;">${state.userMarkMode ? '退出标记' : '标记模式'}</button>
  `;

  const grid = document.getElementById('userGrid');
  grid.innerHTML = sorted.map(userCardHTML).join('');
  grid.querySelectorAll('.user-card').forEach(card => {
    card.addEventListener('click', async () => {
      const uId = card.dataset.userid;
      if (state.userMarkMode) {
        if (!state.sb) {
          alert('尚未配置 Supabase，无法保存。');
          return;
        }
        const isMarked = state.markedUserIds.has(uId);
        if (isMarked) {
          state.markedUserIds.delete(uId);
          renderHome();
          const { error } = await state.sb.from('marked_users').delete().eq('user_id', uId);
          if (error) { state.markedUserIds.add(uId); renderHome(); }
        } else {
          state.markedUserIds.add(uId);
          renderHome();
          const { error } = await state.sb.from('marked_users').insert([{ user_id: uId }]);
          if (error) { state.markedUserIds.delete(uId); renderHome(); }
        }
      } else {
        go(`#/user/${encodeURIComponent(uId)}`);
      }
    });
  });

  document.getElementById('exportBtn').addEventListener('click', exportDeletedList);
  
  const fab = document.getElementById('userMarkFab');
  if (fab) {
    fab.addEventListener('click', () => {
      state.userMarkMode = !state.userMarkMode;
      renderHome();
    });
  }
}

function userCardHTML(u){
  const { c1, c2 } = colorFromString(String(u.userId));
  const isMarked = state.markedUserIds.has(String(u.userId));
  const markHtml = isMarked ? `<div class="user-mark-circle"></div>` : '';
  
  return `
    <div class="user-card" data-userid="${escapeHtml(String(u.userId))}">
      ${markHtml}
      <div class="avatar" style="background:linear-gradient(135deg, ${c1}, ${c2})"></div>
      <div class="user-name">${escapeHtml(u.user)}</div>
      <div class="user-count">${u.count} 篇</div>
    </div>`;
}

function hashStr(s){
  let h = 0;
  for(let i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}

function colorFromString(s){
  const h = hashStr(s);
  const hue1 = h % 360;
  const hue2 = (hue1 + 50 + (h >> 8) % 80) % 360;
  return { c1: `hsl(${hue1}, 62%, 52%)`, c2: `hsl(${hue2}, 68%, 32%)` };
}

async function exportDeletedList(){
  let ids;
  if(state.sb){
    try{
      const { data, error } = await state.sb.from('deleted_novels').select('novel_id');
      if(error) throw error;
      ids = (data || []).map(r => String(r.novel_id));
    }catch(e){
      alert('导出失败：' + e.message);
      return;
    }
  } else {
    ids = [...state.markedIds];
  }
  if(!ids.length){
    alert('当前没有被标记删除的作品。');
    return;
  }
  const blob = new Blob([ids.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deleted_list.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------- user page ---------------- */

async function loadUserNovels(userId){
  const res = await fetch(`${DATA_BASE}/${encodeURIComponent(userId)}.json`);
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function renderUserPage(userId){
  const app = document.getElementById('app');
  app.innerHTML = `<div class="loading">正在翻阅书架…</div>`;

  let novels;
  try{
    novels = await loadUserNovels(userId);
  }catch(e){
    app.innerHTML = `
      <div class="error">用户作品加载失败：${escapeHtml(e.message)}</div>
      <div style="text-align:center;margin-top:16px;"><button id="backBtn" class="btn">返回首页</button></div>`;
    document.getElementById('backBtn').onclick = () => go('#/');
    return;
  }

  const userMeta = state.users.find(u => String(u.userId) === String(userId));
  const userName = userMeta ? userMeta.user : (novels[0] ? novels[0].user : userId);

  state.currentUserId = String(userId);
  state.currentNovels = novels;
  state.deleteMode = false;
  state.pendingSelection = new Set(state.markedIds);

  app.innerHTML = `
    <header class="topbar">
      <button id="backBtn" class="btn-icon">← 返回</button>
      <h1>${escapeHtml(userName)}</h1>
      <button id="hideDeletedBtn" class="btn">${state.hideDeleted ? '显示已删除' : '隐藏已删除'}</button>
      <button id="deleteModeBtn" class="btn">删除模式</button>
    </header>
    <div class="confirm-bar hidden" id="confirmBar">
      <span id="selectedCount"></span>
      <button id="confirmBtn" class="btn primary">确定</button>
    </div>
    <div class="novel-list" id="novelList"></div>
  `;

  document.getElementById('backBtn').onclick = () => go('#/');
  document.getElementById('hideDeletedBtn').onclick = () => {
    state.hideDeleted = !state.hideDeleted;
    document.getElementById('hideDeletedBtn').textContent = state.hideDeleted ? '显示已删除' : '隐藏已删除';
    renderNovelList();
  };
  document.getElementById('deleteModeBtn').onclick = toggleDeleteMode;
  document.getElementById('confirmBtn').onclick = confirmDeleteSelection;

  renderNovelList();
}

function renderNovelList(){
  const list = document.getElementById('novelList');
  if(!list) return;
  list.classList.toggle('delete-mode', state.deleteMode);
  
  let novelsToRender = state.currentNovels;
  if (state.hideDeleted) {
    novelsToRender = novelsToRender.filter(n => !state.markedIds.has(String(n.id)));
  }
  
  list.innerHTML = novelsToRender.map(novelItemHTML).join('');

  list.querySelectorAll('.novel-title').forEach(el => {
    el.addEventListener('click', () => {
      if(state.deleteMode) return; // clicks are handled by the whole-card toggle below
      state.highlightNovelId = el.dataset.id;
      go(`#/novel/${encodeURIComponent(el.dataset.id)}/${encodeURIComponent(state.currentUserId)}`);
    });
  });

  if(state.deleteMode){
    list.querySelectorAll('.novel-item').forEach(item => {
      item.addEventListener('click', e => {
        const cb = item.querySelector('.novel-checkbox');
        if(!cb) return;
        if(e.target !== cb) cb.checked = !cb.checked;
        const id = cb.dataset.id;
        if(cb.checked) state.pendingSelection.add(id);
        else state.pendingSelection.delete(id);
        updateSelectedCount();
      });
    });
  }

  if(state.highlightNovelId){
    const targetId = state.highlightNovelId;
    state.highlightNovelId = null;
    const target = list.querySelector(`.novel-item[data-novel-id="${CSS.escape(targetId)}"]`);
    if(target){
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('highlight');
        setTimeout(() => target.classList.remove('highlight'), 5000);
      });
    }
  }
}

// Strip HTML-tag-like fragments (e.g. literal "<br />" in description text).
// No line-break substitution needed — just drop the tags.
function stripTags(str){
  return String(str).replace(/<[^>]*>/g, '');
}

function novelItemHTML(n){
  const id = String(n.id);
  const marked = state.markedIds.has(id);
  const checked = state.pendingSelection.has(id);
  const tags = Array.isArray(n.tags) ? n.tags : [];
  const tagsHtml = tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const rawDesc = n.description || (n.novelMeta && n.novelMeta.description) || '';
  const desc = stripTags(rawDesc);
  const charCount = (n.novelMeta && n.novelMeta.charCount) || n.charCount || 0;

  const checkboxHtml = state.deleteMode
    ? `<input type="checkbox" class="novel-checkbox" data-id="${escapeHtml(id)}" ${checked ? 'checked' : ''}>`
    : '';
  const markHtml = (!state.deleteMode && marked) ? `<span class="mark-x">✗</span>` : '';
  const seriesHtml = (n.seriesTitle && n.seriesOrder !== null && n.seriesOrder !== undefined)
    ? `<div class="novel-series">${escapeHtml(n.seriesTitle)} 系列作品的第 ${escapeHtml(String(n.seriesOrder))} 篇</div>`
    : '';

  return `
    <div class="novel-item" data-novel-id="${escapeHtml(id)}">
      <div class="novel-header">
        ${checkboxHtml}
        ${markHtml}
        <span class="novel-title" data-id="${escapeHtml(id)}">${escapeHtml(n.title || '（无标题）')}</span>
        <span class="novel-charcount">${charCount} 字</span>
      </div>
      ${desc ? `<div class="novel-desc">${escapeHtml(desc)}</div>` : ''}
      ${seriesHtml}
      ${tagsHtml ? `<div class="novel-tags">${tagsHtml}</div>` : ''}
    </div>`;
}

function toggleDeleteMode(){
  state.deleteMode = !state.deleteMode;
  document.getElementById('deleteModeBtn').textContent = state.deleteMode ? '退出删除模式' : '删除模式';
  document.getElementById('deleteModeBtn').classList.toggle('active', state.deleteMode);
  document.getElementById('confirmBar').classList.toggle('hidden', !state.deleteMode);
  if(state.deleteMode){
    state.pendingSelection = new Set(state.markedIds);
  }
  updateSelectedCount();
  renderNovelList();
}

function updateSelectedCount(){
  const el = document.getElementById('selectedCount');
  if(!el) return;
  const currentIds = new Set(state.currentNovels.map(n => String(n.id)));
  const countInThisUser = [...state.pendingSelection].filter(id => currentIds.has(id)).length;
  el.textContent = `已选择 ${countInThisUser} 篇`;
}

async function confirmDeleteSelection(){
  if(!state.sb){
    alert('尚未配置 Supabase（config.json），无法保存删除标记。');
    return;
  }
  const confirmBtn = document.getElementById('confirmBtn');
  const currentIds = new Set(state.currentNovels.map(n => String(n.id)));
  const before = new Set([...state.markedIds].filter(id => currentIds.has(id)));
  const after = new Set([...state.pendingSelection].filter(id => currentIds.has(id)));
  const toAdd = [...after].filter(id => !before.has(id));
  const toRemove = [...before].filter(id => !after.has(id));

  if(!toAdd.length && !toRemove.length){
    state.deleteMode = false;
    document.getElementById('deleteModeBtn').textContent = '删除模式';
    document.getElementById('deleteModeBtn').classList.remove('active');
    document.getElementById('confirmBar').classList.add('hidden');
    renderNovelList();
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = '保存中…';
  try{
    if(toAdd.length){
      const rows = toAdd.map(id => {
        const novel = state.currentNovels.find(n => String(n.id) === id);
        return { novel_id: id, user_id: state.currentUserId, title: novel ? (novel.title || null) : null };
      });
      const { error } = await state.sb.from('deleted_novels').insert(rows);
      if(error) throw error;
    }
    if(toRemove.length){
      const { error } = await state.sb.from('deleted_novels').delete().in('novel_id', toRemove);
      if(error) throw error;
    }
    toAdd.forEach(id => state.markedIds.add(id));
    toRemove.forEach(id => state.markedIds.delete(id));
    state.deleteMode = false;
    renderUserPage(state.currentUserId);
  }catch(e){
    alert('保存失败：' + e.message);
    confirmBtn.disabled = false;
    confirmBtn.textContent = '确定';
  }
}

/* ---------------- novel page ---------------- */

async function loadNovelText(novelId){
  const res = await fetch(`${NOVEL_BASE}/${encodeURIComponent(novelId)}.txt`);
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function processNovelText(raw){
  const idx = raw.indexOf(SPLIT_MARKER);
  let text = idx >= 0 ? raw.slice(idx + SPLIT_MARKER.length) : raw;
  
  // 修改这里：全局替换掉所有的 [newpage]，然后再过滤掉可能产生的空行
  let lines = text.split(/\r?\n/)
    .map(l => l.replace(/\[newpage\]/g, ''))
    // 如果不需要保留因为删掉标签而变成纯空格的行，可以加上下面这句过滤：
    // .filter(l => l.trim() !== ''); 
  
  while(lines.length && lines[0].trim() === '') lines.shift();
  while(lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

async function renderNovelPage(novelId, userId){
  const app = document.getElementById('app');
  app.innerHTML = `<div class="loading">正在展开卷轴…</div>`;

  let meta = null;
  if(userId && state.currentUserId === userId){
    meta = state.currentNovels.find(n => String(n.id) === String(novelId));
  }

  let raw;
  try{
    raw = await loadNovelText(novelId);
  }catch(e){
    app.innerHTML = `
      <div class="error">正文加载失败：${escapeHtml(e.message)}</div>
      <div style="text-align:center;margin-top:16px;"><button id="backBtn" class="btn">返回</button></div>`;
    document.getElementById('backBtn').onclick = () => history.back();
    return;
  }

  const processed = processNovelText(raw);

  const allNovels = state.currentNovels || [];
  const inSeries = meta && meta.seriesTitle;

  state.highlightNovelId = String(novelId);

  app.innerHTML = `
    <header class="topbar">
      <button id="backBtn" class="btn-icon">← 返回</button>
      <h1>${escapeHtml(meta ? (meta.title || '（无标题）') : ('作品 ' + novelId))}</h1>
      <button id="mobileBtn" class="btn">手机模式</button>
    </header>
    <div class="novel-content" id="novelContent">${escapeHtml(processed)}</div>
    ${allNovels.length ? novelDirectoryHTML(meta, inSeries) : ''}
  `;

  document.getElementById('backBtn').onclick = () => go(`#/user/${encodeURIComponent(userId)}`);
  document.getElementById('mobileBtn').onclick = () => {
    const content = document.getElementById('novelContent');
    const active = content.classList.toggle('mobile-mode');
    document.getElementById('mobileBtn').textContent = active ? '还原字号' : '手机模式';
  };

  if(allNovels.length){
    setupNovelDirectory(novelId, userId, inSeries, meta, allNovels);
  }
  
  startFabHideTimer();
}

function novelDirectoryHTML(meta, inSeries){
  return `
    <button id="seriesFab" class="fab">作品目录</button>
    <div id="seriesPanel" class="series-panel hidden">
      <div class="series-panel-header" style="display:flex; justify-content:space-between; align-items:center; padding: 8px 16px;">
        <span>作品目录</span>
        <button id="toggleSeriesBtn" class="btn" style="padding: 4px 10px; font-size: 0.75rem;" ${inSeries ? '' : 'disabled'}>只看系列</button>
      </div>
      <div class="series-panel-list" id="directoryList"></div>
    </div>`;
}

function setupNovelDirectory(novelId, userId, inSeries, meta, allNovels){
  const fab = document.getElementById('seriesFab');
  const panel = document.getElementById('seriesPanel');
  const listContainer = document.getElementById('directoryList');
  const toggleBtn = document.getElementById('toggleSeriesBtn');
  
  let showOnlySeries = false;

  function renderList() {
    let list = allNovels;
    if (showOnlySeries && inSeries && meta) {
      list = allNovels
        .filter(n => n.seriesTitle === meta.seriesTitle)
        .sort((a, b) => (a.seriesOrder || 0) - (b.seriesOrder || 0));
    }
    
    listContainer.innerHTML = list.map(n => {
      const isCurrent = String(n.id) === String(novelId);
      const prefix = (showOnlySeries && inSeries && n.seriesOrder !== null && n.seriesOrder !== undefined) 
        ? `<span class="series-panel-order">第${escapeHtml(String(n.seriesOrder))}篇</span>`
        : '';
      return `
        <div class="series-panel-item ${isCurrent ? 'current' : ''}" data-id="${escapeHtml(String(n.id))}">
          ${prefix}
          <span>${escapeHtml(n.title || '（无标题）')}</span>
        </div>`;
    }).join('');
    
    listContainer.querySelectorAll('.series-panel-item').forEach(item => {
      item.addEventListener('click', () => {
        const targetId = item.dataset.id;
        if(String(targetId) === String(novelId)) { panel.classList.add('hidden'); return; }
        go(`#/novel/${encodeURIComponent(targetId)}/${encodeURIComponent(userId)}`);
      });
    });
  }

  renderList();

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if(!inSeries) return;
      showOnlySeries = !showOnlySeries;
      toggleBtn.classList.toggle('primary', showOnlySeries);
      renderList();
    });
  }

  fab.addEventListener('click', () => panel.classList.toggle('hidden'));
  
  fab.addEventListener('mouseenter', () => {
    fab.classList.remove('hide-side');
    clearTimeout(fabHideTimeout);
  });
  
  fab.addEventListener('mouseleave', () => {
    startFabHideTimer();
  });
}

/* ---------------- utils ---------------- */

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}