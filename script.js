'use strict';

/* 1. Dados, armazenamento e comunicação com o TMDB. */
const API_KEY = "db36709836da3a30746262b6fc1e7743";
const IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const PROFILES = {
  wesley: { name: 'Wesley Tiago', initial: 'W', blue: false },
  willcany: { name: 'Willcany', initial: 'V', blue: true }
};
const GENRES = new Map(Object.entries({
  28: 'Ação', 12: 'Aventura', 16: 'Animação', 35: 'Comédia', 80: 'Crime',
  99: 'Documentário', 18: 'Drama', 10751: 'Família', 14: 'Fantasia',
  36: 'História', 27: 'Terror', 10402: 'Música', 9648: 'Mistério',
  10749: 'Romance', 878: 'Ficção científica', 53: 'Suspense', 10752: 'Guerra',
  37: 'Faroeste', 10759: 'Ação e aventura', 10765: 'Ficção e fantasia',
  10764: 'Reality', 10762: 'Infantil', 10768: 'Guerra e política'
}).map(([id, name]) => [Number(id), name]));

function readStorage(key, fallback, session = false) {
  try {
    const storage = session ? sessionStorage : localStorage;
    const value = storage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch { return fallback; }
}
function writeStorage(key, value, session = false) {
  try {
    (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}
function validPath(path) {
  return typeof path === 'string' && /^\/[a-zA-Z0-9._-]+$/.test(path) ? path : null;
}
function imageUrl(path, size = 'w780') {
  return validPath(path) ? IMAGE_BASE + size + path : '';
}
function normalizeItem(raw, fallbackType = 'movie') {
  if (!raw || !Number.isInteger(raw.id) || raw.id <= 0 || raw.adult ||
      raw.media_type === 'person') return null;
  const type = raw.media_type || raw.type || fallbackType;
  if (!['movie', 'tv'].includes(type)) return null;
  const title = String(raw.title || raw.name || '').trim();
  if (!title) return null;
  return {
    id: raw.id, type, key: type + ':' + raw.id, title,
    overview: typeof raw.overview === 'string' ? raw.overview : '',
    backdrop_path: validPath(raw.backdrop_path), poster_path: validPath(raw.poster_path),
    date: String(raw.release_date || raw.first_air_date || raw.date || ''),
    vote_average: Number.isFinite(raw.vote_average) ? raw.vote_average : 0,
    genre_ids: Array.isArray(raw.genre_ids) ? raw.genre_ids.filter(Number.isInteger) : []
  };
}
function uniqueItems(rawItems, type = 'movie') {
  const seen = new Set();
  return (Array.isArray(rawItems) ? rawItems : []).map(item => normalizeItem(item, type))
    .filter(item => item && !seen.has(item.key) && seen.add(item.key));
}
function parseSavedItems(value) {
  return uniqueItems(Array.isArray(value) ? value.slice(0, 200) : []);
}
function selectTrailer(videos) {
  return (Array.isArray(videos) ? videos : [])
    .filter(v => v.site === 'YouTube' && v.type === 'Trailer' &&
      typeof v.key === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(v.key))
    .sort((a, b) => Number(Boolean(b.official)) - Number(Boolean(a.official)))[0]?.key || null;
}
function certification(details, type) {
  const value = type === 'tv'
    ? details?.content_ratings?.results?.find(r => r.iso_3166_1 === 'BR')?.rating
    : details?.release_dates?.results?.find(r => r.iso_3166_1 === 'BR')
      ?.release_dates?.find(r => r.certification)?.certification;
  return value === 'L' ? 'L' : /^(10|12|14|16|18)$/.test(String(value)) ? value + '+' : '';
}
function ratingText(item) {
  return item.vote_average > 0 ? item.vote_average.toFixed(1).replace('.', ',') + ' no TMDB' : '';
}
function genreText(item) {
  return item.genre_ids.map(id => GENRES.get(id)).filter(Boolean).slice(0, 3).join(' • ');
}
function runtimeText(details, type) {
  if (type === 'tv') {
    const n = details.number_of_seasons;
    return n ? n + (n === 1 ? ' temporada' : ' temporadas') : '';
  }
  const minutes = details.runtime;
  if (!minutes) return '';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'min';
}

/* O cliente trata timeout, cancelamento, erros HTTP e cache limitado. */
function createApiClient(getKey, fetcher = (...args) => fetch(...args)) {
  const cache = new Map();
  async function request(path, params = {}, options = {}) {
    if (options.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    const url = new URL('https://api.themoviedb.org/3/' + path.replace(/^\//, ''));
    url.search = new URLSearchParams({
      api_key: getKey(), language: 'pt-BR', include_adult: 'false', ...params
    }).toString();
    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (options.cache !== false && cached && Date.now() - cached.time < 600000) return cached.data;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    try {
      const response = await fetcher(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        const error = new Error('Não foi possível consultar o catálogo.');
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (options.cache !== false) {
        cache.set(cacheKey, { time: Date.now(), data });
        if (cache.size > 100) cache.delete(cache.keys().next().value);
      }
      return data;
    } catch (error) {
      if (timedOut) {
        const timeout = new Error('O catálogo demorou para responder. Tente novamente.');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  return { request, clear: () => cache.clear() };
}

/* Cada nova busca invalida a anterior, inclusive durante o debounce. */
function createRequestGate() {
  let version = 0, controller;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      return { version: ++version, signal: controller.signal };
    },
    isCurrent(ticket) { return ticket.version === version && !ticket.signal.aborted; },
    cancel() { version++; controller?.abort(); }
  };
}
const storedProfile = readStorage('stream-study:profile', 'wesley');
const state = {
  profile: PROFILES[storedProfile] ? storedProfile : 'wesley',
  view: 'home', lists: [], likes: new Set(), recent: [],
  registry: new Map(), catalogVersion: 0, catalogController: null,
  hero: null, heroVersion: 0, heroPlayer: null, heroVisible: true, muted: true,
  modalItem: null, modalDetails: null, modalVersion: 0, modalController: null,
  modalPlayer: null, modalTrigger: null, modalPlayVersion: 0,
  previewItem: null, previewTimer: null, hidePreviewTimer: null,
  searchGate: createRequestGate(), searchTimer: null, searching: false,
  rails: new Map(), resizeObserver: null, youtubePromise: null,
  autoPreviews: readStorage('stream-study:previews', true) === true
};
let apiKey = readStorage('stream-study:tmdb', API_KEY, true);
if (typeof apiKey !== 'string' || !apiKey.trim()) apiKey = API_KEY;
const api = createApiClient(() => apiKey);
const $ = id => document.getElementById(id);
const motion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name, filled = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon' + (filled ? ' fill' : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
function actionButton(label, symbol, callback, className = 'round-btn') {
  const button = element('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.append(icon(symbol, symbol === 'play'));
  button.addEventListener('click', callback);
  return button;
}
function makeImage(item, className, portrait = false, eager = false) {
  const img = element('img', className);
  img.alt = '';
  img.loading = eager ? 'eager' : 'lazy';
  img.decoding = 'async';
  const path = portrait ? (item.poster_path || item.backdrop_path) : (item.backdrop_path || item.poster_path);
  img.src = imageUrl(path, portrait ? 'w342' : 'w500');
  img.addEventListener('error', () => {
    const fallback = element('div', 'card-placeholder', item.title);
    img.replaceWith(fallback);
  }, { once: true });
  if (!path) return element('div', 'card-placeholder', item.title);
  return img;
}
let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3000);
}
function remember(items) {
  items.forEach(item => state.registry.set(item.key, item));
  return items;
}
function loadProfile() {
  state.lists = parseSavedItems(readStorage('stream-study:list:' + state.profile, []));
  const likes = readStorage('stream-study:likes:' + state.profile, []);
  state.likes = new Set(Array.isArray(likes) ? likes.filter(k => /^(movie|tv):\d+$/.test(k)).slice(0, 200) : []);
  state.recent = parseSavedItems(readStorage('stream-study:recent:' + state.profile, []));
  remember(state.lists);
  remember(state.recent);
  const profile = PROFILES[state.profile];
  $('currentAvatar').textContent = profile.initial;
  $('currentAvatar').classList.toggle('blue', profile.blue);
  document.querySelector('.profile-trigger').setAttribute('aria-label', 'Perfil de ' + profile.name);
  document.querySelectorAll('[data-profile]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.profile === state.profile)));
}
function isSaved(item) { return state.lists.some(saved => saved.key === item.key); }
function syncActions() {
  document.querySelectorAll('.card[data-key]').forEach(card =>
    card.classList.toggle('saved', state.lists.some(i => i.key === card.dataset.key)));
  document.querySelectorAll('.list-action').forEach(button => {
    const item = state.registry.get(button.dataset.key);
    if (!item) return;
    const saved = isSaved(item);
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', saved ? 'Remover da minha lista' : 'Adicionar à minha lista');
    button.replaceChildren(icon(saved ? 'check' : 'plus'));
  });
  document.querySelectorAll('.like-action').forEach(button =>
    button.setAttribute('aria-pressed', String(state.likes.has(button.dataset.key))));
}
function toggleList(item) {
  const remove = isSaved(item);
  state.lists = remove ? state.lists.filter(i => i.key !== item.key) : [item, ...state.lists].slice(0, 200);
  const saved = writeStorage('stream-study:list:' + state.profile, state.lists);
  syncActions();
  if (state.view === 'list' && !state.searching) renderList();
  showToast((remove ? 'Removido da sua lista.' : 'Adicionado à sua lista.') +
    (saved ? '' : ' Disponível apenas nesta sessão.'));
}
function toggleLike(item) {
  if (state.likes.has(item.key)) state.likes.delete(item.key);
  else state.likes.add(item.key);
  const saved = writeStorage('stream-study:likes:' + state.profile, [...state.likes]);
  syncActions();
  showToast(saved ? 'Sua preferência foi atualizada.' : 'Preferência atualizada nesta sessão.');
}
function recordRecent(item) {
  state.recent = [item, ...state.recent.filter(i => i.key !== item.key)].slice(0, 12);
  writeStorage('stream-study:recent:' + state.profile, state.recent);
}

/* 2. Catálogo e fileiras. */
function createCard(item, options = {}) {
  const card = element('article', 'card' + (options.rank ? ' rank-card' : ''));
  card.dataset.key = item.key;
  if (options.rank) card.append(element('span', 'rank-number', String(options.rank)));
  const button = element('button', 'card-open');
  button.type = 'button';
  button.setAttribute('aria-label', 'Mais informações sobre ' + item.title);
  button.append(makeImage(item, '', Boolean(options.rank)));
  button.append(element('span', 'card-title-strip', item.title));
  button.addEventListener('click', () => openDetails(item, button));
  card.append(button);
  if (!options.noPreview) {
    card.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse' || !window.matchMedia('(hover: hover)').matches) return;
      clearTimeout(state.hidePreviewTimer);
      clearTimeout(state.previewTimer);
      state.previewTimer = setTimeout(() => showPreview(item, card), 250);
    });
    card.addEventListener('pointerleave', scheduleHidePreview);
  }
  card.classList.toggle('saved', isSaved(item));
  return card;
}
function clearRails() {
  state.resizeObserver?.disconnect();
  state.rails.clear();
}
function buildRow(label, items, options = {}) {
  if (!items.length) return;
  const row = element('section', 'row');
  const header = element('div', 'row-header');
  header.append(element('h2', 'row-title', label));
  const counter = element('div', 'row-counter');
  counter.setAttribute('aria-hidden', 'true');
  header.append(counter);
  row.append(header);
  const wrap = element('div', 'slider-wrap');
  const rail = element('div', 'slider');
  rail.tabIndex = 0;
  rail.setAttribute('role', 'group');
  rail.setAttribute('aria-label', label + ' — use as setas ou deslize');
  items.forEach((item, i) => rail.append(createCard(item, { rank: options.ranked ? i + 1 : 0 })));
  const scroll = delta => {
    hidePreview();
    const max = rail.scrollWidth - rail.clientWidth;
    const width = rail.clientWidth * .92;
    const next = delta > 0 && rail.scrollLeft >= max - 2 ? 0 :
      delta < 0 && rail.scrollLeft <= 2 ? max : rail.scrollLeft + delta * width;
    rail.scrollTo({ left: Math.max(0, Math.min(max, next)), behavior: motion() });
  };
  const left = actionButton('Títulos anteriores em ' + label, 'left', () => scroll(-1), 'arrow-btn arrow-left');
  const right = actionButton('Próximos títulos em ' + label, 'right', () => scroll(1), 'arrow-btn arrow-right');
  wrap.append(rail, left, right);
  row.append(wrap);
  $('rows').append(row);
  let scheduled = false;
  const update = () => {
    if (!rail.clientWidth) return;
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
    left.disabled = right.disabled = max < 2;
    const pages = Math.max(1, Math.ceil(max / (rail.clientWidth * .92)) + 1);
    const current = Math.min(pages - 1, Math.round(rail.scrollLeft / (rail.clientWidth * .92)));
    counter.replaceChildren(...Array.from({ length: pages }, (_, i) =>
      element('span', i === current ? 'active' : '')));
    scheduled = false;
  };
  rail.addEventListener('scroll', () => {
    hidePreview();
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  }, { passive: true });
  rail.addEventListener('keydown', event => {
    if (event.target !== rail || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    scroll(event.key === 'ArrowRight' ? 1 : -1);
  });
  state.rails.set(rail, update);
  state.resizeObserver?.observe(rail);
  requestAnimationFrame(update);
}
function skeletonRows() {
  clearRails();
  $('rows').replaceChildren();
  ['Em alta nesta semana', 'Filmes e séries para descobrir', 'Aclamados pela crítica'].forEach(label => {
    const row = element('section', 'row');
    const header = element('div', 'row-header');
    header.append(element('h2', 'row-title', label));
    const rail = element('div', 'slider');
    rail.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 6; i++) rail.append(element('div', 'skeleton'));
    row.append(header, rail);
    $('rows').append(row);
  });
}
function catalogDefinitions(view) {
  const genre = (title, type, id) => ({
    title, type, path: '/discover/' + type, params: { with_genres: id, sort_by: 'popularity.desc' }
  });
  if (view === 'tv') return [
    { title: 'Séries em alta', type: 'tv', path: '/trending/tv/week' },
    { title: 'Séries populares', type: 'tv', path: '/tv/popular' },
    { title: 'Séries aclamadas', type: 'tv', path: '/tv/top_rated' },
    genre('Drama em série', 'tv', 18), genre('Comédias para maratonar', 'tv', 35),
    genre('Ficção e fantasia', 'tv', 10765)
  ];
  if (view === 'movie') return [
    { title: 'Filmes em alta', type: 'movie', path: '/trending/movie/week' },
    { title: 'Filmes populares', type: 'movie', path: '/movie/popular' },
    { title: 'Aclamados pela crítica', type: 'movie', path: '/movie/top_rated' },
    genre('Ação e aventura', 'movie', 28), genre('Suspense e terror', 'movie', 27),
    genre('Para dar boas risadas', 'movie', 35)
  ];
  if (view === 'trending') return [
    { title: 'Filmes em alta nesta semana', type: 'movie', path: '/trending/movie/week' },
    { title: 'Séries em alta nesta semana', type: 'tv', path: '/trending/tv/week' },
    { title: 'Em cartaz', type: 'movie', path: '/movie/now_playing', params: { region: 'BR' } }
  ];
  return [
    { title: 'Em alta nesta semana', type: 'movie', path: '/trending/all/week' },
    { title: 'Filmes populares', type: 'movie', path: '/movie/popular' },
    { title: 'Séries que todo mundo está vendo', type: 'tv', path: '/tv/popular' },
    { title: 'Aclamados pela crítica', type: 'movie', path: '/movie/top_rated' },
    genre('Ação e aventura', 'movie', 28), genre('Para dar boas risadas', 'movie', 35),
    genre('Animação para descobrir', 'movie', 16)
  ];
}
function applyViewVisibility() {
  const showHero = ['home', 'movie', 'tv'].includes(state.view) && !state.searching;
  $('billboard').hidden = !showHero;
  $('rows').hidden = state.searching;
  $('rows').classList.toggle('flat', !showHero);
  $('catalogPage').hidden = showHero || state.searching;
  const headings = {
    tv: ['Séries', 'Novas histórias, episódio por episódio.'],
    movie: ['Filmes', 'Escolha sua próxima história.'],
    trending: ['Bombando', 'Os títulos em alta no TMDB nesta semana.'],
    list: ['Minha lista', 'Os títulos que você salvou no perfil de ' + PROFILES[state.profile].name + '.']
  };
  const [title, subtitle] = headings[state.view] || ['Catálogo', 'Explore filmes e séries.'];
  $('catalogTitle').textContent = title;
  $('catalogSubtitle').textContent = subtitle;
  document.querySelectorAll('.desktop-nav [data-view]').forEach(link => {
    if (link.dataset.view === state.view && !state.searching) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('mobileNav').value = state.view;
  $('navbar').classList.toggle('solid', window.scrollY > 30 || !showHero);
  if (!showHero) pauseHero();
}
function renderList() {
  clearRails();
  $('rows').replaceChildren();
  if (!state.lists.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('h2', '', 'Sua lista começa com uma boa história.'));
    empty.append(element('p', '', 'Abra os detalhes de um título e use o botão + para salvá-lo aqui.'));
    const button = element('button', '', 'Explorar catálogo');
    button.type = 'button';
    button.addEventListener('click', () => navigate('home'));
    empty.append(button);
    $('rows').append(empty);
  } else buildRow('Salvos por ' + PROFILES[state.profile].name, state.lists);
  $('rows').setAttribute('aria-busy', 'false');
}
async function loadCatalog(view = state.view) {
  const version = ++state.catalogVersion;
  state.catalogController?.abort();
  state.catalogController = new AbortController();
  state.view = view;
  hidePreview();
  $('catalogStatus').hidden = true;
  applyViewVisibility();
  if (view === 'list') { renderList(); return; }
  $('rows').setAttribute('aria-busy', 'true');
  skeletonRows();
  const definitions = catalogDefinitions(view);
  const results = await Promise.allSettled(definitions.map(def =>
    api.request(def.path, def.params, { signal: state.catalogController.signal })));
  if (version !== state.catalogVersion) return;
  clearRails();
  $('rows').replaceChildren();
  let failures = 0, firstItems = [], authError = false;
  results.forEach((result, i) => {
    const def = definitions[i];
    if (result.status !== 'fulfilled') {
      failures++;
      if ([401, 403].includes(result.reason?.status)) authError = true;
      return;
    }
    const items = remember(uniqueItems(result.value.results, def.type));
    if (!firstItems.length) firstItems = items;
    buildRow(def.title, items);
    if (view === 'home' && i === 0 && state.recent.length)
      buildRow('Explorados recentemente por ' + PROFILES[state.profile].name, state.recent);
    if (i === 1 && view !== 'trending')
      buildRow('Top 10 ' + (view === 'tv' ? 'séries' : 'filmes') + ' populares no TMDB', items.slice(0, 10), { ranked: true });
  });
  $('rows').setAttribute('aria-busy', 'false');
  if (firstItems.length && ['home', 'tv', 'movie'].includes(view)) {
    const hero = firstItems.find(i => i.backdrop_path && i.overview && i.type === 'tv') ||
      firstItems.find(i => i.backdrop_path && i.overview) || firstItems[0];
    renderHero(hero);
  } else if (!firstItems.length) {
    $('billboard').hidden = true;
    $('rows').classList.add('flat');
    $('catalogPage').hidden = false;
    showCatalogError(authError ? 'A chave do TMDB não foi aceita. Configure o catálogo para continuar.' :
      'Não foi possível carregar o catálogo. Verifique sua conexão e tente novamente.', true, authError);
  }
  if (failures && firstItems.length)
    showCatalogError('Algumas fileiras não puderam ser carregadas. As demais continuam disponíveis.', true);
}
function showCatalogError(message, retry = false, settings = false) {
  const box = $('catalogStatus');
  box.replaceChildren(element('span', '', message));
  if (retry || settings) {
    const button = element('button', '', settings ? 'Configurar catálogo' : 'Tentar novamente');
    button.type = 'button';
    button.addEventListener('click', () => {
      if (settings) $('apiDialog').showModal();
      else { api.clear(); loadCatalog(); }
    });
    box.append(button);
  }
  box.hidden = false;
}
function navigate(view) {
  if (!['home', 'tv', 'movie', 'trending', 'list'].includes(view)) return;
  clearSearch(true);
  closeDropdowns();
  const hashes = { home: 'inicio', tv: 'series', movie: 'filmes', trending: 'bombando', list: 'minha-lista' };
  history.replaceState(null, '', '#' + hashes[view]);
  loadCatalog(view);
  window.scrollTo({ top: 0, behavior: motion() });
}

/* 3. Destaque: imagem imediata, logo opcional e vídeo com fallback real. */
async function titleDetails(item, signal) {
  return api.request('/' + item.type + '/' + item.id, {
    append_to_response: 'credits,videos,images,recommendations,' +
      (item.type === 'tv' ? 'content_ratings' : 'release_dates'),
    include_image_language: 'pt,en,null'
  }, { signal });
}
async function trailerKey(item, details) {
  const local = selectTrailer(details?.videos?.results);
  if (local) return local;
  try {
    const data = await api.request('/' + item.type + '/' + item.id + '/videos', { language: 'en-US' });
    return selectTrailer(data.results);
  } catch { return null; }
}
function renderHero(item) {
  state.hero = item;
  const version = ++state.heroVersion;
  destroyHero();
  $('billboard').classList.remove('loading', 'has-logo');
  $('billLogo').hidden = true;
  $('billAge').hidden = true;
  $('billTitle').textContent = item.title;
  $('billDesc').textContent = item.overview || 'Descubra os detalhes deste título e encontre novas histórias.';
  $('billLabel').textContent = (item.type === 'tv' ? 'SÉRIE' : 'FILME') + ' EM DESTAQUE';
  $('billHighlight').textContent = [ratingText(item), item.date.slice(0, 4), genreText(item)].filter(Boolean).join(' · ');
  const poster = $('billPoster');
  poster.hidden = !item.backdrop_path && !item.poster_path;
  poster.src = imageUrl(item.backdrop_path || item.poster_path, 'w1280');
  $('billPlayBtn').disabled = $('billInfoBtn').disabled = false;
  hydrateHero(item, version);
}
async function hydrateHero(item, version) {
  let details;
  try { details = await titleDetails(item); } catch { return; }
  if (version !== state.heroVersion) return;
  const age = certification(details, item.type);
  $('billAge').textContent = age;
  $('billAge').hidden = !age;
  const logos = details.images?.logos || [];
  const logo = logos.find(l => l.iso_639_1 === 'pt') || logos.find(l => l.iso_639_1 === 'en');
  if (logo && validPath(logo.file_path)) {
    const image = $('billLogo');
    image.onload = () => {
      if (version === state.heroVersion) { image.hidden = false; $('billboard').classList.add('has-logo'); }
    };
    image.onerror = () => { image.hidden = true; $('billboard').classList.remove('has-logo'); };
    image.src = imageUrl(logo.file_path, 'original');
  }
  if (canAutoPreview() && state.heroVisible && !state.searching) startHeroPreview(item, details, version);
}
function canAutoPreview() {
  return state.autoPreviews && window.matchMedia('(hover: hover)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !navigator.connection?.saveData;
}
function youtubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (state.youtubePromise) return state.youtubePromise;
  state.youtubePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('O player não respondeu.')), 12000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    const script = element('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Player indisponível.')); };
    document.head.append(script);
  }).catch(error => { state.youtubePromise = null; throw error; });
  return state.youtubePromise;
}
function destroyHero() {
  state.heroPlayer?.destroy();
  state.heroPlayer = null;
  $('billVideo').replaceChildren();
  $('billVideo').classList.remove('playing');
  $('muteBtn').hidden = true;
}
function pauseHero() {
  try { state.heroPlayer?.pauseVideo(); } catch { /* player ainda inicializando */ }
  $('billVideo').classList.remove('playing');
}
async function startHeroPreview(item, details, version) {
  if (state.heroPlayer) return;
  const key = await trailerKey(item, details);
  if (!key || version !== state.heroVersion || !canAutoPreview()) return;
  let YT;
  try { YT = await youtubeAPI(); } catch { return; }
  if (version !== state.heroVersion || !canAutoPreview() || !state.heroVisible ||
      state.searching || $('titleDialog').open || $('billboard').hidden) return;
  const mount = element('div');
  $('billVideo').append(mount);
  let player;
  const fallback = () => {
    clearTimeout(safety);
    if (state.heroPlayer === player) destroyHero();
  };
  const safety = setTimeout(fallback, 10000);
  state.muted = true;
  player = new YT.Player(mount, {
    videoId: key,
    playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: event => {
        event.target.getIframe().setAttribute('title', 'Prévia de ' + item.title);
        event.target.getIframe().tabIndex = -1;
        event.target.mute();
        if (state.heroVisible && !state.searching && !$('titleDialog').open) event.target.playVideo();
      },
      onStateChange: event => {
        if (state.heroPlayer !== player) return;
        if (event.data === 1) {
          clearTimeout(safety);
          if (!state.heroVisible || state.searching || $('titleDialog').open) { pauseHero(); return; }
          $('billVideo').classList.add('playing');
          $('muteBtn').hidden = false;
          $('muteBtn').replaceChildren(icon(state.muted ? 'mute' : 'volume'));
        } else if (event.data === 0) fallback();
        else $('billVideo').classList.remove('playing');
      },
      onError: fallback, onAutoplayBlocked: fallback
    }
  });
  state.heroPlayer = player;
}

/* 4. Prévia flutuante e janela de detalhes. */
function scheduleHidePreview() {
  clearTimeout(state.previewTimer);
  state.hidePreviewTimer = setTimeout(hidePreview, 160);
}
function hidePreview() {
  clearTimeout(state.previewTimer);
  clearTimeout(state.hidePreviewTimer);
  $('cardPreview').hidden = true;
  state.previewItem = null;
}
function showPreview(item, card) {
  if (!card.isConnected || $('titleDialog').open) return;
  const preview = $('cardPreview');
  state.previewItem = item;
  preview.replaceChildren(makeImage(item, 'preview-image', false, true));
  const body = element('div', 'preview-body');
  const actions = element('div', 'preview-actions');
  actions.append(actionButton('Assistir trailer de ' + item.title, 'play',
    () => openDetails(item, card.querySelector('button'), true), 'round-btn preview-play'));
  const list = actionButton('Adicionar à minha lista', 'plus', () => toggleList(item));
  list.classList.add('list-action'); list.dataset.key = item.key;
  const like = actionButton('Gostei deste título', 'like', () => toggleLike(item));
  like.classList.add('like-action'); like.dataset.key = item.key;
  actions.append(list, like, actionButton('Mais informações sobre ' + item.title, 'down',
    () => openDetails(item, card.querySelector('button'))));
  body.append(actions, element('h3', 'preview-title', item.title));
  const meta = element('div', 'preview-meta');
  if (ratingText(item)) meta.append(element('span', 'rating', ratingText(item)));
  meta.append(element('span', '', item.date.slice(0, 4)), element('span', 'metadata-tag', item.type === 'tv' ? 'Série' : 'Filme'));
  body.append(meta);
  if (genreText(item)) body.append(element('p', 'preview-genres', genreText(item)));
  preview.append(body);
  const rect = card.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 32);
  preview.style.width = width + 'px';
  preview.hidden = false;
  const x = Math.max(16, Math.min(window.innerWidth - width - 16, rect.left + rect.width / 2 - width / 2));
  const y = Math.max(78, Math.min(window.innerHeight - preview.offsetHeight - 16, rect.top - 35));
  preview.style.left = x + 'px';
  preview.style.top = y + 'px';
  syncActions();
}
function destroyModalPlayer() {
  state.modalPlayVersion++;
  state.modalPlayer?.destroy();
  state.modalPlayer = null;
  $('modalVideo').replaceChildren();
  $('modalVideo').hidden = true;
}
function renderModalInfo(item, details = {}) {
  $('modalTitle').textContent = item.title;
  const poster = $('modalPoster');
  poster.hidden = !item.backdrop_path && !item.poster_path;
  poster.src = imageUrl(item.backdrop_path || item.poster_path, 'w1280');
  $('modalDescription').textContent = details.overview || item.overview || 'Sinopse não disponível para este título.';
  const meta = $('modalMeta');
  meta.replaceChildren();
  if (ratingText(item)) meta.append(element('span', 'rating', ratingText(item)));
  [item.date.slice(0, 4), certification(details, item.type), runtimeText(details, item.type),
    item.type === 'tv' ? 'Série' : 'Filme'].filter(Boolean).forEach(text => meta.append(element('span', '', text)));
  const facts = $('modalFacts');
  facts.replaceChildren();
  const values = [
    ['Elenco: ', details.credits?.cast?.slice(0, 4).map(p => p.name).join(', ')],
    ['Gêneros: ', details.genres?.map(g => g.name).slice(0, 4).join(', ') || genreText(item)],
    ['Título original: ', details.original_title || details.original_name]
  ];
  values.forEach(([label, value]) => {
    if (!value) return;
    const div = element('div');
    div.append(element('dt', '', label), element('dd', '', value));
    facts.append(div);
  });
  ['modalList', 'modalLike'].forEach(id => {
    $(id).dataset.key = item.key;
    $(id).classList.add(id === 'modalList' ? 'list-action' : 'like-action');
  });
  syncActions();
  const related = remember(uniqueItems(details.recommendations?.results, item.type)).slice(0, 6);
  $('relatedGrid').replaceChildren(...related.map(i => createCard(i, { noPreview: true })));
  $('relatedGrid').previousElementSibling.hidden = !related.length;
}
async function openDetails(item, trigger, play = false) {
  const dialog = $('titleDialog');
  if (!dialog.open) state.modalTrigger = trigger;
  hidePreview();
  closeDropdowns();
  pauseHero();
  state.modalController?.abort();
  state.modalController = new AbortController();
  const version = ++state.modalVersion;
  state.modalItem = item;
  state.modalDetails = null;
  destroyModalPlayer();
  $('modalPlay').disabled = false;
  $('trailerStatus').hidden = true;
  $('youtubeLink').hidden = true;
  $('youtubeLink').removeAttribute('href');
  renderModalInfo(item);
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  document.body.classList.add('dialog-open');
  recordRecent(item);
  try {
    const details = await titleDetails(item, state.modalController.signal);
    if (version !== state.modalVersion || !dialog.open) return;
    state.modalDetails = details;
    renderModalInfo(item, details);
  } catch (error) {
    if (error.name === 'AbortError' || version !== state.modalVersion) return;
    showToast('Alguns detalhes não estão disponíveis agora.');
  }
  if (play && version === state.modalVersion && dialog.open) startModalTrailer();
}
async function startModalTrailer() {
  const item = state.modalItem;
  if (!item) return;
  const version = ++state.modalPlayVersion;
  const isCurrent = () => version === state.modalPlayVersion && $('titleDialog').open;
  const status = $('trailerStatus');
  status.hidden = false;
  status.textContent = 'Buscando trailer…';
  $('modalPlay').disabled = true;
  let key = await trailerKey(item, state.modalDetails);
  if (!isCurrent()) return;
  if (!key) {
    status.textContent = 'Nenhum trailer foi encontrado para este título.';
    $('modalPlay').disabled = false;
    return;
  }
  const link = $('youtubeLink');
  link.href = 'https://www.youtube.com/watch?v=' + key;
  link.hidden = false;
  let YT;
  try { YT = await youtubeAPI(); } catch {
    if (isCurrent()) { status.textContent = 'O player está indisponível. Você pode abrir o trailer no YouTube.'; $('modalPlay').disabled = false; }
    return;
  }
  if (!isCurrent()) return;
  state.modalPlayer?.destroy();
  const mount = element('div');
  $('modalVideo').replaceChildren(mount);
  let player, safety;
  const fallback = () => {
    clearTimeout(safety);
    if (!isCurrent()) return;
    player?.destroy();
    state.modalPlayer = null;
    $('modalVideo').replaceChildren();
    $('modalVideo').hidden = true;
    status.hidden = false;
    status.textContent = 'Este trailer não pôde ser reproduzido aqui. Abra no YouTube ou escolha outro título.';
    $('modalPlay').disabled = false;
  };
  safety = setTimeout(fallback, 12000);
  player = new YT.Player(mount, {
    videoId: key, playerVars: { autoplay: 1, controls: 1, playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: event => {
        if (!isCurrent()) { event.target.destroy(); return; }
        event.target.getIframe().setAttribute('title', 'Trailer de ' + item.title);
        $('modalVideo').hidden = false;
        status.textContent = 'Use os controles do player. Se necessário, abra o trailer no YouTube.';
        event.target.playVideo();
      },
      onStateChange: event => {
        if (!isCurrent()) return;
        if (event.data === 1) { clearTimeout(safety); status.hidden = true; }
        else if (event.data === 0) { clearTimeout(safety); $('modalPlay').disabled = false; }
      },
      onError: fallback,
      onAutoplayBlocked: () => {
        if (isCurrent()) { clearTimeout(safety); status.textContent = 'Pressione reproduzir no player para iniciar o trailer.'; }
      }
    }
  });
  state.modalPlayer = player;
}
function closeTitle() {
  state.modalVersion++;
  state.modalController?.abort();
  destroyModalPlayer();
  document.body.classList.remove('dialog-open');
  const trigger = state.modalTrigger;
  state.modalItem = null;
  if (trigger?.isConnected) trigger.focus();
  if (canAutoPreview() && state.heroVisible && !state.searching && !$('billboard').hidden) {
    try { state.heroPlayer?.playVideo(); } catch { /* fallback mantém a imagem */ }
  }
}

