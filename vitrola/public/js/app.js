(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Tempo com a unidade menor ao lado do número ("0 min", "12 h 05 min"),
  // para o zero não ser confundido com a letra O.
  const partes = (ms) => {
    const total = Math.floor(ms / 60000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0
      ? `<b>${h}</b><i>h</i><b>${String(m).padStart(2, '0')}</b><i>min</i>`
      : `<b>${m}</b><i>min</i>`;
  };
  const tempo = (ms, classe = '') => `<span class="tempo ${classe}">${partes(ms)}</span>`;

  async function api(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/';
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  const capa = (src, classe) =>
    src
      ? `<img class="${classe}" src="${esc(src)}" alt="" width="48" height="48" loading="lazy">`
      : `<span class="${classe} ${classe}--vazio" aria-hidden="true"></span>`;

  // ---------- Painel 1: infos e tops ----------
  let range = 'medium_term';

  function listaTop(el, itens, tipo) {
    if (itens === null) {
      el.innerHTML = '<li class="top__vazio">Não foi possível carregar agora. Atualize a página em instantes.</li>';
      return;
    }
    if (!itens.length) {
      el.innerHTML = '<li class="top__vazio">Ainda não há dados para esse período.</li>';
      return;
    }
    el.innerHTML = itens
      .map((i, idx) => {
        const nome = i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.name)}</a>` : esc(i.name);
        return `<li class="top__item${idx < 3 ? ' top__item--destaque' : ''}">
          <span class="top__n">${idx + 1}</span>
          ${capa(i.image, tipo === 'artista' ? 'foto foto--redonda' : 'foto')}
          <span class="top__texto"><strong>${nome}</strong>${i.artists ? `<span>${esc(i.artists)}</span>` : ''}</span>
        </li>`;
      })
      .join('');
  }

  async function carregarPerfil() {
    try {
      const d = await api(`/api/me?range=${range}`);
      if (!d) return;
      $('#infos-total').innerHTML = partes(d.stats.totalMs);
      $('#infos-plays').textContent = d.stats.plays;
      const top = d.stats.topTrack;
      $('#infos-top').textContent = top ? `${top.name} (${top.count}×)` : 'Ainda sem dados';
      $('#infos-desde').textContent = `de música ouvida desde ${new Date(d.since).toLocaleDateString('pt-BR')}, quando você entrou`;
      listaTop($('#fav-artistas'), d.topArtists, 'artista');
      listaTop($('#fav-musicas'), d.topTracks, 'musica');
    } catch (e) {
      $('#fav-artistas').innerHTML = '<li class="top__vazio">Não foi possível carregar seu perfil. Atualize a página.</li>';
    }
  }

  document.querySelectorAll('.periodo').forEach((btn) =>
    btn.addEventListener('click', () => {
      range = btn.dataset.range;
      document.querySelectorAll('.periodo').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      carregarPerfil();
    })
  );

  // ---------- Painel 2: ouvindo agora ----------
  let chaveOuvindo = '';
  const estado = (m) => (m.now ? (m.now.isPlaying ? 'tocando' : 'pausa') : 'off');
  const ordemEstado = { tocando: 0, pausa: 1, off: 2 };

  function renderOuvindo(d) {
    const lista = [...d.members].sort((a, b) => ordemEstado[estado(a)] - ordemEstado[estado(b)]);
    const ativos = lista.filter((m) => estado(m) === 'tocando').length;

    $('#ouvindo-resumo').innerHTML = ativos
      ? `<span class="ao-vivo"><span class="ao-vivo__ponto" aria-hidden="true"></span>${ativos} ${ativos === 1 ? 'pessoa ouvindo' : 'pessoas ouvindo'} agora</span>`
      : 'Ninguém está ouvindo agora. Dê o play no Spotify.';

    // Só refaz os cartões se algo mudou, para o disco não reiniciar a cada atualização.
    const chave = JSON.stringify(lista.map((m) => [m.id, estado(m), m.now && m.now.name]));
    if (chave === chaveOuvindo) return;
    chaveOuvindo = chave;

    $('#ouvindo-lista').innerHTML = lista
      .map((m) => {
        const e = estado(m);
        const avatar = m.image
          ? `<img class="ouv__avatar" src="${esc(m.image)}" alt="" width="20" height="20" loading="lazy">`
          : '<span class="ouv__avatar ouv__avatar--vazio" aria-hidden="true"></span>';
        const disco = m.now && m.now.image
          ? `<img src="${esc(m.now.image)}" alt="" width="72" height="72">`
          : '<span class="ouv__capa-vazia"></span>';
        const texto = m.now
          ? `<strong class="ouv__musica">${esc(m.now.name)}</strong><span class="ouv__artista">${esc(m.now.artists)}</span>`
          : '<span class="ouv__artista">Nada tocando</span>';
        const rotulo = e === 'pausa' ? '<span class="ouv__pausa">Pausado</span>' : '';
        const barras = e === 'tocando' ? '<span class="barras" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' : '';
        return `<li class="ouv ouv--${e}">
          <div class="ouv__disco">${disco}</div>
          <div class="ouv__texto">
            <span class="ouv__quem">${avatar}${esc(m.name)}${m.id === d.me ? ' (você)' : ''}</span>
            ${texto}${rotulo}
          </div>
          ${barras}
        </li>`;
      })
      .join('');
  }

  // ---------- Painel 3: rank ----------
  let chaveRank = '';
  let compartilhamentoPronto = false;

  function configurarCompartilhar(d) {
    if (compartilhamentoPronto) return;
    compartilhamentoPronto = true;

    const texto = 'Olha o rank de quem mais ouviu música na nossa galera:';
    const u = encodeURIComponent(d.shareUrl);
    const t = encodeURIComponent(texto);

    $('#sh-whats').href = `https://wa.me/?text=${encodeURIComponent(`${texto} ${d.shareUrl}`)}`;
    $('#sh-x').href = `https://twitter.com/intent/tweet?text=${t}&url=${u}`;
    $('#sh-face').href = `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    $('#sh-tele').href = `https://t.me/share/url?url=${u}&text=${t}`;
    $('#sh-imagem').href = d.cardUrl;

    if (navigator.share) {
      const nativo = $('#sh-nativo');
      nativo.hidden = false;
      nativo.addEventListener('click', () => navigator.share({ title: 'Vitrine', text: texto, url: d.shareUrl }).catch(() => {}));
    }

    const copiar = (botao, valor, rotuloOriginal) =>
      botao.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(valor);
          botao.textContent = 'Copiado';
        } catch (e) {
          botao.textContent = 'Copie manualmente';
        }
        setTimeout(() => (botao.textContent = rotuloOriginal), 2000);
      });

    copiar($('#sh-copiar'), d.shareUrl, 'Copiar link');
    copiar($('#convite-copiar'), d.inviteUrl, 'Copiar convite');
    $('#convite-link').value = d.inviteUrl;
    $('#convite-whats').href = `https://wa.me/?text=${encodeURIComponent(`Entra na Vitrine pra ver o rank da nossa galera: ${d.inviteUrl}`)}`;
  }

  function renderRank(d) {
    const aviso = $('#rank-aviso');
    const semDados = d.members.every((m) => m.totalMs === 0);
    aviso.hidden = !semDados;
    if (semDados) {
      aviso.textContent = 'O rank conta a partir do momento em que cada pessoa entra. Ouça algumas músicas e volte em alguns minutos.';
    }
    $('#vagas').textContent = `O grupo tem ${d.members.length} de ${d.maxSize} vagas ocupadas.`;

    // Só refaz a lista se os números mudaram, para as barras animarem apenas quando há novidade.
    const chave = JSON.stringify(d.members.map((m) => [m.id, m.name, m.totalMs, m.plays, m.topTrack && m.topTrack.id]));
    if (chave === chaveRank) return;
    chaveRank = chave;

    const maior = Math.max(0, ...d.members.map((m) => m.totalMs));

    $('#rank-lista').innerHTML = d.members
      .map((m, i) => {
        const pct = maior > 0 ? Math.max(m.totalMs > 0 ? 2 : 0, Math.round((m.totalMs / maior) * 100)) : 0;
        const classes = ['rank__item'];
        if (i === 0 && m.totalMs > 0) classes.push('rank__item--primeiro');
        if (m.id === d.me) classes.push('rank__item--eu');
        const avatar = m.image
          ? `<img class="avatar" src="${esc(m.image)}" alt="" width="48" height="48" loading="lazy">`
          : `<span class="avatar avatar--vazio" aria-hidden="true">${esc(m.name.charAt(0).toUpperCase())}</span>`;
        return `<li class="${classes.join(' ')}">
          <span class="rank__pos">${i + 1}</span>
          ${avatar}
          <div class="rank__meio">
            <div class="rank__linha">
              <strong class="rank__nome">${esc(m.name)}${m.id === d.me ? ' (você)' : ''}</strong>
              ${tempo(m.totalMs, 'rank__total')}
            </div>
            <div class="rank__barra"><span data-w="${pct}" style="width:0"></span></div>
            <p class="rank__detalhe">${m.plays} ${m.plays === 1 ? 'música ouvida' : 'músicas ouvidas'}${m.topTrack ? `. Mais ouvida: ${esc(m.topTrack.name)} (${m.topTrack.count}×)` : ''}</p>
          </div>
        </li>`;
      })
      .join('');

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.querySelectorAll('.rank__barra span').forEach((s) => (s.style.width = `${s.dataset.w}%`));
      })
    );
  }

  async function carregarRank() {
    try {
      const d = await api('/api/rank');
      if (!d) return;
      configurarCompartilhar(d);
      renderOuvindo(d);
      renderRank(d);
    } catch (e) {
      const aviso = $('#rank-aviso');
      aviso.hidden = false;
      aviso.textContent = 'Não foi possível atualizar agora. Vamos tentar de novo em instantes.';
    }
  }

  // ---------- Inicialização e atualização ao vivo ----------
  carregarPerfil();
  carregarRank();
  setInterval(() => {
    if (!document.hidden) carregarRank();
  }, 15000);
  setInterval(() => {
    if (!document.hidden) carregarPerfil();
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) carregarRank();
  });
})();
