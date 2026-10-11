(() => {
'use strict';
const $ = id => document.getElementById(id);
const LS = {
  get(k, d=null){ try{ const v = localStorage.getItem(k); return v===null?d:JSON.parse(v);}catch{return d;} },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true;}catch{ return false; } },
  del(k){ try{ localStorage.removeItem(k);}catch{} }
};

let cfg = LS.get('cfg', {repo:'', token:'', branch:'', folder:'', theme:'auto'});
let tree = LS.get('tree', []);           // [{path, sha}]
let cur = null;                          // {path, sha, text, base, isNew}
let dirty = false;
let mode = 'edit';

/* ---------- helpers ---------- */
const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64 = s => { const b = new TextEncoder().encode(s); let x=''; b.forEach(c => x += String.fromCharCode(c)); return btoa(x); };
const unb64 = s => { const bin = atob(s.replace(/\s/g,'')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); };
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const isNote = p => /\.(md|markdown|txt)$/i.test(p);

function parseRepo(v){
  v = (v||'').trim().replace(/\.git$/,'').replace(/\/+$/,'');
  const m = v.match(/github\.com[\/:]([^\/\s]+)\/([^\/\s]+)/i) || v.match(/^([^\/\s]+)\/([^\/\s]+)$/);
  return m ? m[1]+'/'+m[2] : '';
}
function toast(msg, ms=2400){
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className='toast'; t.textContent=msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
async function gh(path, opts={}){
  const r = await fetch('https://api.github.com'+path, Object.assign({}, opts, {
    headers: Object.assign({
      'Accept':'application/vnd.github+json',
      'Authorization':'Bearer '+cfg.token,
      'X-GitHub-Api-Version':'2022-11-28'
    }, opts.headers||{})
  }));
  if(!r.ok){
    let m=''; try{ m=(await r.json()).message; }catch{}
    const e = new Error(m || ('HTTP '+r.status)); e.status = r.status; throw e;
  }
  return r.status===204 ? null : r.json();
}
function friendly(e){
  if(!navigator.onLine || e instanceof TypeError) return 'You are offline. Check your connection and try again.';
  if(e.status===401) return 'GitHub rejected the token. Check it in Settings.';
  if(e.status===403) return 'Access denied or rate limited. Make sure the token has Contents: Read and write for this repo.';
  if(e.status===404) return 'Repo or file not found. Check the repo name and that the token can access it.';
  if(e.status===409 || e.status===422) return 'The file changed on GitHub (or already exists). Reload it from the menu, then re-apply your edit.';
  return e.message;
}

/* ---------- theme ---------- */
function applyTheme(){
  const r = document.documentElement;
  if(cfg.theme==='light'||cfg.theme==='dark') r.setAttribute('data-theme', cfg.theme); else r.removeAttribute('data-theme');
}

/* ---------- views ---------- */
function show(view){
  for(const id of ['listView','editView']){
    const el = $(id); const on = id===view;
    el.style.display = on ? 'flex' : 'none';
  }
  $('settingsView').classList.add('hidden');
  $('menu').classList.add('hidden');
}

/* ---------- list ---------- */
function visibleFiles(){
  const f = (cfg.folder||'').replace(/^\/+|\/+$/g,'');
  return tree.filter(t => isNote(t.path) && (!f || t.path.startsWith(f+'/')));
}
function buildNested(files){
  const root = {dirs:{}, files:[]};
  const base = (cfg.folder||'').replace(/^\/+|\/+$/g,'');
  for(const f of files){
    const rel = base ? f.path.slice(base.length+1) : f.path;
    const parts = rel.split('/'); const name = parts.pop();
    let n = root;
    for(const p of parts){ n = n.dirs[p] = n.dirs[p] || {dirs:{}, files:[]}; }
    n.files.push({name, path:f.path});
  }
  return root;
}
function titleOf(name){ return name.replace(/\.(md|markdown|txt)$/i,''); }
function renderNode(n, filter, level=0){
  let html = '';
  const dirNames = Object.keys(n.dirs).sort((a,b)=>a.localeCompare(b));
  for(const d of dirNames){
    const inner = renderNode(n.dirs[d], filter, level+1);
    if(!inner) continue;
    html += `<details class="folder" ${filter||level===0?'open':''}><summary>${esc(d)}</summary><div class="children">${inner}</div></details>`;
  }
  const files = n.files.slice().sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  for(const f of files){
    if(filter && !f.path.toLowerCase().includes(filter)) continue;
    const cached = LS.get('note:'+f.path);
    const preview = cached && cached.text ? cached.text.replace(/[#*_>`\-\[\]]/g,'').replace(/\s+/g,' ').trim().slice(0,90) : '';
    html += `<button class="note" data-path="${esc(f.path)}"><span class="t">${esc(titleOf(f.name))}</span>${preview?`<span class="p">${esc(preview)}</span>`:''}</button>`;
  }
  return html;
}
function renderList(){
  const list = $('list');
  if(!cfg.repo || !cfg.token){
    list.innerHTML = `<div class="empty"><b>Connect your repo</b>Add your repository link and a personal access token in Settings to see your notes.<br><br><button class="btn primary" id="emptySettings">Open settings</button></div>`;
    $('emptySettings').onclick = openSettings; return;
  }
  const files = visibleFiles();
  if(!files.length){
    list.innerHTML = `<div class="empty"><b>No notes yet</b>Tap “New note” to write the first one, or pull to sync with the sync button above.</div>`;
    return;
  }
  const q = $('search').value.trim().toLowerCase();
  const html = renderNode(buildNested(files), q);
  list.innerHTML = html || `<div class="empty"><b>No matches</b>Nothing named “${esc(q)}”.</div>`;
}
$('list').addEventListener('click', e => {
  const b = e.target.closest('.note'); if(b) openNote(b.dataset.path);
});
$('search').addEventListener('input', renderList);

async function sync(silent){
  if(!cfg.repo || !cfg.token){ if(!silent) openSettings(); return; }
  $('syncBtn').style.opacity = .5;
  try{
    if(!cfg.branch){
      const info = await gh(`/repos/${cfg.repo}`);
      cfg.branch = info.default_branch; LS.set('cfg', cfg);
    }
    const t = await gh(`/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`);
    tree = t.tree.filter(x => x.type==='blob').map(x => ({path:x.path, sha:x.sha}));
    LS.set('tree', tree);
    renderList();
    if(!silent) toast(t.truncated ? 'Synced (repo is large, list is partial)' : 'Synced');
  }catch(e){
    const msg = e.status===404
      ? `Branch "${cfg.branch}" has no commits yet. Tap "New note" to create the first one, or check the branch name in Settings.`
      : friendly(e);
    toast(msg, 4500);
  }finally{ $('syncBtn').style.opacity = 1; }
}
$('syncBtn').onclick = () => sync(false);

/* ---------- open / edit ---------- */
function setStatus(txt, cls=''){
  $('statusText').innerHTML = cls ? `<span class="${cls}">${esc(txt)}</span>` : esc(txt);
}
function markDirty(d){
  dirty = d;
  if(d){ setStatus('Unsaved changes','dirty'); } else if(cur){ setStatus(cur.isNew ? 'New note, not saved yet' : 'Saved to GitHub','ok'); }
}
async function openNote(path, opts={}){
  cur = {path, sha:null, text:'', base:'', isNew:false};
  $('noteTitle').firstChild.nodeValue = titleOf(path.split('/').pop());
  $('notePath').textContent = path;
  $('statusRight').textContent = '';
  setMode('edit');
  show('editView');
  const cached = LS.get('note:'+path);
  const draft = LS.get('draft:'+path);
  if(opts.isNew){
    cur.isNew = true; cur.text = ''; cur.base='';
  }else if(cached){
    cur.sha = cached.sha; cur.text = cached.text; cur.base = cached.text;
  }
  $('text').value = (draft!==null && draft!==undefined) ? draft : cur.text;
  markDirty(draft!==null && draft!==undefined && draft!==cur.base);
  if(opts.isNew){ $('text').focus(); return; }
  setStatus('Loading from GitHub…');
  try{
    const f = await gh(`/repos/${cfg.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(cfg.branch)}`);
    const text = f.content ? unb64(f.content) : '';
    const hadLocalEdits = dirty;
    cur.sha = f.sha; cur.base = text; cur.text = text;
    LS.set('note:'+path, {sha:f.sha, text});
    if(!hadLocalEdits){ $('text').value = text; markDirty(false); }
    else { setStatus('Unsaved changes restored from this device','dirty'); }
  }catch(e){
    if(cached){ setStatus('Offline copy · '+friendly(e),'err'); }
    else { setStatus(friendly(e),'err'); }
  }
}
$('text').addEventListener('input', () => {
  if(!cur) return;
  cur.text = $('text').value;
  LS.set('draft:'+cur.path, cur.text);
  markDirty(cur.text !== cur.base || cur.isNew);
  $('statusRight').textContent = wordCount(cur.text);
});
function wordCount(t){ const w = (t.trim().match(/\S+/g)||[]).length; return w+' word'+(w===1?'':'s'); }

async function saveNote(){
  if(!cur) return;
  const text = $('text').value;
  $('saveBtn').disabled = true; setStatus('Saving…');
  try{
    const body = {
      message: (cur.isNew ? 'Add ' : 'Update ') + cur.path,
      content: b64(text),
      branch: cfg.branch
    };
    if(cur.sha) body.sha = cur.sha;
    const res = await gh(`/repos/${cfg.repo}/contents/${encPath(cur.path)}`, {method:'PUT', body: JSON.stringify(body)});
    cur.sha = res.content.sha; cur.base = text; cur.text = text; cur.isNew = false;
    LS.set('note:'+cur.path, {sha:cur.sha, text});
    LS.del('draft:'+cur.path);
    const i = tree.findIndex(t => t.path===cur.path);
    if(i>=0) tree[i].sha = cur.sha; else tree.push({path:cur.path, sha:cur.sha});
    LS.set('tree', tree);
    markDirty(false); toast('Saved to GitHub');
  }catch(e){
    setStatus(friendly(e),'err');
  }finally{ $('saveBtn').disabled = false; }
}
$('saveBtn').onclick = saveNote;
document.addEventListener('keydown', e => {
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s' && cur && $('editView').style.display!=='none'){ e.preventDefault(); saveNote(); }
});

function closeEditor(){
  if(dirty && !confirm('You have unsaved changes. They stay as a draft on this device. Leave anyway?')) return;
  cur = null; dirty = false; show('listView'); renderList();
}
$('backBtn').onclick = closeEditor;

/* ---------- mode ---------- */
function setMode(m){
  mode = m;
  $('modeEdit').classList.toggle('on', m==='edit');
  $('modeView').classList.toggle('on', m==='view');
  $('text').classList.toggle('hidden', m!=='edit');
  $('tools').classList.toggle('hidden', m!=='edit');
  $('preview').classList.toggle('hidden', m!=='view');
  if(m==='view'){ $('preview').innerHTML = md($('text').value); }
}
$('modeEdit').onclick = () => setMode('edit');
$('modeView').onclick = () => setMode('view');
$('preview').addEventListener('change', e => {
  // tick checkboxes in Read mode -> update the Nth task in the source
  const cb = e.target; if(!(cb instanceof HTMLInputElement) || cb.type!=='checkbox') return;
  const boxes = Array.from($('preview').querySelectorAll('input[type=checkbox]'));
  const idx = boxes.indexOf(cb); let n = -1;
  const t = $('text').value.replace(/^(\s*[-*+]\s+)\[( |x|X)\]/gm, (m, pre, s) => { n++; return n===idx ? pre+'['+(cb.checked?'x':' ')+']' : m; });
  $('text').value = t; $('text').dispatchEvent(new Event('input'));
});

/* ---------- toolbar ---------- */
function wrap(before, after, placeholder){
  const ta = $('text'); const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s,e) || placeholder;
  ta.setRangeText(before+sel+after, s, e, 'end');
  ta.setSelectionRange(s+before.length, s+before.length+sel.length);
  ta.focus(); ta.dispatchEvent(new Event('input'));
}
function linePrefix(prefix){
  const ta = $('text'); const v = ta.value;
  const s = v.lastIndexOf('\n', ta.selectionStart-1)+1;
  ta.setRangeText(prefix, s, s, 'end'); ta.focus(); ta.dispatchEvent(new Event('input'));
}
$('tools').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  switch(b.dataset.a){
    case 'h': linePrefix('## '); break;
    case 'b': wrap('**','**','bold'); break;
    case 'i': wrap('*','*','italic'); break;
    case 'ul': linePrefix('- '); break;
    case 'task': linePrefix('- [ ] '); break;
    case 'quote': linePrefix('> '); break;
    case 'code': wrap('`','`','code'); break;
    case 'link': wrap('[','](https://)','text'); break;
    case 'date': wrap(new Date().toISOString().slice(0,10),'',''); break;
  }
});
// continue lists on Enter
$('text').addEventListener('keydown', e => {
  if(e.key!=='Enter' || e.shiftKey) return;
  const ta = e.target; const v = ta.value; const pos = ta.selectionStart;
  const ls = v.lastIndexOf('\n', pos-1)+1; const line = v.slice(ls, pos);
  const m = line.match(/^(\s*)([-*+]|\d+\.)\s(\[[ xX]\]\s)?/);
  if(!m) return;
  e.preventDefault();
  if(line.trim() === m[0].trim()){ ta.setRangeText('', ls, pos, 'end'); }
  else{
    let marker = m[2]; if(/\d+\./.test(marker)) marker = (parseInt(marker)+1)+'.';
    ta.setRangeText('\n'+m[1]+marker+' '+(m[3]?'[ ] ':''), pos, pos, 'end');
  }
  ta.dispatchEvent(new Event('input'));
});