/* 5. Busca com debounce, cancelamento e recuperação de erro. */
function setSearchOpen(open) {
  $('searchBox').classList.toggle('open', open);
  $('navbar').classList.toggle('searching', open);
  $('searchInput').hidden = !open;
  $('searchClear').hidden = !open;
  $('searchToggle').setAttribute('aria-expanded', String(open));
  $('searchToggle').setAttribute('aria-label', open ? 'Fechar busca' : 'Abrir busca');
  if (open) $('searchInput').focus();
  else clearSearch(true);
}
function clearSearch(close = false) {
  clearTimeout(state.searchTimer);
  state.searchGate.cancel();
  state.searching = false;
  $('searchInput').value = '';
  $('searchResults').hidden = true;
  $('searchGrid').replaceChildren();
  if (close) {
    $('searchBox').classList.remove('open'); $('navbar').classList.remove('searching');
    $('searchInput').hidden = $('searchClear').hidden = true;
    $('searchToggle').setAttribute('aria-expanded', 'false');
    $('searchToggle').setAttribute('aria-label', 'Abrir busca');
  }
  applyViewVisibility();
}
function queueSearch(immediate = false) {
  clearTimeout(state.searchTimer);
  const query = $('searchInput').value.trim();
  if (!query) { clearSearch(); return; }
  const ticket = state.searchGate.begin();
  state.searching = true;
  hidePreview(); closeDropdowns(); pauseHero();
  applyViewVisibility();
  $('catalogStatus').hidden = true;
  $('searchResults').hidden = false;
  $('searchGrid').replaceChildren();
  $('searchTitle').textContent = 'Resultados para “' + query + '”';
  if (query.length < 2) { $('searchStatus').textContent = 'Digite pelo menos dois caracteres.'; return; }
  $('searchStatus').textContent = 'Buscando filmes e séries…';
  const run = async () => {
    try {
      const data = await api.request('/search/multi', { query }, { signal: ticket.signal, cache: false });
      if (!state.searchGate.isCurrent(ticket)) return;
      const items = remember(uniqueItems(data.results)).slice(0, 30);
      $('searchGrid').replaceChildren(...items.map(item => createCard(item)));
      $('searchStatus').textContent = items.length ? items.length + ' títulos encontrados.' :
        'Nenhum título encontrado. Tente outro nome.';
    } catch (error) {
      if (!state.searchGate.isCurrent(ticket) || error.name === 'AbortError') return;
      $('searchStatus').textContent = 'A busca não respondeu. Tente novamente.';
    }
  };
  if (immediate) run();
  else state.searchTimer = setTimeout(run, 300);
}

