import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { Game, speedMultiplier, type RunResult } from './game/engine';
import { achievementCopy, badgeSvg } from './achievements/catalog';
import { AchievementTracker, type LocalAchievementState } from './achievements/tracker';
import { Renderer, COLORS } from './game/renderer';
import { DIRECTIONS, type Direction } from './game/types';
import { numberLocale, t } from './i18n';
import { Synth } from './services/audio';
import { Controls } from './services/controls';
import { Network, queueAchievement, queueRun } from './services/network';
import { bestScore, defaults, loadLocale, loadSettings, read, saveBest, saveLocale, storageAvailable, write, type LocalePreference } from './services/storage';

const app = document.querySelector<HTMLDivElement>('#app')!;
const icon = (kind: string) => ({
  play: '<path d="m9 5 11 7-11 7Z"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="M17 8q5 4 0 8M19 4q9 8 0 16"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="m17 9 5 6m0-6-5 6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  sync: '<path d="m5 12 4 4L19 6"/>',
  trophy: '<path d="M8 4h8v6a4 4 0 0 1-8 0ZM8 6H4v3q0 4 5 4m7-7h4v3q0 4-5 4m-3 1v6m-4 0h8"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
}[kind] ?? '');
const svg = (kind: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon(kind)}</svg>`;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const format = (value: number) => Math.floor(value).toLocaleString(numberLocale);
let settings = loadSettings(), game = new Game(72641), screen: 'home' | 'game' | 'over' = 'home';
let owner: string | null = null, previous = 0, accumulator = 0, lastHud = 0;
let lastCheckpoint: { runId: string; score: number; level: number } | null = null;
let pendingCapture: { direction: Direction; index: number } | null = null;
let nicknameDeferred = false, rankingRequest = 0;
let syncing = false;
const sound = new Synth(settings), network = new Network();
let deviceBest = bestScore(), runStartBest = deviceBest, recordCelebrated = false;
let recordAnimationTimeout: ReturnType<typeof setTimeout>;
let achievementTracker: AchievementTracker | null = null;

app.innerHTML = `
  <header class="topbar">
    <button class="brand" data-action="home" aria-label="${t.title}"><img src="/favicon.svg" alt=""/><span>${t.title.toUpperCase()}<small>${t.arcade}</small></span></button>
    <nav aria-label="${t.title}"><button class="nav-link active" data-action="home">${t.play}</button><button class="nav-link" data-action="ranking">${t.ranking}</button><button class="nav-link" data-action="profile">${t.profile}</button><button class="nav-link" data-action="settings">${t.settings}</button></nav>
    <div class="header-right"><span id="connection" class="connection"></span><select id="locale" class="locale-select" aria-label="${t.localeLabel}"><option value="auto">Auto</option><option value="en">English</option><option value="pt-BR">Português</option></select><button id="mute" class="icon-button" data-action="mute"></button></div>
  </header>
  <main class="arcade">
    <section class="intro" id="intro"></section>
    <section class="cabinet" aria-label="${t.board}">
      <div class="hud"><div><span>${t.score}</span><strong id="score">000000</strong></div><div class="hud-level"><span>${t.level}</span><strong id="level">01</strong></div><div class="hud-level"><span>${t.cleared}</span><strong id="cleared">0</strong></div><div class="hud-deaths"><span>${t.deaths}</span><strong id="deaths">0</strong></div></div>
      <div class="run-stats"><span>${t.peak} <b id="peak">0</b></span><span>${t.nextPenalty} <b id="penalty">−10</b></span><span>${t.speed} <b id="speed">1.00×</b></span></div>
      <div class="board-wrap"><canvas id="maze" tabindex="0" aria-label="${t.mazeLabel}"></canvas><div class="touch-stick" id="touch-stick" hidden><i></i></div><div class="pause-cover" id="pause-cover" hidden><span class="eyebrow">${t.pause.toUpperCase()}</span><h2>${t.paused}</h2><p>${t.pausedBody}</p><button class="primary" data-action="pause">${svg('play')}${t.resume}</button></div></div>
      <div class="cabinet-bottom"><span><i class="status-dot"></i><span id="mode">${t.board}</span></span><span id="board-seed"></span><div class="cabinet-actions"><button class="icon-button" id="focus-button" data-action="fullscreen" aria-label="${t.focusMode}" hidden>${svg('fullscreen')}</button><button class="icon-button" id="pause-button" data-action="pause" aria-label="${t.pause}" hidden>${svg('pause')}</button></div></div>
    </section>
    <aside class="rail">
      <div class="record-card" id="record-card"><span class="eyebrow">${t.yourRun}</span><div class="record-icon">${svg('trophy')}</div><div class="record-stats"><div><span class="micro" id="best-label">${t.localBest}</span><strong id="best">${format(deviceBest)}</strong></div><div><span class="micro">${t.currentRun}</span><strong id="current-run">0</strong></div></div><div id="account" class="account"></div></div>
      <div class="echoes"><h2 class="eyebrow">${t.echoes}</h2>${t.personalities.map((name, i) => `<div class="echo-row"><span class="echo-shape" style="--echo:${COLORS[i]}"><i></i></span><div><strong>${name}</strong><small>${t.traits[i]}</small></div></div>`).join('')}</div>
      <div class="legend"><div><i class="legend-spark"></i>${t.sparkLabel}<span>10</span></div><div><i class="legend-power"></i>${t.powerLabel}<span>50</span></div><div><i class="legend-fruit"></i>${t.fruitLabel}<span>100–1,000</span></div></div>
    </aside>
  </main>
  <footer><span>${t.footer}</span><span class="footer-legal"><a href="/privacidade/">${t.privacy}</a> · <a href="/termos/">${t.terms}</a></span><span id="offline-ready">${t.installing}</span><span>${t.edition}</span></footer>
  <div class="toast" role="status" id="toast" hidden></div>
  <div class="achievement-popups" id="achievement-popups" aria-live="polite"></div>
  <dialog id="dialog"><button class="dialog-close icon-button" data-action="close" aria-label="${t.close}">${svg('close')}</button><div id="dialog-content"></div></dialog>