/* ---------- menu: rename / reload / delete ---------- */
$('moreBtn').onclick = e => { e.stopPropagation(); $('menu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('menu').classList.add('hidden'));
$('mReload').onclick = () => { if(!cur) return; if(dirty && !confirm('Discard your unsaved changes and reload from GitHub?')) return; const p=cur.path; LS.del('draft:'+p); LS.del('note:'+p); dirty=false; openNote(p); };
$('mDelete').onclick = async () => {
  if(!cur) return;
  if(!confirm(`Delete “${cur.path}” from the repo? This creates a commit that removes the file.`)) return;
  if(cur.isNew || !cur.sha){ LS.del('draft:'+cur.path); dirty=false; cur=null; show('listView'); renderList(); return; }
  try{
    await gh(`/repos/${cfg.repo}/contents/${encPath(cur.path)}`, {method:'DELETE', body: JSON.stringify({message:'Delete '+cur.path, sha:cur.sha, branch:cfg.branch})});
    tree = tree.filter(t => t.path!==cur.path); LS.set('tree', tree);
    LS.del('note:'+cur.path); LS.del('draft:'+cur.path);
    dirty=false; cur=null; show('listView'); renderList(); toast('Deleted');
  }catch(e){ setStatus(friendly(e),'err'); }
};
$('mRename').onclick = async () => {
  if(!cur) return;
  if(cur.isNew){ const np = askPath(cur.path); if(np){ LS.del('draft:'+cur.path); cur.path = np; $('notePath').textContent=np; $('noteTitle').firstChild.nodeValue=titleOf(np.split('/').pop()); LS.set('draft:'+np, $('text').value);} return; }
  if(dirty){ toast('Save your changes first, then rename.', 3500); return; }
  const np = askPath(cur.path); if(!np || np===cur.path) return;
  try{
    setStatus('Renaming…');
    const text = cur.text;
    const created = await gh(`/repos/${cfg.repo}/contents/${encPath(np)}`, {method:'PUT', body: JSON.stringify({message:`Move ${cur.path} to ${np}`, content:b64(text), branch:cfg.branch})});
    await gh(`/repos/${cfg.repo}/contents/${encPath(cur.path)}`, {method:'DELETE', body: JSON.stringify({message:`Move ${cur.path} to ${np}`, sha:cur.sha, branch:cfg.branch})});
    tree = tree.filter(t => t.path!==cur.path); tree.push({path:np, sha:created.content.sha}); LS.set('tree', tree);
    LS.del('note:'+cur.path); LS.set('note:'+np, {sha:created.content.sha, text});
    cur.path = np; cur.sha = created.content.sha;
    $('notePath').textContent=np; $('noteTitle').firstChild.nodeValue=titleOf(np.split('/').pop());
    markDirty(false); toast('Moved');
  }catch(e){ setStatus(friendly(e),'err'); }
};
function askPath(def){
  let p = prompt('Note path (use / for folders)', def); if(p===null) return null;
  p = p.trim().replace(/^\/+/,'').replace(/\/{2,}/g,'/'); if(!p) return null;
  if(!/\.[A-Za-z0-9]+$/.test(p)) p += '.md';
  return p;
}

/* ---------- new note ---------- */
$('newBtn').onclick = () => {
  if(!cfg.repo || !cfg.token){ openSettings(); return; }
  const base = (cfg.folder||'').replace(/^\/+|\/+$/g,'');
  const stamp = new Date().toISOString().slice(0,10);
  let p = askPath((base? base+'/' : '') + stamp + ' untitled.md'); if(!p) return;
  if(tree.some(t => t.path===p)){ toast('That note already exists, opening it.'); openNote(p); return; }
  openNote(p, {isNew:true});
};

/* ---------- settings ---------- */
function openSettings(){
  $('fRepo').value = cfg.repo||''; $('fToken').value = cfg.token||''; $('fBranch').value = cfg.branch||''; $('fFolder').value = cfg.folder||''; $('fTheme').value = cfg.theme||'auto';
  $('settingsMsg').classList.add('hidden');
  $('settingsView').classList.remove('hidden');
}
$('settingsBtn').onclick = openSettings;
$('settingsBack').onclick = () => $('settingsView').classList.add('hidden');
$('saveSettings').onclick = async () => {
  const repo = parseRepo($('fRepo').value); const token = $('fToken').value.trim();
  const msg = $('settingsMsg');
  if(!repo){ msg.textContent='Enter the repo as a GitHub URL or owner/name.'; msg.className='msg err'; return; }
  if(!token){ msg.textContent='Enter your personal access token.'; msg.className='msg err'; return; }
  const changedRepo = repo!==cfg.repo;
  cfg = {repo, token, branch: $('fBranch').value.trim(), folder: $('fFolder').value.trim(), theme: $('fTheme').value};
  if(changedRepo && !$('fBranch').value.trim()) cfg.branch='';
  LS.set('cfg', cfg); applyTheme();
  msg.textContent='Connecting…'; msg.className='msg';
  try{
    const info = await gh(`/repos/${repo}`);
    if(!cfg.branch){ cfg.branch = info.default_branch; LS.set('cfg', cfg); }
    if(info.permissions && info.permissions.push===false){ msg.textContent='Connected, but this token is read-only. You can read notes but not save them.'; msg.className='msg err'; }
    else { msg.textContent='Connected to '+info.full_name+' ('+cfg.branch+').'; msg.className='msg'; }
    await sync(true); updateTitle();
    if(!msg.classList.contains('err')) setTimeout(() => $('settingsView').classList.add('hidden'), 700);
  }catch(e){ msg.textContent = friendly(e); msg.className='msg err'; }
};
$('clearData').onclick = () => {
  if(!confirm('Remove the token, settings and all offline notes and drafts from this device? Nothing on GitHub is touched.')) return;
  try{ localStorage.clear(); }catch{}
  cfg = {repo:'', token:'', branch:'', folder:'', theme:'auto'}; tree=[]; cur=null; dirty=false;
  applyTheme(); updateTitle(); renderList(); $('settingsView').classList.add('hidden');
};
function updateTitle(){
  $('repoTitle').firstChild.nodeValue = cfg.repo ? cfg.repo.split('/')[1] : 'GitNotes';
  $('repoSub').textContent = cfg.repo ? (cfg.repo.split('/')[0] + (cfg.branch ? ' · '+cfg.branch : '')) : '';
}

/* ---------- markdown ---------- */
function inline(s){
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m,c) => { codes.push(c); return '\u0000'+(codes.length-1)+'\u0000'; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m,a,u) => /^https?:/i.test(u) ? `<img src="${u}" alt="${a}" style="max-width:100%">` : esc(a||u));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m,t,u) => /^(https?:|mailto:|#)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m,a,b) => `<strong>${a||b}</strong>`);
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m,i) => '<code>'+esc(codes[i])+'</code>');
  return s;
}
function md(src){
  const lines = src.replace(/\r\n?/g,'\n').split('\n');
  let out = '', i = 0;
  const isBlockStart = l => /^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s|\s*([-*_]\s*){3,}$|\|)/.test(l);
  while(i < lines.length){
    const l = lines[i];
    if(/^```/.test(l)){
      const buf=[]; i++;
      while(i<lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    if(!l.trim()){ i++; continue; }
    let m;
    if((m = l.match(/^(#{1,6})\s+(.*)$/))){ out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
    if(/^\s*([-*_]\s*){3,}$/.test(l)){ out += '<hr>'; i++; continue; }
    if(/^>\s?/.test(l)){
      const buf=[]; while(i<lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/,''));
      out += `<blockquote>${md(buf.join('\n'))}</blockquote>`; continue;
    }
    if(/^\s*([-*+]|\d+\.)\s/.test(l)){
      const ordered = /^\s*\d+\./.test(l); const items=[];
      while(i<lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[i])){
        let t = lines[i].replace(/^\s*([-*+]|\d+\.)\s/,''); let task='';
        const tm = t.match(/^\[( |x|X)\]\s+(.*)$/);
        if(tm){ task = `<input type="checkbox" ${tm[1]===' '?'':'checked'}>`; t = tm[2]; }
        items.push(`<li${task?' class="task"':''}>${task}${inline(t)}</li>`); i++;
      }
      out += `<${ordered?'ol':'ul'}>${items.join('')}</${ordered?'ol':'ul'}>`; continue;
    }
    if(/^\|/.test(l) && i+1<lines.length && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i+1])){
      const cells = r => r.replace(/^\||\|$/g,'').split('|').map(c => c.trim());
      const head = cells(l); i += 2; const rows=[];
      while(i<lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out += '<table><thead><tr>'+head.map(c=>`<th>${inline(c)}</th>`).join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>`<td>${inline(c)}</td>`).join('')+'</tr>').join('')+'</tbody></table>'; continue;
    }
    const buf=[]; while(i<lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    if(!buf.length){ buf.push(lines[i++]); }
    out += `<p>${inline(buf.join('\n')).replace(/\n/g,'<br>')}</p>`;
  }
  return out || '<p style="color:var(--slate)">Nothing to show yet.</p>';
}

/* ---------- boot ---------- */
applyTheme(); updateTitle(); show('listView'); renderList();
if(cfg.repo && cfg.token){ sync(true); } else { openSettings(); }
window.addEventListener('beforeunload', e => { if(dirty){ e.preventDefault(); e.returnValue=''; } });
window.addEventListener('online', () => { if(!dirty) sync(true); });
if('serviceWorker' in navigator){ window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(()=>{})); }
})();
