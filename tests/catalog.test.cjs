const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');

function app(extra = {}) {
  const context = vm.createContext({ URL, URLSearchParams, AbortController, DOMException,
    setTimeout, clearTimeout, ...extra });
  vm.runInContext(source, context);
  return { run: expression => vm.runInContext(expression, context), context };
}

test('identifica séries no catálogo misto e descarta pessoas/adultos', () => {
  const { run } = app();
  const result = JSON.parse(run(`JSON.stringify(uniqueItems([
    {id: 42, media_type: 'tv', name: 'Uma série', first_air_date: '2020-10-03'},
    {id: 42, media_type: 'tv', name: 'Uma série duplicada'},
    {id: 42, media_type: 'movie', title: 'Um filme'},
    {id: 9, media_type: 'person', name: 'Uma pessoa'},
    {id: 10, title: 'Adulto', adult: true}
  ]))`));
  assert.deepEqual(result.map(i => [i.key, i.title]), [['tv:42', 'Uma série'], ['movie:42', 'Um filme']]);
  assert.equal(result[0].date, '2020-10-03');
});

test('lista salva malformada não derruba o catálogo nem injeta URLs externas', () => {
  const { run } = app();
  assert.equal(run('parseSavedItems({malformed:true}).length'), 0);
  const item = JSON.parse(run(`JSON.stringify(parseSavedItems([
    {id: 1, type:'tv', title:'Título salvo', backdrop_path:'/imagem.jpg', date:'2023-01-01'},
    {id: -1, title:'Inválido'},
    {id: 2, title:'Outro', backdrop_path:'https://invalid.example/image.jpg'}
  ]))`));
  assert.equal(item[0].type, 'tv');
  assert.equal(item[0].date, '2023-01-01');
  assert.equal(item[1].backdrop_path, null);
});

test('preferências continuam utilizáveis quando armazenamento está bloqueado', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const { run } = app({ localStorage: broken, sessionStorage: broken });
  assert.equal(run(`readStorage('key', 'fallback')`), 'fallback');
  assert.equal(run(`writeStorage('key', [])`), false);
});

test('seleciona trailer oficial do YouTube e ignora IDs inseguros', () => {
  const { run } = app();
  assert.equal(run(`selectTrailer([
    {site:'YouTube',type:'Trailer',key:'abcdefghijk',official:false},
    {site:'YouTube',type:'Trailer',key:'ABCDEFGHIJK',official:true},
    {site:'YouTube',type:'Trailer',key:'javascript:invalid',official:true},
    {site:'Vimeo',type:'Trailer',key:'12345678901',official:true}
  ])`), 'ABCDEFGHIJK');
  assert.equal(run('selectTrailer([])'), null);
});

test('classificação brasileira vem dos dados reais e não de um padrão inventado', () => {
  const { run } = app();
  assert.equal(run(`certification({content_ratings:{results:[{iso_3166_1:'BR',rating:'14'}]}},'tv')`), '14+');
  assert.equal(run(`certification({release_dates:{results:[{iso_3166_1:'BR',release_dates:[{certification:'L'}]}]}},'movie')`), 'L');
  assert.equal(run(`certification({},'movie')`), '');
});

test('busca antiga é invalidada antes mesmo de iniciar a nova requisição', () => {
  const { run } = app();
  run('var gate = createRequestGate(); var first = gate.begin(); var second = gate.begin();');
  assert.equal(run('first.signal.aborted'), true);
  assert.equal(run('gate.isCurrent(first)'), false);
  assert.equal(run('gate.isCurrent(second)'), true);
  run('gate.cancel()');
  assert.equal(run('gate.isCurrent(second)'), false);
});

test('cliente codifica pesquisa, preserva idioma e usa cache', async () => {
  const calls = [];
  const { run, context } = app();
  context.mockFetch = async url => { calls.push(new URL(url)); return { ok: true, json: async () => ({results:[]}) }; };
  run(`var client = createApiClient(() => 'test-key', mockFetch)`);
  await run(`client.request('/search/multi', {query:'A & B / série'})`);
  await run(`client.request('/search/multi', {query:'A & B / série'})`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('query'), 'A & B / série');
  assert.equal(calls[0].searchParams.get('language'), 'pt-BR');
  assert.equal(calls[0].searchParams.get('include_adult'), 'false');
  run('client.clear()');
  await run(`client.request('/search/multi', {query:'A & B / série'})`);
  assert.equal(calls.length, 2);
});

test('erros HTTP não são armazenados e não exibem a chave na mensagem', async () => {
  let calls = 0;
  const { run, context } = app();
  context.mockFetch = async () => { calls++; return { ok: false, status: 401 }; };
  run(`var client = createApiClient(() => 'private-test-key', mockFetch)`);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(run(`client.request('/movie/popular')`), error =>
      error.status === 401 && !error.message.includes('private-test-key'));
  }
  assert.equal(calls, 2);
});

test('cancelamento de consulta chega ao fetch', async () => {
  const { run, context } = app();
  context.mockFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')));
  });
  run(`var client = createApiClient(() => 'test-key', mockFetch); var controller = new AbortController()`);
  const pending = run(`client.request('/search/multi', {query:'teste'}, {signal:controller.signal})`);
  run('controller.abort()');
  await assert.rejects(pending, { name: 'AbortError' });
});

test('fileira avança cartões inteiros e marca a última página parcial', () => {
  const { run } = app();
  const metrics = JSON.parse(run(`JSON.stringify(railMetrics({
    width: 1000, contentWidth: 2650, itemWidth: 170, gap: 5, gutter: 40, offset: 1650
  }))`));
  assert.equal(metrics.step, 875);
  assert.equal(metrics.max, 1650);
  assert.equal(metrics.pages, 3);
  assert.equal(metrics.current, 2);
});

test('fileira curta tem uma página e não gera deslocamento negativo', () => {
  const { run } = app();
  const metrics = JSON.parse(run(`JSON.stringify(railMetrics({
    width: 320, contentWidth: 280, itemWidth: 110, gap: 5, gutter: 16, offset: 0
  }))`));
  assert.equal(metrics.max, 0);
  assert.equal(metrics.pages, 1);
  assert.equal(metrics.current, 0);
});

test('gêneros de séries e filmes usam seus respectivos identificadores', () => {
  const { run } = app();
  assert.equal(run("genreOptions('tv').some(g => g.id === 10759)"), true);
  assert.equal(run("genreOptions('tv').some(g => g.id === 28)"), false);
  assert.equal(run("genreOptions('movie').some(g => g.id === 28)"), true);
  assert.equal(run("genreOptions('home').length"), 0);
});

test('filtro de gênero usa discover e ignora gêneros incompatíveis', () => {
  const { run } = app();
  const rows = JSON.parse(run("JSON.stringify(catalogDefinitions('tv', 10759))"));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.path === '/discover/tv' && row.params.with_genres === 10759));
  assert.equal(run("catalogDefinitions('tv', 28).length"), 6);
  assert.equal(run("catalogDefinitions('home', 28).length"), 7);
});