`;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const canvas = $<HTMLCanvasElement>('#maze'), dialog = $<HTMLDialogElement>('#dialog'), renderer = new Renderer(canvas);
const touchStick = $('#touch-stick');
const controls = new Controls(canvas, settings, d => game.input(d), () => togglePause(), () => screen === 'game' && !dialog.open, state => {
  touchStick.hidden = !state.active;
  if (!state.active) return;
  touchStick.style.left = `${canvas.offsetLeft + state.x}px`; touchStick.style.top = `${canvas.offsetTop + state.y}px`;
  touchStick.style.setProperty('--stick-x', `${state.dx}px`); touchStick.style.setProperty('--stick-y', `${state.dy}px`);
});
let toastTimeout: ReturnType<typeof setTimeout>;
function toast(message: string) {
  $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 5500);
}
function showAchievement(slug: string, index = 0) {
  setTimeout(() => {
    sound.play('achievement');
    const copy = achievementCopy(slug, numberLocale);
    const item = document.createElement('article'); item.className = 'achievement-popup';
    item.innerHTML = `<div class="achievement-popup-art">${badgeSvg(slug)}</div><div><small>${t.achievementEarned}</small><strong>${copy.name}</strong></div>`;
    $('#achievement-popups').append(item);
    setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 360); }, 5200);
  }, index * 220);
}
function showSyncComplete() {
  sound.play('sync');
  const item = document.createElement('article'); item.className = 'achievement-popup sync-popup';
  item.innerHTML = `<div class="achievement-popup-art">${svg('sync')}</div><div><strong>${t.syncComplete}</strong></div>`;
  $('#achievement-popups').append(item);
  setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 360); }, 3200);
}
const touchDevice = () => navigator.maxTouchPoints > 0 || matchMedia('(pointer:coarse)').matches;
function updateFocusButton() {
  const button = $('#focus-button');
  button.setAttribute('aria-label', document.body.classList.contains('game-focus') ? t.exitFocusMode : t.focusMode);
}
function enterFocusMode(native = true) {
  document.body.classList.add('game-focus'); updateFocusButton();
  scrollTo(0, 0);
  if (native && !document.fullscreenElement && document.documentElement.requestFullscreen)
    void document.documentElement.requestFullscreen().catch(() => {});
}
function exitFocusMode() {
  document.body.classList.remove('game-focus'); updateFocusButton();
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}
function toggleFocusMode() {
  if (document.body.classList.contains('game-focus')) exitFocusMode(); else enterFocusMode();
}
function homeIntro() {
  $('#intro').innerHTML = `<span class="eyebrow accent"><i class="status-dot"></i>${t.homeKicker}</span>
    <h1>${t.headlineA}<br/><em>${t.headlineB}</em></h1><p class="intro-copy">${t.intro}</p>
    <div class="start-buttons">${network.session && network.nickname ? `<button class="primary" data-action="start-user">${svg('play')}${t.playAs} ${escape(network.nickname)}${svg('arrow')}</button>` : ''}
      <button class="${network.nickname ? 'secondary' : 'primary'}" data-action="start-guest">${svg('play')}${t.guest}${svg('arrow')}</button>
      ${network.session ? `<button class="text-button start-signout" data-action="signout">${t.signOut}</button>` : ''}
      ${network.session ? '' : `<button class="secondary" data-action="google"><span class="google-mark">G</span>${t.google}</button>`}
      <small>${t.guestHint}</small></div>
    <div class="instructions"><h2 class="eyebrow">${t.how}</h2>${[
      [t.howMove, t.howMoveBody], [t.howPower, t.howPowerBody], [t.howClear, t.howClearBody], [t.howSurvive, t.howSurviveBody],
    ].map(([title, body], i) => `<div class="instruction"><span>0${i + 1}</span><div><h3>${title}</h3><p>${body}</p></div></div>`).join('')}</div>`;
}
function gameIntro() {
  $('#intro').innerHTML = `<span class="eyebrow accent"><i class="status-dot"></i>${owner && network.nickname ? escape(network.nickname) : t.guest}</span>
    <h1>${t.headlineA}<br/><em>${t.headlineB}</em></h1><p class="intro-copy">${t.howSurviveBody}</p>
    <div class="play-controls"><button class="secondary" data-action="pause">${svg('pause')}${t.pause} / ${t.resume}</button><button class="text-button" data-action="home">${t.exit}${svg('arrow')}</button></div>
    <div class="instructions"><h2 class="eyebrow">${t.controls}</h2><div class="key-cluster"><kbd>↑</kbd><div><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd></div></div><p>${t.howMoveBody}</p><span class="micro">${t.pauseHint}</span></div>`;
}
function updateAccount() {
  $('#account').innerHTML = network.nickname ? `<span>${t.signedIn}<br/><b>${escape(network.nickname)}</b></span><button class="text-button" data-action="profile">${t.profile}</button><button class="text-button" data-action="signout">${t.signOut}</button>` : network.session ? `<button class="text-button" data-action="nickname">${t.chooseNickname}</button><button class="text-button" data-action="profile">${t.profile}</button><button class="text-button" data-action="signout">${t.signOut}</button>` : `<span>${t.guestHint}</span>`;
  if (screen === 'home') homeIntro();
  if (network.session && !network.nickname && network.profileReady && !nicknameDeferred && !dialog.open) showNickname();
  if (network.nickname && dialog.dataset.kind === 'nickname') closeDialog();
}
network.onChange = updateAccount;
function updateConnection() {
  const offline = !navigator.onLine;
  $('#connection').innerHTML = `<i class="status-dot ${offline ? 'amber' : syncing ? 'syncing' : ''}"></i>${offline ? t.offline : syncing ? t.updating : t.online}`;
}
function updateMute() {
  $('#mute').innerHTML = svg(settings.muted ? 'mute' : 'volume');
  $('#mute').setAttribute('aria-label', settings.muted ? t.unmute : t.mute);
  $('#mute').setAttribute('aria-pressed', String(settings.muted));
  sound.configure(settings);
}
function saveSettings() { write('settings', settings); controls.settings = settings; updateMute(); }
function resetRecordCard() {
  runStartBest = deviceBest; recordCelebrated = false; clearTimeout(recordAnimationTimeout);
  $('#record-card').classList.remove('record-hit'); $('#best-label').textContent = t.localBest;
  $('#best').textContent = format(deviceBest); $('#current-run').textContent = '0';
}
function updateRecordCard() {
  $('#current-run').textContent = format(screen === 'home' ? 0 : game.score);
  if (game.peakScore <= deviceBest) return;
  deviceBest = saveBest(game.peakScore); $('#best').textContent = format(deviceBest);
  if (recordCelebrated || game.peakScore <= runStartBest) return;
  recordCelebrated = true; $('#best-label').textContent = t.bestStrike; sound.play('record');
  const card = $('#record-card'); card.classList.remove('record-hit'); void card.offsetWidth; card.classList.add('record-hit');
  recordAnimationTimeout = setTimeout(() => card.classList.remove('record-hit'), 1800);
}
function start(authenticated: boolean) {
  if (authenticated && (!network.session || !network.nickname)) { showNickname(); return; }
  closeDialog(); owner = authenticated ? network.session!.user.id : null;
  achievementTracker = owner ? new AchievementTracker(read<LocalAchievementState>(`achievement-local:${owner}`, { unlocked: [], noobRuns: [] })) : null;
  game = new Game(); game.onSound = effect => sound.play(effect); game.onProgress = syncProgress; game.onOver = onOver;
  game.onScorePopup = event => renderer.showScorePopup(event);
  game.onAchievement = event => {
    if (!owner) return;
    queueAchievement(owner, event);
    const unlocked = achievementTracker?.consume(event) ?? [];
    unlocked.forEach((slug, index) => showAchievement(slug, index));
    if (achievementTracker) write(`achievement-local:${owner}`, achievementTracker.snapshot());
  };
  lastCheckpoint = null; resetRecordCard();
  screen = 'game'; document.body.dataset.screen = screen; gameIntro();
  $('#pause-button').hidden = false; $('#focus-button').hidden = false; $('#pause-cover').hidden = true; canvas.focus();
  if (touchDevice()) enterFocusMode();
  accumulator = 0;
}
function syncProgress(result: RunResult) {
  // Guest runs stay local. For signed-in runs, queueRun coalesces checkpoints
  // and Network.flush applies the server-side best-score/rate-limit rules.
  const newer = !lastCheckpoint || lastCheckpoint.runId !== result.runId
    || result.score > lastCheckpoint.score || result.level > lastCheckpoint.level;
  if (newer) { queueRun(owner, result); lastCheckpoint = { runId: result.runId, score: result.score, level: result.level }; }
  updateRecordCard();
}
function togglePause() {
  if (screen !== 'game') return;
  game.togglePause(); $('#pause-cover').hidden = !game.paused;
  $('#pause-button').setAttribute('aria-label', game.paused ? t.resume : t.pause);
  if (!game.paused) canvas.focus();
}
function home(force = false) {
  if (screen === 'game' && !force) {
    game.paused = true; $('#pause-cover').hidden = false;
    showDialog('leave', `<span class="eyebrow">${t.title}</span><h2>${t.abandonTitle}</h2><p>${t.abandonBody}</p><div class="dialog-actions"><button class="primary" data-action="stay">${t.stay}</button><button class="secondary" data-action="leave">${t.leave}</button></div>`); return;
  }
  closeDialog(); exitFocusMode(); screen = 'home'; game = new Game(72641); owner = null;
  document.body.dataset.screen = screen; $('#pause-button').hidden = true; $('#focus-button').hidden = true; $('#pause-cover').hidden = true; resetRecordCard(); homeIntro();
}
async function onOver(result: RunResult) {
  exitFocusMode();
  screen = 'over'; document.body.dataset.screen = screen; $('#pause-button').hidden = true;
  $('#focus-button').hidden = true;
  updateRecordCard(); const best = deviceBest;
  // Ownership is captured at the START, never inferred from a later session.
  syncProgress(result);
  $('#intro').innerHTML = `<span class="eyebrow accent">${t.over}</span><h1>${t.lights}<br/><em>${t.out}</em></h1><p class="intro-copy">${t.overBody}</p>
    <div class="final-scores"><div><span class="micro">${t.finalScore}</span><strong>${format(result.score)}</strong></div><div><span class="micro">${t.record}</span><strong>${format(best)}</strong></div></div>
    <p class="run-summary">${t.finalBalance}: ${format(result.balance ?? 0)}<br/>${t.deaths}: ${result.deaths ?? 0} · ${t.cleared}: ${result.cleared ?? 0}</p>
    <p class="sync-status" id="sync-status">${owner ? t.pending : t.localOnly}</p><button class="primary" data-action="again">${svg('play')}${t.again}${svg('arrow')}</button><button class="text-button" data-action="ranking">${t.ranking}${svg('arrow')}</button><button class="text-button" data-action="home">${t.menu}</button>`;
  if (owner) {
    const state = (await network.flushPending())[0];
    if (screen === 'over' && $('#sync-status')) $('#sync-status').textContent = state === 'synced' ? t.synced : state === 'rejected' ? t.syncRejected : t.pending;
  }
}
function showDialog(kind: string, html: string) {
  if (screen === 'game') { game.paused = true; $('#pause-cover').hidden = false; }
  dialog.dataset.kind = kind; $('#dialog-content').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
function closeDialog() { pendingCapture = null; controls.capturing = false; dialog.close(); dialog.dataset.kind = ''; }
async function showRanking() {
  const request = ++rankingRequest;
  showDialog('ranking', `<span class="eyebrow">${t.ranking}</span><h2>${t.rankingTitle}</h2><p>${t.rankingBody}</p><div id="ranking-list" class="ranking-list">${t.loading}</div>`);
  const result = await network.ranking();
  if (dialog.dataset.kind !== 'ranking' || request !== rankingRequest) return;
  const target = $('#ranking-list');
  target.innerHTML = result.rows.length ? `<table><thead><tr><th>${t.rank}</th><th>${t.player}</th><th>${t.points}</th></tr></thead><tbody>${result.rows.map((row, i) => `<tr class="${row.user_id === network.session?.user.id ? 'current-player' : ''}"><td>${String(i + 1).padStart(2, '0')}</td><td>${escape(row.nickname)}${row.user_id === network.session?.user.id ? ` <small>${t.you}</small>` : ''}</td><td>${format(row.best_score)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty-state">${svg('trophy')}<p>${result.available ? t.emptyRanking : t.noRanking}</p></div>`;
  if (result.cached && result.rows.length) target.insertAdjacentHTML('beforeend', `<p class="micro">${t.cachedRanking}</p>`);
}
async function showProfile() {
  const user = network.session?.user;
  if (!user) {
    showDialog('profile', `<span class="eyebrow">${t.profile}</span><h2>${t.profileTitle}</h2><p>${t.profileGuest}</p><button class="primary" data-action="google">${t.google}</button>`);
    return;
  }
  const userId = user.id;
  const name = typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : '';
  showDialog('profile', `<span class="eyebrow">${t.profile}</span><h2>${t.profileTitle}</h2><div class="profile-head"><div class="profile-avatar" aria-hidden="true">${escape((network.nickname || name || '?').slice(0, 1).toUpperCase())}</div><div><strong>${escape(network.nickname || name || t.profile)}</strong><small>${escape(name)}</small><small>${escape(user.email || '')}</small></div></div><div id="profile-content">${t.loading}</div>`);
  const result = await network.profile();
  if (dialog.dataset.kind !== 'profile' || network.session?.user.id !== userId) return;
  if (!result.available) { $('#profile-content').textContent = t.profileUnavailable; return; }
  const own = new Map(result.awards.filter(award => award.user_id === userId).map(award => [award.slug, award]));
  const holders = new Map(result.awards.filter(award => award.user_id !== userId).map(award => [award.slug, award]));
  const candidates = new Map(result.candidates.map(candidate => [candidate.slug, candidate.queue_position]));
  $('#profile-content').innerHTML = `<div class="profile-stats"><div><span>${t.serverBest}</span><strong>${format(result.bestScore)}</strong></div><div><span>${t.highestScreen}</span><strong>${format(result.levelReached)}</strong></div><div><span>${t.achievements}</span><strong>${own.size} / ${result.definitions.length}</strong></div></div>
    <h3 class="eyebrow">${t.achievements}</h3><div class="achievement-grid">${result.definitions.map(definition => {
      const award = own.get(definition.slug), holder = holders.get(definition.slug);
      const details = achievementCopy(definition.slug, numberLocale);
      const waiting = candidates.get(definition.slug);
      return `<article class="achievement-badge ${award ? 'earned' : 'locked'}"><div class="badge-art">${badgeSvg(definition.slug)}</div><div><strong>${escape(details.name)}</strong><p>${escape(details.description)}</p><small>${award ? `${t.unlocked} · ${new Date(award.awarded_at).toLocaleDateString(numberLocale)}` : definition.exclusive ? `${t.exclusive}${holder ? ` · ${escape(holder.nickname || t.locked)}` : ''}${waiting ? ` · ${t.candidate} #${waiting}` : ''}` : t.locked}</small></div></article>`;
    }).join('')}</div>${result.cached || network.pendingAchievements() ? `<p class="micro">${t.waitingVerification}</p>` : ''}`;
}
const keyLabel = (key: string) => key.replace('Key', '').replace('Digit', '').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→');
function showSettings() {
  showDialog('settings', `<span class="eyebrow">${t.settings}</span><h2>${t.settingsTitle}</h2><p>${t.settingsBody}</p>
    <section class="settings-section"><h3>${t.keyboard}</h3><p>${t.bindings}</p><div class="bindings">${DIRECTIONS.map(d => `<div><span>${t.directions[d]}</span>${settings.keys[d].map((k, index) => `<button class="key-button" data-action="rebind" data-direction="${d}" data-index="${index}" aria-label="${t.directions[d]}: ${keyLabel(k)}">${keyLabel(k)}</button>`).join('')}</div>`).join('')}</div><p id="binding-message" role="status"></p></section>
    <section class="settings-section"><h3>${t.audio}</h3><label class="setting-row">${t.volume}<input id="volume" type="range" min="0" max="1" step="0.01" value="${settings.volume}"/></label><label class="setting-row">${t.mute}<input id="muted" type="checkbox" ${settings.muted ? 'checked' : ''}/></label></section>
    <section class="settings-section"><h3>${t.gamepad}</h3><label class="setting-row">${t.gamepadEnabled}<input id="gamepad" type="checkbox" ${settings.gamepad ? 'checked' : ''}/></label><p>${t.gamepadHint}</p><span class="micro" id="gamepad-status">${t.gamepadMissing}</span></section>
    <section class="settings-section"><h3>${t.touch}</h3><p>${t.touchHint}</p></section><button class="secondary" data-action="defaults">${t.reset}</button>`);
}
function showNickname() {
  showDialog('nickname', `<span class="eyebrow">${t.title}</span><h2>${t.nicknameTitle}</h2><p>${t.nicknameBody}</p><form id="nickname-form"><label for="nickname">${t.nickname}</label><input id="nickname" name="nickname" autocomplete="nickname" minlength="3" maxlength="12" pattern="[A-Za-z0-9_]{3,12}" required/><p id="nickname-error" role="alert"></p><button class="primary" type="submit">${t.claim}${svg('arrow')}</button></form><button class="text-button" data-action="defer">${t.saveLater}</button>`);
}

app.addEventListener('click', async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'start-guest') start(false);
  else if (action === 'start-user') start(true);
  else if (action === 'again') start(!!owner && owner === network.session?.user.id);
  else if (action === 'pause') togglePause();
  else if (action === 'fullscreen') toggleFocusMode();
  else if (action === 'home') home();
  else if (action === 'leave') home(true);
  else if (action === 'stay') { closeDialog(); if (game.paused) togglePause(); }
  else if (action === 'ranking') void showRanking();
  else if (action === 'profile') void showProfile();
  else if (action === 'settings') showSettings();
  else if (action === 'nickname') { nicknameDeferred = false; showNickname(); }
  else if (action === 'close') { if (dialog.dataset.kind === 'nickname') nicknameDeferred = true; closeDialog(); }
  else if (action === 'mute') { settings.muted = !settings.muted; saveSettings(); }
  else if (action === 'defaults') { settings = defaults(); saveSettings(); showSettings(); }
  else if (action === 'defer') { nicknameDeferred = true; closeDialog(); start(false); }
  else if (action === 'google') {
    if (!network.available) { toast(t.authUnavailable); return; }
    if (network.isLocal) {
      await network.init();
      const accounts = network.listMockAccounts();
      showDialog('mock-google', `<span class="eyebrow">${t.google}</span><h2>${t.mockGoogleTitle}</h2><p>${t.mockGoogleBody}</p>
        <div class="start-buttons">${accounts.map(account =>
          `<button class="secondary" data-action="mock-user" data-user="${account.id}"><span class="google-mark">G</span>${escape(account.name)}</button>`
        ).join('')}</div>`);
      return;
    }
    button.disabled = true;
    try { nicknameDeferred = false; await network.signIn(); } catch { toast(t.networkError); } finally { button.disabled = false; }
  } else if (action === 'mock-user') {
    const accountId = button.dataset.user;
    if (!accountId) return;
    button.disabled = true;
    try { nicknameDeferred = false; await network.signIn(accountId); closeDialog(); }
    catch { toast(t.networkError); }
    finally { button.disabled = false; }
  } else if (action === 'signout') {
    try { await network.signOut(); } catch { toast(t.networkError); }
  } else if (action === 'rebind') {
    pendingCapture = { direction: button.dataset.direction as Direction, index: Number(button.dataset.index) };
    controls.capturing = true; $('#binding-message').textContent = t.listen;
  }
});
app.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'volume') settings.volume = Number(input.value);
  else if (input.id === 'muted') settings.muted = input.checked;
  else if (input.id === 'gamepad') settings.gamepad = input.checked;
  else return;
  saveSettings();
});
app.addEventListener('submit', async event => {
  if ((event.target as HTMLElement).id !== 'nickname-form') return;
  event.preventDefault(); const nickname = $<HTMLInputElement>('#nickname').value.trim();
  if (!/^[A-Za-z0-9_]{3,12}$/.test(nickname)) { $('#nickname-error').textContent = t.nicknameInvalid; return; }
  const button = $<HTMLButtonElement>('#nickname-form button'); button.disabled = true;
  try { await network.claim(nickname); closeDialog(); }
  catch (error) { const target = $('#nickname-error'); if (target) target.textContent = (error as { code?: string }).code === '23505' ? t.nicknameTaken : t.nicknameError; }
  finally { button.disabled = false; }
});
window.addEventListener('keydown', event => {
  if (!pendingCapture) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.code === 'Escape') { pendingCapture = null; controls.capturing = false; $('#binding-message').textContent = ''; return; }
  if (!/^(Key[A-Z]|Arrow(Up|Down|Left|Right)|Digit[0-9]|Space)$/.test(event.code) || event.code === 'KeyP') { $('#binding-message').textContent = t.reserved; return; }
  const { direction, index } = pendingCapture;
  if (Object.entries(settings.keys).some(([d, keys]) => keys.some((key, i) => key === event.code && (d !== direction || i !== index)))) { $('#binding-message').textContent = t.duplicate; return; }
  settings.keys[direction][index] = event.code; pendingCapture = null; controls.capturing = false; saveSettings(); showSettings();
}, { capture: true });
dialog.addEventListener('cancel', event => { event.preventDefault(); if (dialog.dataset.kind === 'nickname') nicknameDeferred = true; closeDialog(); });
document.addEventListener('pointerdown', () => void sound.unlock(), { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && screen === 'game' && !game.paused) togglePause();
  previous = 0; accumulator = 0;
});
window.addEventListener('blur', () => { if (screen === 'game' && !game.paused) togglePause(); });
window.addEventListener('online', () => { updateConnection(); void network.loginSync(); });
window.addEventListener('offline', updateConnection);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) document.body.classList.remove('game-focus');
  updateFocusButton();
});
const flushBeforeLeave = () => {
  if (owner) syncProgress(game.snapshot());
  void network.flushPending();
};
window.addEventListener('pagehide', flushBeforeLeave);
window.addEventListener('beforeunload', event => {
  flushBeforeLeave();
  if (network.hasPendingData() || network.updating) {
    event.preventDefault();
    event.returnValue = true;
  }
});

function frame(now: number) {
  const dt = previous ? Math.min((now - previous) / 1000, .1) : 0; previous = now;
  const connected = controls.poll();
  if (screen === 'game') {
    accumulator += dt;
    while (accumulator >= 1 / 60) { game.update(1 / 60); accumulator -= 1 / 60; }
  }
  renderer.draw(game, now / 1000, screen === 'home');
  sound.background(screen === 'game' && !game.paused && game.phase === 'playing', game.elapsed, game.frightened > 0);
  if (now - lastHud > 100) {
    lastHud = now; $('#score').textContent = String(game.score).padStart(6, '0'); $('#level').textContent = String(game.level).padStart(2, '0');
    $('#deaths').textContent = String(game.deaths); $('#cleared').textContent = String(game.cleared);
    updateRecordCard();
    $('#peak').textContent = format(game.peakScore); $('#penalty').textContent = `−${format(game.nextPenalty)}`;
    $('#speed').textContent = `${speedMultiplier(game.level).toFixed(2)}×`;
    $('#board-seed').textContent = `${t.seed} ${game.maze.seed.toString(16).toUpperCase().slice(-6)}`;
    $('#mode').textContent = screen === 'home' ? t.board : game.frightened > 0 ? t.phaseModes.frightened : game.scatter ? t.phaseModes.scatter : t.phaseModes.chase;
    if (dialog.dataset.kind === 'settings') $('#gamepad-status').textContent = connected ? t.gamepadConnected : t.gamepadMissing;
  }
  requestAnimationFrame(frame);
}
const localeSelect = $<HTMLSelectElement>('#locale');
localeSelect.value = loadLocale();
localeSelect.addEventListener('change', () => {
  const next = localeSelect.value;
  if (next !== 'auto' && next !== 'en' && next !== 'pt-BR') return;
  if (next === loadLocale()) return;
  saveLocale(next as LocalePreference);
  location.reload();
});
network.onSyncState = state => { syncing = state; updateConnection(); };
network.onSyncComplete = showSyncComplete;
homeIntro(); updateAccount(); updateConnection(); updateMute(); requestAnimationFrame(frame); void network.init();
if (import.meta.env.DEV && network.isLocal) {
  void import('./services/backend/resetLocal').then(({ resetLocalBackend }) => {
    (window as Window & { resetLocalBackend?: () => Promise<void> }).resetLocalBackend = async () => {
      await resetLocalBackend();
      location.reload();
    };
  });
}
network.onAchievements = slugs => {
  const ownerId = network.session?.user.id;
  const state = ownerId ? read<LocalAchievementState>(`achievement-local:${ownerId}`, { unlocked: [], noobRuns: [] }) : null;
  const alreadyShown = new Set(state?.unlocked ?? []);
  slugs.filter(slug => !alreadyShown.has(slug)).forEach((slug, index) => showAchievement(slug, index));
  if (ownerId) {
    const confirmed = new AchievementTracker(state ?? undefined);
    confirmed.confirm(slugs); write(`achievement-local:${ownerId}`, confirmed.snapshot());
    achievementTracker = confirmed;
  }
  if (dialog.dataset.kind === 'profile') void showProfile();
};
if (!storageAvailable) toast(t.storageWarning);
registerSW({ onOfflineReady: () => { $('#offline-ready').textContent = t.offlineReady; }, onNeedRefresh: () => toast(t.update), onRegisterError: () => { $('#offline-ready').textContent = t.offline; } });
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) $('#offline-ready').textContent = t.offlineReady;
