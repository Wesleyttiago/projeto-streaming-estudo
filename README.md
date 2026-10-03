# Interface de streaming — projeto de estudo

Uma interface inspirada na página de navegação da Netflix, desenvolvida por Wesley Tiago para estudar HTML, CSS, JavaScript e consumo de APIs.

[Abrir demonstração](https://wesleyttiago.github.io/projeto-streaming-estudo/)

## Funcionalidades

- Destaque com imagem, identidade visual do título e prévia opcional. A imagem permanece enquanto o YouTube não confirma a reprodução.
- Fileiras com rolagem nativa, botões de navegação, gestos de toque e teclado, sem cartões duplicados.
- Prévia flutuante ao passar o mouse, sem recortar a interface nem abrir dezenas de players.
- Navegação entre início, filmes, séries, títulos em alta e lista pessoal.
- Busca por títulos com debounce, cancelamento da consulta anterior e estados de erro ou vazio.
- Detalhes com sinopse, elenco, gêneros, classificação brasileira quando disponível, duração e recomendações.
- Trailers do YouTube, com alternativa de abrir no YouTube quando a reprodução incorporada estiver indisponível.
- Minha lista e avaliações salvas no navegador, separadas por perfil de estudo.
- Layout responsivo, diálogos nativos com Escape, rótulos acessíveis e respeito a movimento reduzido.

## Organização

| Arquivo | Responsabilidade |
| --- | --- |
| `index.html` | Conteúdo, navegação, ícones e diálogos |
| `style.css` | Layout, estados, prévia e adaptações de tela |
| `script.js` | Cliente da API, estado, armazenamento e interações |
| `tests/catalog.test.cjs` | Testes de dados, buscas, armazenamento e requisições |

Não há framework, instalação de dependências ou compilação. Para executar localmente:

```sh
python3 -m http.server 8000
```

Abra `http://localhost:8000`. Para verificar o JavaScript e executar os testes (Node.js 18 ou superior):

```sh
node --check script.js
node --test tests/catalog.test.cjs
```

## Dados e preferências

Os títulos e as notas vêm do TMDB. A interface não inventa percentuais de relevância, gêneros, classificação etária ou progresso de reprodução. “Top 10” descreve os primeiros resultados de popularidade do TMDB, e não o ranking da Netflix no Brasil. O catálogo também não representa a disponibilidade na Netflix.

O armazenamento é local a este navegador. Os perfis são uma demonstração, sem contas ou sincronização. Se o navegador bloquear armazenamento, as ações continuam disponíveis na sessão atual. O histórico é de títulos explorados, não de filmes assistidos.

A configuração do catálogo permite usar uma chave v3 do TMDB durante a sessão. A chave já presente no projeto foi preservada; qualquer chave incluída em uma aplicação estática é visível ao navegador. Em uma aplicação de produção, a autorização de API deve ser tratada em um backend próprio.

## Referências

- [Documentação do TMDB](https://developer.themoviedb.org/docs/getting-started)
- [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
- [Busca e navegação na Netflix](https://help.netflix.com/pt/node/47765)

Projeto educacional sem vínculo com a Netflix. Este produto usa a API do TMDB, mas não é endossado ou certificado pelo TMDB. Os vídeos são trailers incorporados do YouTube, sujeitos à disponibilidade e às regras do player.