/* 6. Navegação, perfis, configurações e inicialização. */
function closeDropdowns(except) {
  document.querySelectorAll('[data-dropdown]').forEach(button => {
    const id = button.dataset.dropdown;
    if (id !== except) { $(id).hidden = true; button.setAttribute('aria-expanded', 'false'); }
  });
}
async function loadNotifications() {
  try {
    const data = await api.request('/movie/now_playing', { region: 'BR' });
    const items = remember(uniqueItems(data.results)).slice(0, 4);
    $('notificationsList').replaceChildren(...items.map(item => {
      const button = element('button', 'notification-item');
      button.type = 'button';
      button.append(makeImage(item, '', false, true));
      const content = element('div');
      content.append(element('strong', '', item.title), element('span', '', 'Em cartaz · ' + item.date.slice(0, 4)));
      button.append(content);
      button.addEventListener('click', () => openDetails(item, button));
      return button;
    }));
    if (!items.length) $('notificationsList').append(element('p', 'dropdown-empty', 'Nenhuma novidade disponível.'));
  } catch { $('notificationsList').replaceChildren(element('p', 'dropdown-empty', 'As novidades não estão disponíveis agora.')); }
}
async function configureApi(event) {
  event.preventDefault();
  const input = $('apiInput').value.trim();
  const previous = apiKey;
  const button = $('apiForm').querySelector('button[type=submit]');
  button.disabled = true; $('apiError').textContent = '';
  apiKey = input;
  try {
    await api.request('/configuration', {}, { cache: false });
    writeStorage('stream-study:tmdb', input, true);
    api.clear();
    $('apiDialog').close();
    $('apiInput').value = '';
    destroyHero();
    loadCatalog();
    loadNotifications();
    showToast('Catálogo configurado.');
  } catch {
    apiKey = previous;
    $('apiError').textContent = 'Não foi possível validar a chave. Confira a chave e a conexão.';
  } finally { button.disabled = false; }
}
function init() {
  loadProfile();
  $('autoPreviews').checked = state.autoPreviews;
  // Avisos de carregamento ficam depois das fileiras para não cobrir o destaque.
  $('rows').after($('catalogStatus'));
  if (typeof ResizeObserver !== 'undefined') {
    state.resizeObserver = new ResizeObserver(entries => entries.forEach(entry => state.rails.get(entry.target)?.()));
  }
  document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); navigate(link.dataset.view);
  }));
  $('mobileNav').addEventListener('change', event => navigate(event.target.value));
  document.querySelectorAll('[data-dropdown]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.dropdown;
    const open = $(id).hidden;
    closeDropdowns(id);
    $(id).hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }));
  document.addEventListener('click', event => { if (!event.target.closest('.nav-dropdown')) closeDropdowns(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeDropdowns(); hidePreview(); }
  });
  document.querySelectorAll('[data-profile]').forEach(button => button.addEventListener('click', () => {
    state.profile = button.dataset.profile;
    writeStorage('stream-study:profile', state.profile);
    loadProfile(); closeDropdowns(); syncActions();
    loadCatalog();
    showToast('Perfil de ' + PROFILES[state.profile].name);
  }));
  $('autoPreviews').addEventListener('change', async event => {
    state.autoPreviews = event.target.checked;
    writeStorage('stream-study:previews', state.autoPreviews);
    if (!state.autoPreviews) destroyHero();
    else if (state.hero) hydrateHero(state.hero, state.heroVersion);
  });
  $('searchToggle').addEventListener('click', () => setSearchOpen($('searchInput').hidden));
  $('searchClear').addEventListener('click', () => { clearSearch(); $('searchInput').focus(); });
  $('searchInput').addEventListener('input', () => queueSearch());
  $('searchInput').addEventListener('keydown', event => {
    if (event.key === 'Escape') { setSearchOpen(false); $('searchToggle').focus(); }
  });
  $('searchBox').addEventListener('submit', event => { event.preventDefault(); queueSearch(true); });
  $('billInfoBtn').addEventListener('click', event => { if (state.hero) openDetails(state.hero, event.currentTarget); });
  $('billPlayBtn').addEventListener('click', event => { if (state.hero) openDetails(state.hero, event.currentTarget, true); });
  $('muteBtn').addEventListener('click', () => {
    if (!state.heroPlayer) return;
    state.muted = !state.muted;
    if (state.muted) state.heroPlayer.mute(); else state.heroPlayer.unMute();
    $('muteBtn').replaceChildren(icon(state.muted ? 'mute' : 'volume'));
    $('muteBtn').setAttribute('aria-label', state.muted ? 'Ativar som da prévia' : 'Silenciar prévia');
  });
  $('cardPreview').addEventListener('pointerenter', () => clearTimeout(state.hidePreviewTimer));
  $('cardPreview').addEventListener('pointerleave', scheduleHidePreview);
  $('modalClose').addEventListener('click', () => $('titleDialog').close());
  $('titleDialog').addEventListener('close', closeTitle);
  $('titleDialog').addEventListener('click', event => {
    const rect = $('titleDialog').getBoundingClientRect();
    if (event.target === $('titleDialog') && (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom)) $('titleDialog').close();
  });
  $('modalList').addEventListener('click', () => { if (state.modalItem) toggleList(state.modalItem); });
  $('modalLike').addEventListener('click', () => { if (state.modalItem) toggleLike(state.modalItem); });
  $('modalPlay').addEventListener('click', startModalTrailer);
  $('apiSettings').addEventListener('click', () => { $('apiError').textContent = ''; $('apiDialog').showModal(); });
  $('apiClose').addEventListener('click', () => $('apiDialog').close());
  $('apiForm').addEventListener('submit', configureApi);
  let scrollScheduled = false;
  window.addEventListener('scroll', () => {
    hidePreview();
    if (!scrollScheduled) {
      scrollScheduled = true;
      requestAnimationFrame(() => {
        $('navbar').classList.toggle('solid', window.scrollY > 30 || $('billboard').hidden);
        scrollScheduled = false;
      });
    }
  }, { passive: true });
  window.addEventListener('resize', hidePreview);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pauseHero(); try { state.modalPlayer?.pauseVideo(); } catch {} }
  });
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver(([entry]) => {
      state.heroVisible = entry.isIntersecting;
      if (!entry.isIntersecting) pauseHero();
      else if (canAutoPreview() && !$('titleDialog').open && !state.searching) {
        try { state.heroPlayer?.playVideo(); } catch {}
      }
    }, { threshold: .25 }).observe($('billboard'));
  }
  const views = { '#series': 'tv', '#filmes': 'movie', '#bombando': 'trending', '#minha-lista': 'list' };
  loadCatalog(views[location.hash] || 'home');
  loadNotifications();
}
// Os utilitários também podem ser verificados em Node, sem executar a interface.
if (typeof document !== 'undefined') init();
