(() => {
  'use strict';

  const LS_KEY = 'electiveFinalPresentationPeerReview.v1';
  const STUDENT_ID_KEY = 'electiveFinalPresentationPeerReview.studentIdentity.v1';
  const LAST_SESSION_KEY = 'electiveFinalPresentationPeerReview.lastSession.v1';
  const PENDING_KEY_PREFIX = 'electiveFinalPresentationPeerReview.pending.';
  const PHASE_LABEL = { setup: '設定中', report: '報告時間', rating: '評分／換場時間', done: '已完成' };
  const CRITERIA = [
    { key: 'content', short: '內容重點', label: '內容重點清楚', description: '主題明確、重點聚焦、能在 1 分鐘內讓人聽懂。', avgId: 'contentAvg' },
    { key: 'insight', short: '學習收穫', label: '學習收穫／個人觀點', description: '能說出自己的收穫、觀察、反思或延伸想法。', avgId: 'insightAvg' },
    { key: 'delivery', short: '表達時間', label: '口語表達與時間掌握', description: '聲音清楚、節奏適當、時間控制佳。', avgId: 'deliveryAvg' },
  ];
  const SAMPLE_ROSTER = ['01 王小明', '02 李小華', '03 陳怡君', '04 林承恩', '05 張雅婷', '06 黃柏翰', '07 吳佳蓉', '08 劉宇翔'];

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sessionFromUrl = params.get('session') || '';
  const eventFromUrl = params.get('event') || '';
  const peerServerFromUrl = params.get('server') || 'cloud';
  const isStudentMode = Boolean(sessionFromUrl);
  const now = () => Date.now();
  const safeText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const randomCode = (len = 6) => Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

  let state = null;
  const PEER_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // Public Open Relay TURN credentials are intentionally public; they improve classroom networks
    // that block direct WebRTC/UDP paths. If the relay is unavailable, PeerJS still falls back to STUN.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  const PEER_SERVERS = [
    { key: 'cloud', label: 'PeerJS Cloud', options: { host: '0.peerjs.com', port: 443, path: '/', secure: true, key: 'peerjs' } },
    { key: 'backup', label: '備援 PeerServer', options: { host: 'peerjs-server.onrender.com', port: 443, path: '/', secure: true, key: 'peerjs' } },
  ];
  const STUDENT_CONNECT_TIMEOUT_MS = 8500;
  const TEACHER_OPEN_TIMEOUT_MS = 12000;

  function peerServerByKey(key) {
    return PEER_SERVERS.find((server) => server.key === key) || PEER_SERVERS[0];
  }

  function peerOptions(key, debug = 1) {
    return { ...peerServerByKey(key).options, debug, config: { iceServers: PEER_ICE_SERVERS } };
  }

  let teacherPeer = null;
  let teacherConnections = new Map();
  let teacherSessionReady = false;
  let teacherOpenTimer = null;
  let studentPeer = null;
  let studentConn = null;
  let studentState = null;
  let reconnectTimer = null;
  let studentConnectTimer = null;
  let reconnectAttempt = 0;
  let lastBellKey = '';
  state = loadState();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function personLabel(p) {
    if (!p) return '—';
    return `${p.seatNo ? p.seatNo + ' ' : ''}${p.name}`;
  }

  function defaultRoster() {
    return parseRoster(SAMPLE_ROSTER.join('\n'));
  }

  function defaultState() {
    const roster = defaultRoster();
    return {
      schemaVersion: 1,
      title: '多元選修期末發表',
      eventId: `event-${randomCode(8)}`,
      sessionId: '',
      peerServerKey: 'cloud',
      roster,
      order: randomShuffle(roster.map((p) => p.id)),
      currentIndex: 0,
      phase: 'setup',
      durations: { report: 60, rating: 60 },
      timer: { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null },
      scores: {},
      updatedAt: new Date().toISOString(),
    };
  }

  function loadState() {
    const base = defaultState();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return base;
      return normalizeState(JSON.parse(raw), base);
    } catch (_) {
      return base;
    }
  }

  function normalizeState(parsed, base = defaultState()) {
    const roster = Array.isArray(parsed.roster) && parsed.roster.length ? parsed.roster.map(normalizePerson).filter(Boolean) : base.roster;
    const rosterIds = new Set(roster.map((p) => p.id));
    let order = Array.isArray(parsed.order) ? parsed.order.filter((id) => rosterIds.has(id)) : [];
    for (const id of rosterIds) if (!order.includes(id)) order.push(id);
    if (!order.length) order = randomShuffle(roster.map((p) => p.id));
    return {
      ...base,
      ...parsed,
      schemaVersion: 1,
      peerServerKey: peerServerByKey(parsed.peerServerKey).key,
      roster,
      order,
      currentIndex: clamp(Number(parsed.currentIndex || 0), 0, Math.max(0, order.length - 1)),
      durations: {
        report: clamp(Number(parsed.durations?.report || 60), 20, 600),
        rating: clamp(Number(parsed.durations?.rating || 60), 20, 600),
      },
      timer: parsed.timer || base.timer,
      scores: parsed.scores || {},
    };
  }

  function normalizePerson(p) {
    const name = safeText(p?.name);
    if (!name) return null;
    const seatNo = safeText(p?.seatNo);
    const id = safeText(p?.id) || makePersonId(seatNo, name, 0);
    return { id, seatNo, name };
  }

  function saveState() {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function makePersonId(seatNo, name, index) {
    const base = `${seatNo || String(index + 1).padStart(2, '0')}-${name}`
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    return base || `student-${index + 1}`;
  }

  function parseRoster(raw) {
    const rows = String(raw || '')
      .split(/[\n;；]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const used = new Set();
    const roster = [];
    rows.forEach((line, index) => {
      const cells = line.split(/[\t,，]+/).map((x) => x.trim()).filter(Boolean);
      let seatNo = '';
      let name = '';
      if (cells.length >= 2 && /^\d{1,3}$/.test(cells[0])) {
        seatNo = cells[0].padStart(2, '0');
        name = cells.slice(1).join(' ');
      } else {
        const m = line.match(/^\s*(\d{1,3})[\s、.．_-]+(.+)$/);
        if (m) {
          seatNo = m[1].padStart(2, '0');
          name = m[2].trim();
        } else {
          seatNo = String(index + 1).padStart(2, '0');
          name = line.replace(/^[-*]\s*/, '').trim();
        }
      }
      name = safeText(name);
      if (!name) return;
      let id = makePersonId(seatNo, name, index);
      let suffix = 2;
      while (used.has(id)) id = `${makePersonId(seatNo, name, index)}-${suffix++}`;
      used.add(id);
      roster.push({ id, seatNo, name });
    });
    return roster;
  }

  function rosterText(roster = state.roster) {
    return roster.map((p) => `${p.seatNo ? p.seatNo + ' ' : ''}${p.name}`).join('\n');
  }

  function randomShuffle(arr) {
    const out = arr.slice();
    if (!out.length) return out;
    const bytes = new Uint32Array(out.length);
    crypto.getRandomValues(bytes);
    for (let i = out.length - 1; i > 0; i--) {
      const j = bytes[i] % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function getPerson(id, s = state) {
    return (s.roster || []).find((p) => p.id === id) || null;
  }

  function currentContext(s = state) {
    const total = s.order?.length || 0;
    if (!total) return { index: 0, roundNo: 0, total: 0, presenterId: '', presenter: null, nextId: '', next: null };
    const index = clamp(Number(s.currentIndex || 0), 0, total - 1);
    const presenterId = s.order[index];
    const nextId = s.order[index + 1] || '';
    return { index, roundNo: index + 1, total, presenterId, presenter: getPerson(presenterId, s), nextId, next: getPerson(nextId, s) };
  }

  function timerView(s = state) {
    const t = s.timer || {};
    let remaining = Number(t.duration || 0);
    let done = false;
    if (t.running && t.endsAt) {
      remaining = Math.max(0, Math.ceil((t.endsAt - now()) / 1000));
      done = remaining <= 0;
    }
    return { ...t, remaining, done, label: PHASE_LABEL[t.phase || s.phase] || '設定中' };
  }

  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  function validScore(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 10;
  }

  function avg(values) {
    const nums = values.map(Number).filter(Number.isFinite);
    return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
  }

  function scoreText(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function presenterRecords(presenterId, s = state) {
    return Object.values(s.scores?.[presenterId] || {}).map(normalizeScoreRecord).filter(Boolean);
  }

  function normalizeScoreRecord(record) {
    if (!record) return null;
    const scores = {};
    for (const c of CRITERIA) {
      if (validScore(record.scores?.[c.key])) scores[c.key] = Number(record.scores[c.key]);
    }
    return {
      ...record,
      scores,
      total: avg(CRITERIA.map((c) => scores[c.key])),
      comment: safeText(record.comment),
    };
  }

  function presenterStats(presenterId, s = state) {
    const presenter = getPerson(presenterId, s);
    const records = presenterRecords(presenterId, s).filter((r) => r.evaluatorId !== presenterId);
    const submitted = new Set(records.map((r) => r.evaluatorId));
    const expected = (s.roster || []).filter((p) => p.id !== presenterId);
    const missing = expected.filter((p) => !submitted.has(p.id));
    const criteriaAvgs = {};
    for (const c of CRITERIA) criteriaAvgs[c.key] = avg(records.map((r) => r.scores?.[c.key]));
    return {
      presenter,
      responseCount: records.length,
      expectedCount: expected.length,
      missing,
      criteriaAvgs,
      overallAvg: avg(records.map((r) => r.total)),
    };
  }

  function publicState() {
    return {
      title: state.title,
      eventId: state.eventId,
      peerServerKey: state.peerServerKey,
      peerServerLabel: peerServerByKey(state.peerServerKey).label,
      roster: state.roster,
      order: state.order,
      currentIndex: state.currentIndex,
      phase: state.phase,
      phaseLabel: PHASE_LABEL[state.phase] || '設定中',
      timer: timerView(state),
      current: currentContext(state),
      criteria: CRITERIA.map(({ key, short, label, description }) => ({ key, short, label, description })),
      updatedAt: state.updatedAt,
    };
  }

  function bell() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18, 0.36].forEach((delay) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.16);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + 0.18);
      });
    } catch (e) { console.warn(e); }
  }

  function startPhase(phase, duration) {
    state.phase = phase;
    state.timer = { running: true, phase, duration, startedAt: now(), endsAt: now() + duration * 1000 };
    saveState();
    renderTeacher();
    broadcastState();
    bell();
  }

  function setupTeacher() {
    $('teacherApp').classList.remove('hidden');
    $('titleInput').value = state.title;
    $('rosterInput').value = rosterText();
    $('reportSecondsInput').value = state.durations.report;
    $('ratingSecondsInput').value = state.durations.rating;
    updateRosterHint();

    $('rosterInput').addEventListener('input', updateRosterHint);
    $('saveShuffleBtn').onclick = () => saveRosterAndShuffle(true);
    $('reshuffleBtn').onclick = () => saveRosterAndShuffle(true);
    $('resetScoresBtn').onclick = () => {
      if (confirm('確定要清空所有評分資料？')) {
        state.scores = {};
        saveState(); renderTeacher(); broadcastState();
      }
    };
    $('startSessionBtn').onclick = startTeacherSession;
    $('copyStudentUrlBtn').onclick = () => copyText($('studentUrl').textContent, '已複製學生網址');
    $('copySessionCodeBtn').onclick = () => copyText(state.sessionId || '', '已複製 session 代碼');
    $('startReportBtn').onclick = () => startPhase('report', state.durations.report);
    $('startRatingBtn').onclick = () => startPhase('rating', state.durations.rating);
    $('nextPresenterBtn').onclick = () => {
      const ctx = currentContext();
      if (ctx.index < ctx.total - 1) {
        state.currentIndex = ctx.index + 1;
        startPhase('report', state.durations.report);
      } else {
        finishActivity();
      }
    };
    $('finishBtn').onclick = finishActivity;
    $('exportXlsxBtn').onclick = exportXlsx;
    $('exportJsonBtn').onclick = exportJson;
    $('importJsonInput').onchange = importJson;
    renderTeacher();
    if (state.sessionId) {
      $('sessionStatus').textContent = '正在重新啟用上次 Session…';
      setTimeout(startTeacherSession, 250);
    }
    setInterval(() => {
      renderTeacher(false);
      const tv = timerView();
      const key = `${state.phase}:${state.currentIndex}:${tv.done}`;
      if (tv.done && state.timer?.running && key !== lastBellKey) {
        lastBellKey = key;
        bell();
      }
    }, 1000);
  }

  function saveRosterAndShuffle(clearScores) {
    const roster = parseRoster($('rosterInput').value);
    if (roster.length < 2) return alert('至少需要 2 位學生。');
    state.title = safeText($('titleInput').value) || '多元選修期末發表';
    state.roster = roster;
    state.order = randomShuffle(roster.map((p) => p.id));
    state.currentIndex = 0;
    state.phase = 'setup';
    state.durations = {
      report: clamp(Number($('reportSecondsInput').value) || 60, 20, 600),
      rating: clamp(Number($('ratingSecondsInput').value) || 60, 20, 600),
    };
    state.timer = { running: false, phase: 'setup', duration: 0, startedAt: null, endsAt: null };
    if (clearScores) state.scores = {};
    if (!state.eventId) state.eventId = `event-${randomCode(8)}`;
    saveState(); renderTeacher(); broadcastState();
  }

  function updateRosterHint() {
    const count = parseRoster($('rosterInput')?.value || '').length;
    if ($('rosterHint')) $('rosterHint').textContent = `目前 ${count} 人`;
  }

  function finishActivity() {
    state.phase = 'done';
    state.timer = { running: false, phase: 'done', duration: 0, startedAt: null, endsAt: null };
    saveState(); renderTeacher(); broadcastState();
    alert('活動已結束。記得下載 Excel / JSON 備份。');
  }

  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); alert(okMsg); }
    catch (_) { prompt('請複製', text); }
  }

  function startTeacherSession(serverKey = state.peerServerKey || 'cloud', triedServers = []) {
    if (typeof serverKey !== 'string') {
      serverKey = state.peerServerKey || 'cloud';
      triedServers = [];
    }
    if (!window.Peer) return alert('PeerJS 尚未載入，請確認網路可連到 CDN。');
    if (teacherPeer && !teacherPeer.destroyed && teacherSessionReady && state.peerServerKey === serverKey) return;
    if (teacherPeer && !teacherPeer.destroyed && !teacherSessionReady) {
      try { teacherPeer.destroy(); } catch (_) {}
    }
    teacherSessionReady = false;
    teacherConnections.clear();
    clearTimeout(teacherOpenTimer);
    if (!state.sessionId) state.sessionId = `mep-${randomCode(7).toLowerCase()}`;
    state.peerServerKey = peerServerByKey(serverKey).key;
    saveState();
    $('sessionStatus').textContent = `建立中…（${peerServerByKey(state.peerServerKey).label}）`;
    renderTeacher(false);
    teacherPeer = new Peer(state.sessionId, peerOptions(state.peerServerKey, 1));
    const tried = Array.from(new Set([...triedServers, state.peerServerKey]));
    const retryWithNextServer = (reason) => {
      clearTimeout(teacherOpenTimer);
      try { teacherPeer?.destroy(); } catch (_) {}
      teacherPeer = null;
      teacherSessionReady = false;
      teacherConnections.clear();
      const next = PEER_SERVERS.find((server) => !tried.includes(server.key));
      if (!next) {
        $('sessionStatus').textContent = `連線錯誤：${reason}。兩個即時通道都連不上，請換網路/手機熱點後再按建立 Session。`;
        renderTeacher(false);
        return;
      }
      state.peerServerKey = next.key;
      saveState();
      $('sessionStatus').textContent = `連線錯誤：${reason}，改用${next.label}重試…`;
      renderTeacher(false);
      setTimeout(() => startTeacherSession(next.key, tried), 700);
    };
    teacherOpenTimer = setTimeout(() => {
      if (teacherSessionReady) return;
      console.warn('Teacher PeerJS open timeout; retrying with another PeerServer.');
      retryWithNextServer('建立逾時');
    }, TEACHER_OPEN_TIMEOUT_MS);
    teacherPeer.on('open', (id) => {
      clearTimeout(teacherOpenTimer);
      teacherSessionReady = true;
      state.sessionId = id;
      saveState();
      $('sessionStatus').textContent = `已建立：${id}（${peerServerByKey(state.peerServerKey).label}）`;
      updateStudentUrl(id);
      renderTeacher(false);
    });
    teacherPeer.on('connection', setupTeacherConnection);
    teacherPeer.on('error', (err) => {
      console.error(err);
      clearTimeout(teacherOpenTimer);
      teacherSessionReady = false;
      if (err?.type === 'unavailable-id') {
        state.sessionId = `mep-${randomCode(7).toLowerCase()}`;
        saveState();
        try { teacherPeer?.destroy(); } catch (_) {}
        teacherPeer = null;
        renderTeacher(false);
        setTimeout(() => startTeacherSession(state.peerServerKey, triedServers), 800);
        return;
      }
      if (err?.type === 'network' || err?.type === 'server-error' || err?.type === 'socket-error' || err?.type === 'socket-closed') {
        retryWithNextServer(err.type);
        return;
      }
      $('sessionStatus').textContent = `連線錯誤：${err?.type || err?.message || '未知錯誤'}，請再按一次建立 Session`;
      renderTeacher(false);
    });
  }

  function setupTeacherConnection(conn) {
    teacherConnections.set(conn.peer, conn);
    conn.on('open', () => sendState(conn));
    conn.on('data', (msg) => handleTeacherMessage(conn, msg));
    conn.on('close', () => { teacherConnections.delete(conn.peer); renderTeacher(false); });
    conn.on('error', () => { teacherConnections.delete(conn.peer); renderTeacher(false); });
    renderTeacher(false);
  }

  function handleTeacherMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      sendState(conn);
      return;
    }
    if (msg.type === 'score') {
      const result = applyScoreRecord(msg.payload || {});
      conn.send({ type: 'ack', clientId: msg.payload?.clientId, ok: result.ok, message: result.message, savedAt: new Date().toISOString() });
      if (result.ok) {
        saveState(); renderTeacher(); broadcastState();
      }
    }
  }

  function applyScoreRecord(payload) {
    const presenterId = safeText(payload.presenterId);
    const evaluatorId = safeText(payload.evaluatorId);
    if (!presenterId || !evaluatorId) return { ok: false, message: '缺少報告者或評分者。' };
    if (presenterId === evaluatorId) return { ok: false, message: '不能評自己的發表。' };
    if (!getPerson(presenterId) || !getPerson(evaluatorId)) return { ok: false, message: '名單資料不一致，請重新整理。' };
    const scores = {};
    for (const c of CRITERIA) {
      if (!validScore(payload.scores?.[c.key])) return { ok: false, message: `請確認「${c.short}」分數。` };
      scores[c.key] = Number(payload.scores[c.key]);
    }
    state.scores[presenterId] ||= {};
    state.scores[presenterId][evaluatorId] = {
      presenterId,
      evaluatorId,
      scores,
      total: avg(CRITERIA.map((c) => scores[c.key])),
      comment: safeText(payload.comment),
      clientId: safeText(payload.clientId),
      submittedAt: new Date().toISOString(),
      updatedFrom: payload.updatedFrom || 'student',
    };
    return { ok: true, message: '已收到評分。' };
  }

  function sendState(conn) {
    try { conn.send({ type: 'state', payload: publicState() }); } catch (e) { console.warn(e); }
  }

  function broadcastState() {
    for (const conn of teacherConnections.values()) {
      if (conn.open) sendState(conn);
    }
  }

  function updateStudentUrl(id = state.sessionId) {
    if (!id) return;
    const url = `${location.origin}${location.pathname}?session=${encodeURIComponent(id)}&event=${encodeURIComponent(state.eventId)}&server=${encodeURIComponent(state.peerServerKey || 'cloud')}`;
    $('studentUrl').textContent = url;
    $('sessionCodeText').textContent = `${id}（${peerServerByKey(state.peerServerKey).label}）`;
    if (window.QRious) {
      new QRious({ element: $('qrCanvas'), value: url, size: 230, padding: 10, level: 'M' });
    }
  }

  function renderTeacher(updateAll = true) {
    const ctx = currentContext();
    const tv = timerView();
    if (updateAll) {
      $('titleInput').value = state.title;
      $('reportSecondsInput').value = state.durations.report;
      $('ratingSecondsInput').value = state.durations.rating;
    }
    $('roundInfo').textContent = ctx.total ? `第 ${ctx.roundNo} / ${ctx.total} 位` : '尚未抽籤';
    $('phaseLabel').textContent = tv.label;
    $('timerText').textContent = mmss(tv.remaining);
    const pct = tv.duration ? clamp(((tv.duration - tv.remaining) / tv.duration) * 100, 0, 100) : 0;
    $('timerBar').style.width = `${pct}%`;
    $('currentPresenter').textContent = personLabel(ctx.presenter);
    $('nextPresenter').textContent = ctx.next ? personLabel(ctx.next) : '最後一位';
    $('connectionCount').textContent = String([...teacherConnections.values()].filter((c) => c.open).length);
    if (teacherSessionReady && state.sessionId) updateStudentUrl(state.sessionId);
    else {
      $('sessionCodeText').textContent = state.sessionId ? `${state.sessionId}（${peerServerByKey(state.peerServerKey).label} 未啟用）` : '—';
      $('studentUrl').textContent = state.sessionId ? 'Session 尚未啟用，請等狀態顯示「已建立」後再讓學生掃 QR。' : '尚未建立 session';
      const canvas = $('qrCanvas');
      const ctx2d = canvas?.getContext?.('2d');
      if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }
    const stats = presenterStats(ctx.presenterId);
    $('overallAvg').textContent = scoreText(stats.overallAvg);
    for (const c of CRITERIA) $(c.avgId).textContent = scoreText(stats.criteriaAvgs[c.key]);
    $('scoreCount').textContent = `${stats.responseCount} / ${stats.expectedCount}`;
    $('missingCount').textContent = String(stats.missing.length);
    $('missingStudents').textContent = `尚未評分：${stats.missing.length ? stats.missing.map(personLabel).join('、') : '—'}`;
    renderOrderTable();
    renderStatsTable();
  }

  function renderOrderTable() {
    const rows = (state.order || []).map((id, i) => {
      const p = getPerson(id);
      const st = presenterStats(id);
      return `<tr class="${i === state.currentIndex ? 'current' : ''}"><td>${i + 1}</td><td>${escapeHtml(p?.seatNo || '')}</td><td>${escapeHtml(p?.name || '')}</td><td>${scoreText(st.overallAvg)}</td><td>${st.responseCount}/${st.expectedCount}</td></tr>`;
    }).join('');
    $('orderTable').innerHTML = `<thead><tr><th>順序</th><th>座號</th><th>姓名</th><th>平均</th><th>評分進度</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function renderStatsTable() {
    const rows = (state.order || []).map((id, i) => {
      const p = getPerson(id);
      const st = presenterStats(id);
      return `<tr class="${i === state.currentIndex ? 'current' : ''}"><td>${i + 1}</td><td>${escapeHtml(personLabel(p))}</td><td>${scoreText(st.overallAvg)}</td>${CRITERIA.map((c) => `<td>${scoreText(st.criteriaAvgs[c.key])}</td>`).join('')}<td>${st.responseCount}</td><td>${st.missing.length}</td></tr>`;
    }).join('');
    $('statsTable').innerHTML = `<thead><tr><th>順序</th><th>報告者</th><th>總平均</th>${CRITERIA.map((c) => `<th>${c.short}</th>`).join('')}<th>筆數</th><th>待補</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function setupStudent() {
    $('studentApp').classList.remove('hidden');
    saveLastSession();
    setupRangeLabels();
    $('studentSelect').onchange = () => saveStudentIdentity($('studentSelect').value);
    $('submitScoreBtn').onclick = submitStudentScore;
    connectStudent();
    setInterval(renderStudent, 1000);
  }

  function setupRangeLabels() {
    for (const c of CRITERIA) {
      const input = $(`score_${c.key}`);
      const text = $(`score_${c.key}_Text`);
      if (input && text) input.oninput = () => { text.textContent = input.value; };
    }
  }

  function saveLastSession() {
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ session: sessionFromUrl, event: eventFromUrl, url: location.href, savedAt: new Date().toISOString() }));
  }

  function studentIdentityMap() {
    try { return JSON.parse(localStorage.getItem(STUDENT_ID_KEY) || '{}'); } catch (_) { return {}; }
  }

  function saveStudentIdentity(id) {
    const map = studentIdentityMap();
    const key = eventFromUrl || studentState?.eventId || sessionFromUrl || 'default';
    map[key] = id;
    localStorage.setItem(STUDENT_ID_KEY, JSON.stringify(map));
  }

  function loadStudentIdentity() {
    const map = studentIdentityMap();
    const key = eventFromUrl || studentState?.eventId || sessionFromUrl || 'default';
    return map[key] || '';
  }

  function connectStudent() {
    if (!window.Peer) {
      setStudentConn('PeerJS 尚未載入，請確認學生手機網路可連到 CDN。', 'bad');
      scheduleReconnect();
      return;
    }
    clearTimeout(reconnectTimer);
    clearTimeout(studentConnectTimer);
    setStudentConn(`連線中…（第 ${reconnectAttempt + 1} 次嘗試｜${peerServerByKey(peerServerFromUrl).label}）`, 'muted');
    try {
      if (studentConn && !studentConn.open) studentConn.close();
      if (studentPeer && !studentPeer.destroyed) studentPeer.destroy();
    } catch (_) {}
    studentConn = null;
    studentPeer = new Peer(undefined, peerOptions(peerServerFromUrl, 0));
    studentConnectTimer = setTimeout(() => {
      const hint = reconnectAttempt >= 2
        ? '仍連不上。請確認老師端顯示「已建立」，學生掃的是最新 QR；若全班都卡住，可能是現場網路阻擋 WebRTC，請改用手機熱點或換網路後重試。'
        : '連線較久，正在自動重試…請確認老師端已建立 Session。';
      setStudentConn(hint, 'bad');
      try { studentConn?.close(); } catch (_) {}
      try { studentPeer?.destroy(); } catch (_) {}
      scheduleReconnect();
    }, STUDENT_CONNECT_TIMEOUT_MS);
    studentPeer.on('open', () => {
      studentConn = studentPeer.connect(sessionFromUrl, { reliable: true });
      studentConn.on('open', () => {
        clearTimeout(studentConnectTimer);
        reconnectAttempt = 0;
        setStudentConn('已連線，會自動重連', 'ok');
        studentConn.send({ type: 'hello', payload: { eventId: eventFromUrl } });
        flushPendingScores();
      });
      studentConn.on('data', handleStudentMessage);
      studentConn.on('close', () => { clearTimeout(studentConnectTimer); setStudentConn('連線中斷，正在自動重連…', 'bad'); scheduleReconnect(); });
      studentConn.on('error', (err) => { clearTimeout(studentConnectTimer); setStudentConn(`連線錯誤：${err?.type || err?.message || '正在自動重連…'}`, 'bad'); scheduleReconnect(); });
    });
    studentPeer.on('error', (err) => { clearTimeout(studentConnectTimer); setStudentConn(`連線錯誤：${err?.type || err?.message || '正在自動重連…'}`, 'bad'); scheduleReconnect(); });
    studentPeer.on('disconnected', () => { clearTimeout(studentConnectTimer); setStudentConn('連線中斷，正在自動重連…', 'bad'); scheduleReconnect(); });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(15000, 900 + reconnectAttempt * 900);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connectStudent, delay);
  }

  function setStudentConn(text, tone = 'muted') {
    const el = $('studentConn');
    if (!el) return;
    el.textContent = text;
    el.className = `pill ${tone === 'ok' ? 'notice ok' : tone === 'bad' ? 'notice bad' : 'muted'}`;
  }

  function handleStudentMessage(msg) {
    if (msg?.type === 'state') {
      studentState = msg.payload;
      renderStudent();
      flushPendingScores();
    }
    if (msg?.type === 'ack') {
      if (msg.ok) removePending(msg.clientId);
      $('submitMsg').textContent = msg.message || (msg.ok ? '已送出。' : '送出失敗。');
    }
  }

  function renderStudent() {
    const s = studentState;
    if (!s) return;
    $('studentTitle').textContent = s.title || '多元選修期末發表';
    const ctx = s.current || currentContext(s);
    const tv = s.timer || { remaining: 0, label: s.phaseLabel || '設定中' };
    $('studentRoundInfo').textContent = ctx.total ? `第 ${ctx.roundNo} / ${ctx.total} 位｜${s.phaseLabel || tv.label}` : '尚未開始';
    $('studentPresenter').textContent = personLabel(ctx.presenter);
    $('studentNextPresenter').textContent = ctx.next ? personLabel(ctx.next) : '最後一位';
    $('studentTimer').textContent = mmss(tv.remaining);
    renderStudentSelect(s.roster || []);
    const evaluatorId = $('studentSelect').value;
    const disabled = !ctx.presenterId || !evaluatorId || evaluatorId === ctx.presenterId || s.phase === 'setup' || s.phase === 'done';
    $('submitScoreBtn').disabled = disabled;
    if (!evaluatorId) $('submitMsg').textContent = '請先選擇「我是誰」。';
    else if (evaluatorId === ctx.presenterId) $('submitMsg').textContent = '現在是你上台，不能評自己的發表。';
    else if (s.phase === 'setup') $('submitMsg').textContent = '等待老師開始。';
    else if (s.phase === 'done') $('submitMsg').textContent = '活動已結束。';
  }

  function renderStudentSelect(roster) {
    const select = $('studentSelect');
    const current = select.value || loadStudentIdentity();
    const html = '<option value="">請選擇你的姓名</option>' + roster.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(personLabel(p))}</option>`).join('');
    if (select.dataset.lastHtml !== html) {
      select.innerHTML = html;
      select.dataset.lastHtml = html;
    }
    if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  }

  function pendingKey() {
    return `${PENDING_KEY_PREFIX}${eventFromUrl || studentState?.eventId || sessionFromUrl}`;
  }

  function loadPending() {
    try { return JSON.parse(localStorage.getItem(pendingKey()) || '[]'); } catch (_) { return []; }
  }

  function savePending(items) {
    localStorage.setItem(pendingKey(), JSON.stringify(items));
  }

  function addPending(payload) {
    const items = loadPending().filter((p) => p.clientId !== payload.clientId);
    items.push(payload);
    savePending(items.slice(-20));
  }

  function removePending(clientId) {
    if (!clientId) return;
    savePending(loadPending().filter((p) => p.clientId !== clientId));
  }

  function flushPendingScores() {
    if (!studentConn?.open) return;
    for (const payload of loadPending()) {
      studentConn.send({ type: 'score', payload });
    }
  }

  function submitStudentScore() {
    if (!studentState) return;
    const ctx = studentState.current || currentContext(studentState);
    const evaluatorId = $('studentSelect').value;
    if (!evaluatorId) return alert('請先選擇你是誰。');
    if (evaluatorId === ctx.presenterId) return alert('不能評自己的發表。');
    saveStudentIdentity(evaluatorId);
    const scores = {};
    for (const c of CRITERIA) scores[c.key] = Number($(`score_${c.key}`).value);
    const clientId = `${ctx.presenterId}:${evaluatorId}:${Date.now()}`;
    const payload = {
      clientId,
      eventId: studentState.eventId,
      presenterId: ctx.presenterId,
      evaluatorId,
      scores,
      comment: $('studentComment').value,
      submittedAt: new Date().toISOString(),
    };
    addPending(payload);
    if (studentConn?.open) {
      studentConn.send({ type: 'score', payload });
      $('submitMsg').textContent = '已送出，等待老師端確認…';
    } else {
      $('submitMsg').textContent = '目前離線，已暫存在手機；重連後會自動補送。';
      scheduleReconnect();
    }
  }

  function exportJson() {
    downloadBlob(`${safeFileName(state.title)}_互評資料.json`, JSON.stringify(state, null, 2), 'application/json');
  }

  function importJson(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state = normalizeState(JSON.parse(reader.result));
        saveState();
        $('rosterInput').value = rosterText();
        renderTeacher(); broadcastState();
      } catch (e) { alert(`匯入失敗：${e.message}`); }
    };
    reader.readAsText(file, 'utf-8');
  }

  function exportXlsx() {
    if (!window.XLSX) return alert('XLSX 尚未載入，請確認網路可連到 CDN。');
    const summaryRows = state.order.map((id, i) => {
      const p = getPerson(id);
      const st = presenterStats(id);
      const row = {
        順序: i + 1,
        報告者座號: p?.seatNo || '',
        報告者姓名: p?.name || '',
        總平均: st.overallAvg ?? '',
        評分筆數: st.responseCount,
        預期評分人數: st.expectedCount,
        尚未評分: st.missing.map(personLabel).join('、'),
      };
      for (const c of CRITERIA) row[c.label] = st.criteriaAvgs[c.key] ?? '';
      return row;
    });
    const rawRows = [];
    for (const presenterId of state.order) {
      const presenter = getPerson(presenterId);
      for (const record of presenterRecords(presenterId)) {
        const evaluator = getPerson(record.evaluatorId);
        const row = {
          報告者座號: presenter?.seatNo || '',
          報告者姓名: presenter?.name || '',
          評分者座號: evaluator?.seatNo || '',
          評分者姓名: evaluator?.name || '',
          總分平均: record.total ?? '',
          備註: record.comment || '',
          送出時間: record.submittedAt || '',
        };
        for (const c of CRITERIA) row[c.label] = record.scores?.[c.key] ?? '';
        rawRows.push(row);
      }
    }
    const orderRows = state.order.map((id, i) => {
      const p = getPerson(id);
      return { 順序: i + 1, 座號: p?.seatNo || '', 姓名: p?.name || '' };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), '發表總表');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rawRows), '原始評分');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orderRows), '抽籤順序');
    XLSX.writeFile(wb, `${safeFileName(state.title)}_互評結果.xlsx`);
  }

  function safeFileName(name) {
    return safeText(name || '多元選修期末發表').replace(/[\\/:*?"<>|]+/g, '_');
  }

  function downloadBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function init() {
    if (isStudentMode) setupStudent();
    else setupTeacher();
    window.__mepApp = {
      getState: () => state,
      setRoster: (raw) => { $('rosterInput').value = raw; saveRosterAndShuffle(true); return state; },
      applyScoreRecord,
      currentStats: () => presenterStats(currentContext().presenterId),
      publicState,
      startPhase,
      next: () => $('nextPresenterBtn').click(),
      exportJson,
    };
  }

  init();
})();
