# Vitrine

Rank de amigos com dados do Spotify, feito em Node.js + SCSS.

- **Parte de cima:** seu perfil (tempo de escuta, reproduções, música mais tocada, artistas e músicas favoritos por período e o que está tocando agora).
- **Parte de baixo:** rank do grupo por tempo de escuta, com a música mais ouvida de cada um e o que cada um está ouvindo em tempo real.
- **Compartilhar:** WhatsApp, X, Facebook, Telegram, compartilhamento nativo do celular, copiar link e imagem PNG do rank.

## Como rodar

1. Crie um app em https://developer.spotify.com/dashboard
   - Em **Redirect URIs**, adicione `http://127.0.0.1:3000/auth/callback` (o Spotify exige `127.0.0.1`, não `localhost`).
   - Em **User Management**, adicione o nome e o e-mail de cada pessoa que vai usar (você e seus amigos). Sem isso, o Spotify recusa o login.
2. Copie `.env.example` para `.env` e preencha `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` e `SESSION_SECRET`.
3. Instale e inicie:
   ```bash
   npm install
   npm start
   ```
4. Abra http://127.0.0.1:3000, entre com o Spotify e use "Convidar amigos" para mandar o link de convite.

Durante o desenvolvimento, use `npm run dev` (recompila o CSS e reinicia o servidor ao salvar arquivos JS). Para editar o SCSS com recompilação automática, rode `npm run watch:css` em outro terminal.

## Como funciona

- **Login:** OAuth do Spotify (Authorization Code). Os tokens ficam no SQLite (`data.db`) e são renovados automaticamente.
- **Amigos:** o Spotify não oferece lista de amigos na API. Cada grupo tem um link de convite, e quem entra por ele passa a fazer parte do rank.
- **Tempo de escuta:** o Spotify não informa o total ouvido. A cada 3 minutos o servidor lê o histórico recente de cada pessoa e soma a duração das faixas. A contagem começa quando a pessoa entra. A duração somada é a da faixa inteira, então é uma boa aproximação, não um valor exato.
- **Ouvindo agora:** o front pergunta ao servidor a cada 15 segundos, e o servidor guarda o resultado por 8 segundos para não estourar o limite de requisições.
- **Compartilhar:** `/r/<token>` é uma página pública com meta tags Open Graph, e `/r/<token>/card.png` é a imagem do rank.

## Para a prévia aparecer no WhatsApp

O WhatsApp só monta a prévia (imagem + título) se o link for acessível pela internet. Em `127.0.0.1` o botão funciona, mas sem prévia. Para testar com prévia, use um túnel (ngrok, Cloudflare Tunnel) ou publique o app, depois troque `BASE_URL` no `.env` e adicione a nova Redirect URI no painel do Spotify.

## Limites do Spotify (modo de desenvolvimento)

- A conta dona do app precisa ser Premium, e o app aceita até 5 usuários autorizados.
- Um conjunto menor de endpoints está disponível. Se algum recurso do perfil aparecer vazio, veja o log do servidor e a documentação atual do Spotify.
- Passar disso exige o modo estendido, que o Spotify concede só a empresas com muitos usuários.

## Privacidade

Quem tem o link `/r/<token>` vê nomes e tempo de escuta do grupo, sem login. O link é aleatório, mas trate-o como algo que só deve ir para quem você quer. O link de convite (`/convite/<código>`) permite entrar no grupo, então não o publique.

## Estrutura

```
server.js            rotas, login, API e página de compartilhamento
src/spotify.js       chamadas à API do Spotify e renovação de token
src/poller.js        coleta do histórico a cada 3 minutos
src/db.js            SQLite (grupos, usuários, reproduções)
views/               telas EJS
styles/              SCSS (compilado para public/css/main.css)
public/js/app.js     perfil, rank ao vivo e botões de compartilhar
```
