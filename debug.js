"use strict";

const API = "https://graphql.anilist.co";

// ─── Requêtes GraphQL ───────────────────────────────────────────────────
const Q_FAVOURITES = `
query ($username: String!, $page: Int) {
  User(name: $username) {
    favourites {
      anime(page: $page, perPage: 25) {
        pageInfo { hasNextPage }
        nodes {
          id
          title { romaji english }
        }
      }
    }
  }
}`;

const Q_MEDIA_DETAILS = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      title { romaji english }
      genres
      tags { name rank }
      format
      meanScore
    }
  }
}`;

const Q_LIST = `
query ($username: String!) {
  MediaListCollection(userName: $username, type: ANIME, sort: SCORE_DESC) {
    lists {
      status
      entries {
        mediaId
        score(format: POINT_10)
        status
        media {
          title { romaji english }
          genres
          tags { name rank }
          format
        }
      }
    }
  }
}`;

const Q_RECS = `
query ($mediaId: Int!, $page: Int) {
  Media(id: $mediaId) {
    title { romaji english }
    recommendations(page: $page, perPage: 25, sort: RATING_DESC) {
      pageInfo { hasNextPage }
      nodes {
        rating
        mediaRecommendation {
          id
          title { romaji english }
          genres
          format
          meanScore
        }
      }
    }
  }
}`;

// ─── Helpers ────────────────────────────────────────────────────────────
const MAX_RETRIES = 5;

async function gql(query, variables = {}, attempt = 0) {
  // Délai inter-requête pour éviter le rate limit (1s entre chaque appel)
  await new Promise(r => setTimeout(r, attempt === 0 ? 300 : 0));

  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  // Retry sur 429 (rate limit) ou 500 (erreur serveur temporaire)
  if (res.status === 429 || res.status === 500) {
    if (attempt >= MAX_RETRIES) {
      throw new Error("API AniList surchargée (trop de requêtes). Réessaie dans 1-2 minutes.");
    }
    const delay = Math.min(2000 * Math.pow(2, attempt), 30000); // 2s, 4s, 8s, 16s, 30s
    console.warn(`⏳ API ${res.status} — retry ${attempt + 1}/${MAX_RETRIES} dans ${delay / 1000}s…`);
    await new Promise(r => setTimeout(r, delay));
    return gql(query, variables, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Erreur API: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join(", "));
  return json.data;
}

function getTitle(media) {
  return media.title.english || media.title.romaji || "#" + media.id;
}

function esc(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

function graphiqlLink(query, variables) {
  const base = "https://anilist.co/graphiql";
  const q = encodeURIComponent(query.trim());
  const v = encodeURIComponent(JSON.stringify(variables));
  return base + "?query=" + q + "&variables=" + v;
}

// ─── Main ───────────────────────────────────────────────────────────────
async function runAll() {
  const username = document.getElementById("username").value.trim();
  if (!username) { alert("Entre ton pseudo AniList !"); return; }

  const out = document.getElementById("output");
  const btn = document.getElementById("go-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Chargement…";
  out.innerHTML = '<div class="status">Récupération des données pour <strong>' + esc(username) + '</strong>…</div>';

  try {
    // 1. Favoris (IDs seulement, comme le popup)
    out.innerHTML = '<div class="status">⏳ Étape 1/5 — Récupération des favoris…</div>';
    const favNodes = [];
    let page = 1, hasNext = true;
    while (hasNext && page <= 10) {
      const data = await gql(Q_FAVOURITES, { username, page });
      if (!data.User) throw new Error('Utilisateur "' + username + '" introuvable');
      const anime = data.User.favourites.anime;
      favNodes.push(...anime.nodes);
      hasNext = anime.pageInfo.hasNextPage;
      page++;
    }

    // 2. Détails des favoris (requête séparée, plus stable)
    out.innerHTML = '<div class="status">⏳ Étape 2/5 — Détails des ' + favNodes.length + ' favoris…</div>';
    const favourites = [];
    const favIds = favNodes.map(f => f.id);
    // Batches de 50 (limite API Page)
    for (let i = 0; i < favIds.length; i += 50) {
      const batch = favIds.slice(i, i + 50);
      const detailData = await gql(Q_MEDIA_DETAILS, { ids: batch });
      favourites.push(...detailData.Page.media);
    }

    // 3. Liste
    out.innerHTML = '<div class="status">⏳ Étape 3/5 — Récupération de la liste (' + favourites.length + ' favoris trouvés)…</div>';
    const listData = await gql(Q_LIST, { username });
    const allEntries = [];
    for (const list of listData.MediaListCollection.lists) {
      for (const entry of list.entries) {
        entry.status = entry.status || list.status;
        allEntries.push(entry);
      }
    }
    allEntries.sort((a, b) => b.score - a.score);

    // 4. Profils
    out.innerHTML = '<div class="status">⏳ Étape 4/5 — Analyse des genres et tags (' + allEntries.length + ' entrées)…</div>';
    const genreMap = new Map();
    const tagMap = new Map();
    for (const e of allEntries) {
      for (const g of (e.media.genres || [])) genreMap.set(g, (genreMap.get(g) || 0) + 1);
      for (const t of (e.media.tags || [])) {
        const ex = tagMap.get(t.name);
        if (ex) { ex.total += t.rank; ex.count++; }
        else tagMap.set(t.name, { total: t.rank, count: 1 });
      }
    }
    const genreSorted = [...genreMap.entries()].sort((a, b) => b[1] - a[1]);
    const tagSorted = [...tagMap.entries()]
      .map(([name, v]) => ({ name, avg: Math.round(v.total / v.count), count: v.count }))
      .sort((a, b) => b.avg - a.avg);
    const maxGenre = genreSorted[0]?.[1] || 1;

    // 5. Recos d'un favori (échantillon)
    out.innerHTML = '<div class="status">⏳ Étape 5/5 — Échantillon de recommandations…</div>';
    let sampleRecs = [];
    let sampleSource = null;
    if (favourites.length > 0) {
      sampleSource = favourites[0];
      try {
        const recData = await gql(Q_RECS, { mediaId: sampleSource.id, page: 1 });
        sampleRecs = recData.Media.recommendations.nodes
          .filter(n => n.mediaRecommendation)
          .map(n => ({ ...n.mediaRecommendation, rating: n.rating }));
      } catch (e) { console.warn("Sample recs failed:", e); }
    }

    // Render
    out.innerHTML = renderAll(username, favourites, allEntries, genreSorted, maxGenre, tagSorted, sampleSource, sampleRecs);

  } catch (err) {
    out.innerHTML = '<div class="section"><p class="error">❌ ' + esc(err.message) + '</p></div>';
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Analyser";
  }
}

function renderAll(username, favourites, allEntries, genreSorted, maxGenre, tagSorted, sampleSource, sampleRecs) {
  const top50 = allEntries.filter(e => e.status !== "PLANNING" && e.score > 0).slice(0, 50);
  const planning = allEntries.filter(e => e.status === "PLANNING");
  const favIds = new Set(favourites.map(f => f.id));
  const topOnly = top50.filter(e => !favIds.has(e.mediaId));

  let html = '';

  // LIENS RAPIDES
  html += '<div class="section">';
  html += '<h2>🔗 Liens GraphQL directs</h2>';
  html += '<p style="color:var(--muted);font-size:.85rem;margin-bottom:12px;">';
  html += 'Clique sur un lien pour ouvrir la requête dans l\'explorateur GraphQL d\'AniList. ';
  html += 'Tu peux modifier la query et cliquer "Play" pour tester.</p>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
  html += '<a class="gql-link" href="' + graphiqlLink(Q_FAVOURITES, { username, page: 1 }) + '" target="_blank">⭐ Mes favoris (GraphQL)</a>';
  html += '<a class="gql-link" href="' + graphiqlLink(Q_LIST, { username }) + '" target="_blank">📋 Ma liste complète (GraphQL)</a>';
  if (sampleSource) {
    html += '<a class="gql-link" href="' + graphiqlLink(Q_RECS, { mediaId: sampleSource.id, page: 1 }) + '" target="_blank">💡 Recos de "' + esc(getTitle(sampleSource)) + '" (GraphQL)</a>';
  }
  html += '</div></div>';

  // FAVORIS
  html += '<div class="section">';
  html += '<h2>⭐ Tes Favoris <span class="count">' + favourites.length + '</span>';
  html += ' <a class="gql-link" href="' + graphiqlLink(Q_FAVOURITES, { username, page: 1 }) + '" target="_blank">GraphQL</a></h2>';
  html += '<p style="color:var(--muted);font-size:.82rem;margin-bottom:10px;">Chaque favori = source avec poids <strong>×2</strong></p>';
  html += '<table><thead><tr><th>#</th><th>Titre</th><th>Format</th><th>Score moyen</th><th>Genres</th></tr></thead><tbody>';
  favourites.forEach((f, i) => {
    html += '<tr><td>' + (i+1) + '</td>';
    html += '<td><a href="https://anilist.co/anime/' + f.id + '" target="_blank" style="color:var(--text);text-decoration:none;">' + esc(getTitle(f)) + '</a></td>';
    html += '<td>' + (f.format || "-") + '</td>';
    html += '<td>' + (f.meanScore ? f.meanScore + "%" : "-") + '</td>';
    html += '<td>' + (f.genres || []).map(g => '<span class="tag">' + g + '</span>').join(" ") + '</td></tr>';
  });
  html += '</tbody></table></div>';

  // TOP NOTÉS
  html += '<div class="section">';
  html += '<h2>▲ Top notés (hors favoris) <span class="count">' + topOnly.length + '</span>';
  html += ' <a class="gql-link" href="' + graphiqlLink(Q_LIST, { username }) + '" target="_blank">GraphQL</a></h2>';
  html += '<p style="color:var(--muted);font-size:.82rem;margin-bottom:10px;">Poids <strong>×1</strong></p>';
  html += '<table><thead><tr><th>#</th><th>Titre</th><th>Score</th><th>Genres</th></tr></thead><tbody>';
  topOnly.forEach((e, i) => {
    html += '<tr><td>' + (i+1) + '</td>';
    html += '<td>' + esc(e.media.title.english || e.media.title.romaji) + '</td>';
    html += '<td class="score">' + e.score + '/10</td>';
    html += '<td>' + (e.media.genres || []).map(g => '<span class="tag">' + g + '</span>').join(" ") + '</td></tr>';
  });
  html += '</tbody></table></div>';

  // PROFIL GENRES
  html += '<div class="section">';
  html += '<h2>📊 Profil Genres <span class="count">' + genreSorted.length + '</span></h2>';
  html += '<p style="color:var(--muted);font-size:.82rem;margin-bottom:10px;">Top 10 = bonus +0.3/genre aux recos</p>';
  genreSorted.forEach(([g, count]) => {
    html += '<div class="genre-bar-row">';
    html += '<div class="genre-bar-label">' + g + '</div>';
    html += '<div class="genre-bar-track"><div class="genre-bar-fill" style="width:' + Math.round(count / maxGenre * 100) + '%"></div></div>';
    html += '<div class="genre-bar-count">' + count + '</div></div>';
  });
  html += '</div>';

  // PROFIL TAGS
  html += '<div class="section">';
  html += '<h2>🏷️ Profil Tags <span class="count">top 30</span></h2>';
  html += '<p style="color:var(--muted);font-size:.82rem;margin-bottom:10px;">Bonus +0.5/tag commun aux recos</p>';
  html += '<table><thead><tr><th>Tag</th><th>Rank moyen</th><th>Apparitions</th></tr></thead><tbody>';
  tagSorted.slice(0, 30).forEach(t => {
    html += '<tr><td>' + esc(t.name) + '</td><td class="score">' + t.avg + '%</td><td>' + t.count + ' animes</td></tr>';
  });
  html += '</tbody></table></div>';

  // ÉCHANTILLON RECOS
  if (sampleSource) {
    html += '<div class="section">';
    html += '<h2>💡 Recos pour "' + esc(getTitle(sampleSource)) + '" <span class="count">' + sampleRecs.length + '</span>';
    html += ' <a class="gql-link" href="' + graphiqlLink(Q_RECS, { mediaId: sampleSource.id, page: 1 }) + '" target="_blank">GraphQL</a></h2>';
    html += '<p style="color:var(--muted);font-size:.82rem;margin-bottom:10px;">Ce que l\'API AniList renvoie pour ton 1er favori</p>';
    html += '<table><thead><tr><th>#</th><th>Titre</th><th>Rating</th><th>Genres</th><th>Score moyen</th></tr></thead><tbody>';
    sampleRecs.forEach((r, i) => {
      html += '<tr><td>' + (i+1) + '</td>';
      html += '<td><a href="https://anilist.co/anime/' + r.id + '" target="_blank" style="color:var(--text);text-decoration:none;">' + esc(getTitle(r)) + '</a></td>';
      html += '<td class="score">' + (r.rating > 0 ? "+" + r.rating : r.rating) + '</td>';
      html += '<td>' + (r.genres || []).map(g => '<span class="tag">' + g + '</span>').join(" ") + '</td>';
      html += '<td>' + (r.meanScore ? r.meanScore + "%" : "-") + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // PLANNING
  html += '<div class="section">';
  html += '<h2>📋 Plan to Watch <span class="count">' + planning.length + '</span></h2>';
  html += '<details><summary>Afficher les ' + planning.length + ' entrées</summary>';
  html += '<table><thead><tr><th>Titre</th><th>Genres</th></tr></thead><tbody>';
  planning.forEach(e => {
    html += '<tr><td>' + esc(e.media.title.english || e.media.title.romaji) + '</td>';
    html += '<td>' + (e.media.genres || []).map(g => '<span class="tag">' + g + '</span>').join(" ") + '</td></tr>';
  });
  html += '</tbody></table></details></div>';

  // RÉSUMÉ ALGO
  html += '<div class="section"><h2>⚙️ Résumé de l\'algorithme</h2><table><tbody>';
  html += '<tr><td>Sources favoris</td><td><strong>' + favourites.length + '</strong> × poids 2</td></tr>';
  html += '<tr><td>Sources top notés</td><td><strong>' + topOnly.length + '</strong> × poids 1</td></tr>';
  html += '<tr><td>Bonus tag commun</td><td>+0.5/tag (max 3 = +1.5)</td></tr>';
  html += '<tr><td>Bonus genre commun</td><td>+0.3/genre (max 3 = +0.9)</td></tr>';
  html += '<tr><td>Diversité genre</td><td>Max 5 du même genre principal dans le top</td></tr>';
  html += '<tr><td>Cache</td><td>30 minutes</td></tr>';
  html += '</tbody></table></div>';

  // JSON BRUT
  html += '<div class="section"><h2>📦 Données brutes</h2>';
  html += '<details><summary>Favoris JSON</summary><div class="raw-json">' + esc(JSON.stringify(favourites, null, 2)) + '</div></details>';
  html += '<details><summary>Tags JSON</summary><div class="raw-json">' + esc(JSON.stringify(tagSorted.slice(0, 50), null, 2)) + '</div></details>';
  html += '<details><summary>Genres JSON</summary><div class="raw-json">' + esc(JSON.stringify(genreSorted, null, 2)) + '</div></details>';
  html += '</div>';

  return html;
}

// ── Init ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("go-btn").addEventListener("click", runAll);
  document.getElementById("username").addEventListener("keydown", e => {
    if (e.key === "Enter") runAll();
  });
});
