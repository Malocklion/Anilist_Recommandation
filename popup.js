/* ═══════════════════════════════════════════════════════════════════════════
   AniList Smart Recommendations v2.0 — popup.js
   ─────────────────────────────────────────────────
   Architecture :
     • AuthManager            → OAuth2 AniList + gestion du token
     • RecommendationEngine   → Logique de calcul pure (GraphQL, scoring, sources)
     • UIRenderer             → Gestion du DOM (cartes, filtres, backstage, etc.)
     • App                    → Contrôleur principal (orchestration)
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

// ─── Constants ──────────────────────────────────────────────────────────────
const ANILIST_API     = "https://graphql.anilist.co";
const ANILIST_AUTH_URL = "https://anilist.co/api/v2/oauth/authorize";
const WEIGHT_FAVOURITE = 2;
const WEIGHT_TOP_RATED = 1;
const TAG_BONUS        = 0.5;             // bonus par tag commun (max 3 tags = +1.5)
const GENRE_BONUS      = 0.3;             // bonus par genre commun avec profil (max 3 = +0.9)
const DIVERSITY_CAP    = 5;               // max d'animes du même genre principal dans le top
const CACHE_TTL_MS     = 24 * 60 * 60 * 1000; // 24 heures
const MAX_RETRIES      = 4;               // retry on 429
const MAX_FAV_SOURCES  = 15;              // max favoris utilisés comme source
const MAX_TOP_SOURCES  = 10;              // max top notés utilisés comme source

// Client ID chargé depuis config.js — NE PAS modifier ici
const ANILIST_CLIENT_ID = (typeof CONFIG !== "undefined" && CONFIG.ANILIST_CLIENT_ID !== "YOUR_CLIENT_ID")
  ? CONFIG.ANILIST_CLIENT_ID
  : "YOUR_CLIENT_ID";

/** Pause utilitaire. */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));


// ═══════════════════════════════════════════════════════════════════════════
//  GraphQL Queries & Mutations
// ═══════════════════════════════════════════════════════════════════════════

const QUERIES = {

  /** Profil du viewer authentifié. */
  VIEWER: `
    query {
      Viewer {
        id
        name
        avatar { medium large }
      }
    }
  `,

  /** Favoris animés (paginés) + titre source pour la justification. */
  USER_FAVOURITES: `
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
    }
  `,

  /** Liste complète (tous statuts), triée par score, avec tags et statut. */
  USER_LIST: `
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
            }
          }
        }
      }
    }
  `,

  /** Recommandations AniList pour un anime donné. */
  MEDIA_RECOMMENDATIONS: `
    query ($mediaId: Int!, $page: Int) {
      Media(id: $mediaId) {
        recommendations(page: $page, perPage: 25, sort: RATING_DESC) {
          pageInfo { hasNextPage }
          nodes {
            rating
            mediaRecommendation {
              id
              title { romaji english }
              coverImage { large extraLarge }
              format
              episodes
              season
              seasonYear
              meanScore
              genres
              tags { name rank }
              siteUrl
            }
          }
        }
      }
    }
  `,

  /** Mutation : Ajouter un anime à la liste PLANNING. */
  SAVE_MEDIA: `
    mutation ($mediaId: Int!) {
      SaveMediaListEntry(mediaId: $mediaId, status: PLANNING) {
        id
        status
      }
    }
  `,
};


// ═══════════════════════════════════════════════════════════════════════════
//  AuthManager — OAuth2 AniList + gestion du token
// ═══════════════════════════════════════════════════════════════════════════

class AuthManager {

  static _token = null;
  static _viewer = null;

  /** Charge le token et le viewer stockés, vérifie la validité. */
  static async init() {
    try {
      const { anilistToken, anilistViewer } = await chrome.storage.local.get(["anilistToken", "anilistViewer"]);
      if (anilistToken) {
        this._token = anilistToken;
        // Restaurer le viewer depuis le storage (instantané, pas d'API call)
        if (anilistViewer) {
          this._viewer = anilistViewer;
        } else {
          // Fallback: fetch du viewer si pas en cache
          this._viewer = await this._fetchViewer();
          chrome.storage.local.set({ anilistViewer: this._viewer });
        }
        return true;
      }
    } catch {
      await this.logout();
    }
    return false;
  }

  /** Lance le flow OAuth2 via chrome.identity. */
  static async login() {
    if (!ANILIST_CLIENT_ID || ANILIST_CLIENT_ID === "YOUR_ANILIST_CLIENT_ID") {
      throw new Error(
        "Client ID non configuré. Créez une app sur https://anilist.co/settings/developer, " +
        "puis collez votre Client ID dans popup.js (ligne ANILIST_CLIENT_ID)."
      );
    }
    const redirectUri = chrome.identity.getRedirectURL();
    console.log("[Auth] Redirect URI:", redirectUri);

    // AniList implicit grant : pas de redirect_uri dans l'URL,
    // AniList utilise celle configurée dans les settings développeur.
    const authUrl =
      `${ANILIST_AUTH_URL}?client_id=${ANILIST_CLIENT_ID}` +
      `&response_type=token`;

    console.log("[Auth] Auth URL:", authUrl);

    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        (responseUrl) => {
          console.log("[Auth] Response URL:", responseUrl);
          if (chrome.runtime.lastError || !responseUrl) {
            const errMsg = chrome.runtime.lastError?.message || "Authentification annulée";
            console.error("[Auth] Erreur:", errMsg);
            reject(new Error(errMsg));
            return;
          }
          const hashParams = new URLSearchParams(responseUrl.split("#")[1]);
          const token = hashParams.get("access_token");
          if (!token) { reject(new Error("Aucun token dans la réponse")); return; }

          this._token = token;
          chrome.storage.local.set({ anilistToken: token });
          // Fetch and persist viewer profile
          this._fetchViewer().then(viewer => {
            chrome.storage.local.set({ anilistViewer: viewer });
          }).catch(() => {});
          resolve(token);
        }
      );
    });
  }

  /** Déconnexion — efface token, viewer et cache de résultats. */
  static async logout() {
    this._token = null;
    this._viewer = null;
    await chrome.storage.local.remove(["anilistToken", "anilistViewer", "recoCache"]);
  }

  /** Requête GraphQL avec retry automatique sur rate-limit (429). */
  static async gqlRequest(query, variables = {}, _attempt = 0) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    if (this._token) headers["Authorization"] = `Bearer ${this._token}`;

    const payload = { query, variables };
    const body = JSON.stringify(payload);

    // 🔍 Console: requête GraphQL sortante
    const queryName = query.match(/^\s*(query|mutation)\s+(\w+)?/m);
    const label = queryName ? (queryName[2] || queryName[1]) : "anonymous";
    console.groupCollapsed(`[GQL →] ${label}  vars=${JSON.stringify(variables)}`);
    console.log("Query:", query.trim());
    console.log("Variables:", variables);
    console.groupEnd();

    const res = await fetch(ANILIST_API, { method: "POST", headers, body });

    // ── Rate-limit : retry avec backoff exponentiel ──
    if (res.status === 429) {
      if (_attempt >= MAX_RETRIES) throw new Error("AniList API: Too Many Requests.");
      const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** _attempt) * 1500;
      console.log(`[API] 429 — retry #${_attempt + 1} dans ${backoff}ms`);
      await sleep(backoff);
      return this.gqlRequest(query, variables, _attempt + 1);
    }

    let json;
    try { json = await res.json(); } catch {
      throw new Error(`AniList API ${res.status}: réponse non-JSON`);
    }

    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map(e => e.message).join(", ");
      if (msg.toLowerCase().includes("invalid token") || res.status === 401) {
        await this.logout();
        throw new Error("TOKEN_EXPIRED");
      }
      throw new Error(`AniList API: ${msg}`);
    }

    if (!res.ok && !json.data) throw new Error(`AniList API ${res.status}`);

    // 🔍 Console: réponse GraphQL
    console.groupCollapsed(`[GQL ←] ${label}  status=${res.status}`);
    console.log("Data:", json.data);
    console.groupEnd();

    return json.data;
  }

  /** Récupère le profil Viewer et le persiste. */
  static async _fetchViewer() {
    const data = await this.gqlRequest(QUERIES.VIEWER);
    if (!data.Viewer) throw new Error("Pas de viewer");
    this._viewer = data.Viewer;
    chrome.storage.local.set({ anilistViewer: data.Viewer });
    return data.Viewer;
  }

  static get token()      { return this._token; }
  static get viewer()     { return this._viewer; }
  static get isLoggedIn() { return !!this._token && !!this._viewer; }
}


// ═══════════════════════════════════════════════════════════════════════════
//  RecommendationEngine — Logique pure (aucun DOM)
// ═══════════════════════════════════════════════════════════════════════════
//  Chaque résultat :
//  {
//    media,
//    score,
//    reasons:    [{ sourceTitle, type, weight }],
//    commonTags: [{ name, strength }],
//  }
// ═══════════════════════════════════════════════════════════════════════════

class RecommendationEngine {

  // ── Favoris (avec titre) ──────────────────────────────────────────────

  static async fetchAllFavourites(username) {
    const results = [];
    let page = 1, hasNext = true;

    while (hasNext) {
      const data = await AuthManager.gqlRequest(QUERIES.USER_FAVOURITES, { username, page });
      if (!data.User) throw new Error(`Utilisateur "${username}" introuvable`);
      const anime = data.User.favourites.anime;
      for (const n of anime.nodes) {
        results.push({ id: n.id, title: n.title.english || n.title.romaji || `#${n.id}` });
      }
      hasNext = anime.pageInfo.hasNextPage;
      page++;
    }
    return results;
  }

  // ── Liste complète (avec tags) ────────────────────────────────────────

  static async fetchUserList(username) {
    const data = await AuthManager.gqlRequest(QUERIES.USER_LIST, { username });
    const all = [];
    for (const list of data.MediaListCollection.lists) {
      for (const entry of list.entries) {
        all.push({
          mediaId: entry.mediaId,
          score:   entry.score,
          status:  entry.status || list.status,
          title:   entry.media.title.english || entry.media.title.romaji,
          genres:  entry.media.genres || [],
          tags:    (entry.media.tags || []).map(t => ({ name: t.name, rank: t.rank })),
        });
      }
    }
    all.sort((a, b) => b.score - a.score);
    return all;
  }

  // ── Recommandations d'un anime ────────────────────────────────────────

  static async fetchRecommendationsForMedia(mediaId) {
    // Page 1 uniquement (top 25 recos les mieux notées, largement suffisant)
    const data = await AuthManager.gqlRequest(QUERIES.MEDIA_RECOMMENDATIONS, { mediaId, page: 1 });
    const recs = data.Media.recommendations;
    return recs.nodes
      .filter(n => n.mediaRecommendation)
      .map(n => n.mediaRecommendation);
  }

  // ── Pipeline complet ──────────────────────────────────────────────────

  static async computeRecommendations(username, onProgress = () => {}) {

    // 1. Récupération parallèle
    onProgress(1, 6, "Récupération de vos favoris et de votre liste…");
    const [favourites, userList] = await Promise.all([
      this.fetchAllFavourites(username),
      this.fetchUserList(username),
    ]);

    // 2. Ensembles
    // Séparer les PLANNING des vrais "vus" — les PLANNING restent dans les recos
    const planningIds  = new Set(userList.filter(e => e.status === "PLANNING").map(e => e.mediaId));
    const seenIds      = new Set(userList.filter(e => e.status !== "PLANNING").map(e => e.mediaId));
    const topRated     = userList.filter(e => e.status !== "PLANNING" && e.score > 0).slice(0, MAX_TOP_SOURCES + MAX_FAV_SOURCES);
    const favouriteSet = new Set(favourites.map(f => f.id));
    const topOnly      = topRated.filter(e => !favouriteSet.has(e.mediaId)).slice(0, MAX_TOP_SOURCES);

    // Profil de tags utilisateur (poids = rank moyen)
    const userTagMap = new Map();
    for (const entry of userList) {
      for (const tag of entry.tags) {
        const ex = userTagMap.get(tag.name);
        if (ex) { ex.totalRank += tag.rank; ex.count++; }
        else    { userTagMap.set(tag.name, { totalRank: tag.rank, count: 1 }); }
      }
    }

    // Profil de genres utilisateur (fréquence)
    const userGenreMap = new Map();
    for (const entry of userList) {
      for (const g of entry.genres) {
        userGenreMap.set(g, (userGenreMap.get(g) || 0) + 1);
      }
    }
    // Top genres = ceux qui reviennent le plus
    const topGenres = new Set(
      [...userGenreMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([g]) => g)
    );

    console.log("[Engine] Profil genres:", [...topGenres]);
    console.log("[Engine] Profil tags (top 15):",
      [...userTagMap.entries()]
        .map(([n, v]) => ({ name: n, avg: Math.round(v.totalRank / v.count), count: v.count }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, 15)
    );

    // 3. Tâches — favoris (×2, max 25) + top rated hors favoris (×1, max 15)
    const tasks = [];
    const usedFavs = favourites.slice(0, MAX_FAV_SOURCES);
    for (const fav of usedFavs) {
      tasks.push({ mediaId: fav.id, weight: WEIGHT_FAVOURITE, sourceTitle: fav.title, type: "favori" });
    }
    for (const entry of topOnly) {
      tasks.push({ mediaId: entry.mediaId, weight: WEIGHT_TOP_RATED, sourceTitle: entry.title, type: "top noté" });
    }

    console.log(`[Engine] ${usedFavs.length} favoris + ${topOnly.length} top notés = ${tasks.length} sources`);
    onProgress(2, 6, `Analyse de ${tasks.length} sources…`);

    // 4. UNE SEULE requête GraphQL compound pour TOUTES les sources
    //    Construit dynamiquement: { m0: Media(id:X){recommendations{...}} m1: ... }
    const scoreMap = new Map();

    // Découper en chunks de 12 max (limite de complexité AniList)
    const CHUNK = 12;
    for (let c = 0; c < tasks.length; c += CHUNK) {
      const chunk = tasks.slice(c, c + CHUNK);

      // Construire la query compound
      const fragments = chunk.map((t, i) => `
        m${i}: Media(id: ${t.mediaId}) {
          recommendations(page: 1, perPage: 15, sort: RATING_DESC) {
            nodes {
              mediaRecommendation {
                id
                title { romaji english }
                coverImage { large extraLarge }
                format
                episodes
                season
                seasonYear
                meanScore
                genres
                tags { name rank }
                siteUrl
              }
            }
          }
        }
      `).join("\n");
      const compoundQuery = `query { ${fragments} }`;

      try {
        const data = await AuthManager.gqlRequest(compoundQuery, {});

        // Parser les résultats
        chunk.forEach((task, i) => {
          const mediaData = data[`m${i}`];
          if (!mediaData?.recommendations?.nodes) return;

          for (const node of mediaData.recommendations.nodes) {
            const media = node.mediaRecommendation;
            if (!media) continue;
            const reason = { sourceTitle: task.sourceTitle, type: task.type, weight: task.weight };
            const existing = scoreMap.get(media.id);
            if (existing) {
              existing.baseScore += task.weight;
              existing.reasons.push(reason);
            } else {
              scoreMap.set(media.id, { media, baseScore: task.weight, reasons: [reason] });
            }
          }
        });
      } catch (err) {
        console.warn(`[Engine] Échec batch compound:`, err);
      }

      const done = Math.min(c + CHUNK, tasks.length);
      const pct = Math.round((done / tasks.length) * 100);
      onProgress(3, 6, `Recommandations : ${done}/${tasks.length} (${pct}%)…`);
    }

    // 5. Filtrage — exclure les vus, mais garder les PLANNING avec un flag
    onProgress(4, 6, "Filtrage des titres déjà vus…");
    const filtered = [];
    for (const [mediaId, entry] of scoreMap) {
      if (seenIds.has(mediaId)) continue; // Exclure les vrais vus
      entry.isPlanning = planningIds.has(mediaId);
      filtered.push(entry);
    }

    // 6. Tags communs + genre communs + bonus de score
    onProgress(5, 6, "Analyse des tags et genres communs…");
    for (const entry of filtered) {
      // Tags communs
      const common = [];
      for (const tag of (entry.media.tags || [])) {
        if (userTagMap.has(tag.name)) {
          const u = userTagMap.get(tag.name);
          common.push({ name: tag.name, strength: Math.round(u.totalRank / u.count) });
        }
      }
      common.sort((a, b) => b.strength - a.strength);
      entry.commonTags = common.slice(0, 5);

      // Genres communs avec le profil
      const mediaGenres = entry.media.genres || [];
      const matchedGenres = mediaGenres.filter(g => topGenres.has(g));

      // Bonus : +0.5 par tag commun (max 3 → +1.5) + 0.3 par genre commun (max 3 → +0.9)
      const tagBonus   = Math.min(common.length, 3) * TAG_BONUS;
      const genreBonus = Math.min(matchedGenres.length, 3) * GENRE_BONUS;
      entry.tagBonus   = +(tagBonus + genreBonus).toFixed(1);
      entry.score      = +(entry.baseScore + tagBonus + genreBonus).toFixed(1);
    }

    // 7. Tri + diversité de genres
    onProgress(6, 6, "Tri et diversification…");
    filtered.sort((a, b) => b.score - a.score);

    // Re-rank : empêcher qu'un genre monopolise le top
    // On prend les résultats triés et on applique un plafond par "genre principal"
    const diversified = [];
    const genreCount  = new Map();  // combien de fois ce genre est déjà placé
    const deferred    = [];         // animes repoussés car genre saturé

    for (const entry of filtered) {
      const primaryGenre = (entry.media.genres || [])[0] || "Unknown";
      const count = genreCount.get(primaryGenre) || 0;

      if (count < DIVERSITY_CAP) {
        diversified.push(entry);
        genreCount.set(primaryGenre, count + 1);
      } else {
        // Pénalité de rang, pas de suppression
        deferred.push(entry);
      }
    }
    // Les animes déférés sont ajoutés après, dans leur ordre de score
    const finalResults = [...diversified, ...deferred];

    // 8. Debug complet dans la console
    console.group("[Engine] 📊 RAPPORT COMPLET");
    console.log(`Utilisateur: ${username}`);
    console.log(`Favoris (×${WEIGHT_FAVOURITE}):`, favourites.map(f => f.title));
    console.log(`Top notés (×${WEIGHT_TOP_RATED}):`, topOnly.map(e => e.title));
    console.log(`Total sources: ${tasks.length}  |  Résultats: ${finalResults.length}`);
    console.log(`Diversité: ${deferred.length} animes repoussés pour éviter la saturation de genre`);
    console.table(
      finalResults.slice(0, 30).map(e => ({
        Titre: (e.media.title.english || e.media.title.romaji || "").substring(0, 40),
        Score: e.score,
        Base: e.baseScore,
        Bonus: e.tagBonus,
        Genre1: (e.media.genres || [])[0] || "-",
        Sources: e.reasons.length,
        "Détail": e.reasons.map(r => `${r.type === "favori" ? "★" : "▲"} ${r.sourceTitle}`).join(" | "),
        Tags: (e.commonTags || []).map(t => t.name).join(", "),
        PTW: e.isPlanning ? "✓" : "",
      }))
    );
    console.log("Profil tags:", [...userTagMap.entries()]
      .map(([n, v]) => `${n} (${Math.round(v.totalRank / v.count)}%)`)
      .sort()
      .slice(0, 20).join(", ")
    );
    console.log("Profil genres:", [...topGenres].join(", "));
    console.groupEnd();

    return finalResults;
  }

  // ── Mutation : Ajouter à PLANNING ─────────────────────────────────────

  static async addToPlanning(mediaId) {
    if (!AuthManager.isLoggedIn) {
      throw new Error("Connectez-vous pour ajouter un anime.");
    }
    return AuthManager.gqlRequest(QUERIES.SAVE_MEDIA, { mediaId });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  UIRenderer — Gestion du DOM
// ═══════════════════════════════════════════════════════════════════════════

class UIRenderer {

  static els = {};

  static init() {
    this.els = {
      // Auth
      loginBtn:        document.getElementById("login-btn"),
      logoutBtn:       document.getElementById("logout-btn"),
      userAvatar:      document.getElementById("user-avatar"),
      userName:        document.getElementById("user-name"),
      userProfile:     document.getElementById("user-profile"),
      searchSection:   document.getElementById("search-section"),
      // Core
      input:           document.getElementById("username-input"),
      fetchBtn:        document.getElementById("fetch-btn"),
      statusSec:       document.getElementById("status-section"),
      statusText:      document.getElementById("status-text"),
      progressBar:     document.getElementById("progress-bar"),
      errorSec:        document.getElementById("error-section"),
      errorText:       document.getElementById("error-text"),
      filtersSec:      document.getElementById("filters-section"),
      genreFiltersRow: document.getElementById("genre-filters-row"),
      formatFiltersRow:document.getElementById("format-filters-row"),
      grid:            document.getElementById("grid-container"),
      statsBadge:      document.getElementById("stats-badge"),
      // Refresh
      refreshBtn:      document.getElementById("refresh-btn"),
      staleBanner:     document.getElementById("stale-banner"),
      // Backstage
      backstage:       document.getElementById("backstage-panel"),
      backstageClose:  document.getElementById("backstage-close"),
      backstageTitle:  document.getElementById("backstage-title"),
      backstageScore:  document.getElementById("backstage-score"),
      backstageReasons:document.getElementById("backstage-reasons"),
      backstageTags:   document.getElementById("backstage-tags"),
    };
  }

  // ── Auth UI ───────────────────────────────────────────────────────────

  static showLoggedIn(viewer) {
    this.els.loginBtn.style.display      = "none";
    this.els.userProfile.style.display   = "flex";
    this.els.logoutBtn.style.display     = "inline-flex";
    this.els.searchSection.style.display = "none";          // masquer la barre de recherche
    this.els.userAvatar.src = viewer.avatar?.medium || "";
    this.els.userName.textContent = viewer.name;
    this.els.input.value = viewer.name;
  }

  static showLoggedOut() {
    this.els.loginBtn.style.display      = "inline-flex";
    this.els.userProfile.style.display   = "none";
    this.els.logoutBtn.style.display     = "none";
    this.els.searchSection.style.display = "block";         // afficher la barre de recherche
    this.els.userAvatar.src = "";
    this.els.userName.textContent = "";
    this.els.searchSection.querySelector(".hint").textContent =
      "Votre pseudo AniList (ex: Josh)";
  }

  // ── Sections ──────────────────────────────────────────────────────────

  static showStatus(msg, pct = 0) {
    this.els.statusSec.style.display   = "block";
    this.els.errorSec.style.display    = "none";
    this.els.filtersSec.style.display  = "none";
    this.els.grid.style.display        = "none";
    this.els.statusText.textContent    = msg;
    this.els.progressBar.style.width   = `${pct}%`;
  }

  static showError(msg) {
    this.els.statusSec.style.display   = "none";
    this.els.errorSec.style.display    = "block";
    this.els.filtersSec.style.display  = "none";
    this.els.grid.style.display        = "none";
    this.els.errorText.textContent     = msg;
  }

  static showResults() {
    this.els.statusSec.style.display   = "none";
    this.els.errorSec.style.display    = "none";
    this.els.filtersSec.style.display  = "block";
    this.els.grid.style.display        = "grid";
  }

  static onProgress(step, total, message) {
    UIRenderer.showStatus(message, Math.round((step / total) * 100));
  }

  static setStatsBadge(count) {
    this.els.statsBadge.textContent = `${count} résultat${count > 1 ? "s" : ""}`;
    this.els.statsBadge.classList.add("visible");
  }

  // ── Genre Filters ─────────────────────────────────────────────────────

  static renderGenreFilters(genres, onFilter) {
    const row = this.els.genreFiltersRow;
    row.innerHTML = "";
    row.appendChild(this._chip("Tous", "all", true, "genre"));
    for (const g of genres) row.appendChild(this._chip(g, g, false, "genre"));

    row.addEventListener("click", (e) => {
      const chip = e.target.closest(".filter-chip[data-ft='genre']");
      if (!chip) return;
      row.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      onFilter(chip.dataset.value);
    });
  }

  // ── Format Filters ────────────────────────────────────────────────────

  static renderFormatFilters(formats, onFilter) {
    const row = this.els.formatFiltersRow;
    row.innerHTML = "";
    row.appendChild(this._chip("Tous", "all", true, "format"));

    const labels = {
      TV: "📺 TV", MOVIE: "🎬 Film", OVA: "OVA", ONA: "ONA",
      SPECIAL: "Spécial", TV_SHORT: "TV Court", MUSIC: "🎵 Music",
    };
    for (const f of formats) row.appendChild(this._chip(labels[f] || f, f, false, "format"));

    row.addEventListener("click", (e) => {
      const chip = e.target.closest(".filter-chip[data-ft='format']");
      if (!chip) return;
      row.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      onFilter(chip.dataset.value);
    });
  }

  static _chip(label, value, active, ft) {
    const b = document.createElement("button");
    b.className = `filter-chip${active ? " active" : ""}`;
    b.dataset.value = value;
    b.dataset.ft = ft;
    b.textContent = label;
    return b;
  }

  // ── Grid ──────────────────────────────────────────────────────────────

  static renderGrid(recs, onAddPlanning, onBackstage) {
    this.els.grid.innerHTML = "";
    for (const rec of recs) {
      this.els.grid.appendChild(this._card(rec, onAddPlanning, onBackstage));
    }
  }

  static _card({ media, score, baseScore, tagBonus, reasons, commonTags, isPlanning }, onAdd, onInfo) {
    const card = document.createElement("article");
    card.className = "anime-card";
    if (isPlanning) card.classList.add("is-planning");
    card.dataset.genres = (media.genres || []).join(",");
    card.dataset.format = media.format || "";

    const title  = media.title.english || media.title.romaji || "Inconnu";
    const cover  = media.coverImage.extraLarge || media.coverImage.large;
    const fmt    = media.format ? media.format.replace(/_/g, " ") : "";
    const year   = media.seasonYear || "";
    const eps    = media.episodes ? `${media.episodes} ep` : "";
    const mean   = media.meanScore ? `${media.meanScore}%` : "";
    const genres = (media.genres || []).slice(0, 3);
    const url    = media.siteUrl || `https://anilist.co/anime/${media.id}`;

    const topR = reasons?.[0];
    const sourceHint = topR
      ? `${topR.type === "favori" ? "★" : "▲"} ${topR.sourceTitle}`
      : "";

    const tagsHtml = (commonTags || [])
      .map(t => `<span class="common-tag">${t.name}</span>`).join("");

    card.innerHTML = `
      <div class="card-image-wrapper">
        <img src="${cover}" alt="${esc(title)}" loading="lazy" />

        <div class="score-badge" title="Score de pertinence">
          <svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
          ${score}
        </div>

        ${mean ? `<div class="mean-score-badge" title="Note moyenne">${mean}</div>` : ""}

        ${isPlanning ? `<div class="ptw-badge" title="Déjà dans votre Plan to Watch">📋 PTW</div>` : `
        <button class="add-planning-btn" data-mid="${media.id}" title="Ajouter à Planning">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/></svg>
        </button>`}

        <button class="backstage-btn" title="Pourquoi cette reco ?">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z" fill="currentColor"/></svg>
        </button>

        <div class="card-gradient"></div>
        <div class="card-genres">
          ${genres.map(g => `<span class="genre-tag">${g}</span>`).join("")}
        </div>
      </div>

      <div class="card-info">
        <div class="card-title" title="${esc(title)}">${esc(title)}</div>
        ${sourceHint ? `<div class="card-source" title="Recommandé grâce à : ${esc(topR.sourceTitle)}">${sourceHint}</div>` : ""}
        ${tagsHtml ? `<div class="card-common-tags">${tagsHtml}</div>` : ""}
        <div class="card-meta">
          ${fmt ? `<span class="card-format">${fmt}</span>` : ""}
          ${fmt && (year || eps) ? `<span class="dot"></span>` : ""}
          ${year ? `<span>${year}</span>` : ""}
          ${year && eps ? `<span class="dot"></span>` : ""}
          ${eps ? `<span>${eps}</span>` : ""}
        </div>
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".add-planning-btn") || e.target.closest(".backstage-btn")) return;
      window.open(url, "_blank");
    });

    const addBtn = card.querySelector(".add-planning-btn");
    if (addBtn) {
      addBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (onAdd) await onAdd(media.id, e.currentTarget);
      });
    }

    card.querySelector(".backstage-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (onInfo) onInfo({ media, score, baseScore, tagBonus, reasons, commonTags });
    });

    return card;
  }

  // ── Backstage Panel ───────────────────────────────────────────────────

  static showBackstage({ media, score, baseScore, tagBonus, reasons, commonTags }) {
    const title = media.title.english || media.title.romaji || "Inconnu";
    this.els.backstageTitle.textContent = title;
    const bonusText = tagBonus > 0 ? ` (base ${baseScore} + tags +${tagBonus})` : "";
    this.els.backstageScore.textContent = `Score de pertinence : ${score} pts${bonusText}`;

    const ul = this.els.backstageReasons;
    ul.innerHTML = "";
    for (const r of (reasons || [])) {
      const li = document.createElement("li");
      const icon = r.type === "favori" ? "★" : "▲";
      const label = r.type === "favori" ? "Favori" : "Top noté";
      li.innerHTML = `<span class="reason-icon">${icon}</span>
        <span class="reason-text">+${r.weight} — ${label} : <strong>${esc(r.sourceTitle)}</strong></span>`;
      ul.appendChild(li);
    }

    const tc = this.els.backstageTags;
    tc.innerHTML = "";
    if (commonTags?.length) {
      for (const t of commonTags) {
        const s = document.createElement("span");
        s.className = "backstage-tag";
        s.textContent = `${t.name} (${t.strength}%)`;
        tc.appendChild(s);
      }
    } else {
      tc.innerHTML = `<span class="no-tags">Aucun tag commun détecté</span>`;
    }

    this.els.backstage.classList.add("open");
  }

  static hideBackstage() {
    this.els.backstage.classList.remove("open");
  }
}

/** Tiny html-escape helper */
function esc(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}


// ═══════════════════════════════════════════════════════════════════════════
//  App — Contrôleur
// ═══════════════════════════════════════════════════════════════════════════

class App {

  static allRecs      = [];
  static activeGenre  = "all";
  static activeFormat = "all";

  static async init() {
    UIRenderer.init();
    this._bind();

    // Nettoyer les anciens caches (format cache_xxx)
    try {
      const all = await chrome.storage.local.get(null);
      const oldKeys = Object.keys(all).filter(k => k.startsWith("cache_"));
      if (oldKeys.length) await chrome.storage.local.remove(oldKeys);
    } catch {}

    const ok = await AuthManager.init();
    if (ok) {
      UIRenderer.showLoggedIn(AuthManager.viewer);
      // Essayer de restaurer les résultats depuis le cache
      const restored = await this._restoreFromCache();
      if (!restored) {
        // Pas de cache → lancer l'analyse
        this._run();
      }
    } else {
      UIRenderer.showLoggedOut();
      await this._restoreUsername();
    }
  }

  // ── Bind ──────────────────────────────────────────────────────────────

  static _bind() {
    UIRenderer.els.fetchBtn.addEventListener("click", () => this._run());
    UIRenderer.els.input.addEventListener("keydown", e => { if (e.key === "Enter") this._run(); });
    UIRenderer.els.loginBtn.addEventListener("click", () => this._login());
    UIRenderer.els.logoutBtn.addEventListener("click", () => this._logout());
    UIRenderer.els.backstageClose.addEventListener("click", () => UIRenderer.hideBackstage());
    UIRenderer.els.backstage.addEventListener("click", e => {
      if (e.target === UIRenderer.els.backstage) UIRenderer.hideBackstage();
    });

    // Bouton Actualiser → force un recalcul (ignore le cache)
    if (UIRenderer.els.refreshBtn) {
      UIRenderer.els.refreshBtn.addEventListener("click", () => this._run(true));
    }
    // Bandeau stale → relancer
    if (UIRenderer.els.staleBanner) {
      UIRenderer.els.staleBanner.addEventListener("click", () => this._run(true));
    }

    // Debug link → ouvre debug.html dans un nouvel onglet
    const debugLink = document.getElementById("debug-link");
    if (debugLink) {
      debugLink.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
      });
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────

  static async _login() {
    try {
      await AuthManager.login();
      // Viewer already fetched & persisted in login()
      // But ensure we have it
      if (!AuthManager.viewer) await AuthManager._fetchViewer();
      UIRenderer.showLoggedIn(AuthManager.viewer);
      this._run(true); // force fresh analysis on first login
    } catch (err) {
      console.error("[App] Login:", err);
      UIRenderer.showError(`Connexion échouée : ${err.message}`);
    }
  }

  static async _logout() {
    await AuthManager.logout();
    this.allRecs = [];
    UIRenderer.showLoggedOut();
    UIRenderer.els.input.value = "";
    UIRenderer.els.filtersSec.style.display = "none";
    UIRenderer.els.grid.style.display = "none";
    UIRenderer.els.statsBadge.classList.remove("visible");
    if (UIRenderer.els.refreshBtn) UIRenderer.els.refreshBtn.style.display = "none";
    if (UIRenderer.els.staleBanner) UIRenderer.els.staleBanner.style.display = "none";
  }

  static async _restoreUsername() {
    try {
      const { anilistUsername } = await chrome.storage.local.get("anilistUsername");
      if (anilistUsername) UIRenderer.els.input.value = anilistUsername;
    } catch {}
  }

  // ── Run ───────────────────────────────────────────────────────────────

  /**
   * @param {boolean} forceRefresh — Si true, ignore le cache et relance l'analyse.
   */
  static async _run(forceRefresh = false) {
    const username = UIRenderer.els.input.value.trim();
    if (!username) { UIRenderer.showError("Entrez un pseudo ou connectez-vous."); return; }

    chrome.storage.local.set({ anilistUsername: username });

    // Vérifier le cache sauf si refresh forcé
    if (!forceRefresh) {
      const cached = await this._loadCache(username);
      if (cached) {
        this._show(cached.results);
        this._showCacheAge(cached.timestamp);
        return;
      }
    }

    // Masquer le bandeau stale pendant le chargement
    if (UIRenderer.els.staleBanner) UIRenderer.els.staleBanner.style.display = "none";

    try {
      UIRenderer.showStatus("Initialisation…", 0);
      const results = await RecommendationEngine.computeRecommendations(
        username, (s, t, m) => UIRenderer.onProgress(s, t, m)
      );
      if (!results.length) {
        UIRenderer.showError("Aucune recommandation. Ajoutez des favoris ou notez plus d'animes !");
        return;
      }
      await this._saveCache(username, results);
      this._show(results);
      this._showCacheAge(Date.now());
    } catch (err) {
      console.error("[App] Pipeline:", err);
      if (err.message === "TOKEN_EXPIRED") {
        UIRenderer.showLoggedOut();
        UIRenderer.showError("Session expirée — reconnectez-vous.");
        return;
      }
      UIRenderer.showError(err.message.includes("introuvable") ? err.message : `Erreur : ${err.message}`);
    }
  }

  // ── Display ───────────────────────────────────────────────────────────

  static _show(results) {
    this.allRecs = results;
    this.activeGenre = "all";
    this.activeFormat = "all";

    const genres  = new Set();
    const formats = new Set();
    for (const { media } of results) {
      (media.genres || []).forEach(g => genres.add(g));
      if (media.format) formats.add(media.format);
    }

    UIRenderer.setStatsBadge(results.length);
    UIRenderer.renderGenreFilters([...genres].sort(), g => { this.activeGenre = g; this._filter(); });
    UIRenderer.renderFormatFilters([...formats].sort(), f => { this.activeFormat = f; this._filter(); });
    this._renderCurrent(results);
    UIRenderer.showResults();

    // Afficher le bouton Actualiser
    if (UIRenderer.els.refreshBtn) UIRenderer.els.refreshBtn.style.display = "inline-flex";
  }

  /** Affiche l'âge du cache ou un bandeau "périmé" */
  static _showCacheAge(timestamp) {
    const age = Date.now() - timestamp;
    const isStale = age > CACHE_TTL_MS;

    if (isStale && UIRenderer.els.staleBanner) {
      const hours = Math.round(age / (1000 * 60 * 60));
      UIRenderer.els.staleBanner.textContent = `⚠️ Données datant de ${hours}h — Cliquer ici pour actualiser`;
      UIRenderer.els.staleBanner.style.display = "block";
    } else if (UIRenderer.els.staleBanner) {
      UIRenderer.els.staleBanner.style.display = "none";
    }
  }

  static _filter() {
    let f = this.allRecs;
    if (this.activeGenre  !== "all") f = f.filter(r => (r.media.genres || []).includes(this.activeGenre));
    if (this.activeFormat !== "all") f = f.filter(r => r.media.format === this.activeFormat);
    this._renderCurrent(f);
  }

  static _renderCurrent(recs) {
    UIRenderer.renderGrid(recs,
      (id, btn) => this._addPlanning(id, btn),
      (rec) => UIRenderer.showBackstage(rec)
    );
  }

  // ── Add to Planning ───────────────────────────────────────────────────

  static async _addPlanning(mediaId, btn) {
    if (!AuthManager.isLoggedIn) {
      UIRenderer.showError("Connectez-vous pour ajouter à votre liste.");
      return;
    }
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      await RecommendationEngine.addToPlanning(mediaId);
      btn.classList.remove("loading");
      btn.classList.add("success");
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>`;
    } catch (err) {
      console.error("[App] addPlanning:", err);
      btn.classList.remove("loading");
      btn.classList.add("error");
      setTimeout(() => { btn.classList.remove("error"); btn.disabled = false; }, 2000);
    }
  }

  // ── Cache (persistance) ───────────────────────────────────────────────

  /** Sauvegarde les résultats + timestamp dans chrome.storage.local */
  static async _saveCache(username, results) {
    try {
      const payload = {
        username: username.toLowerCase(),
        results,
        timestamp: Date.now(),
      };
      await chrome.storage.local.set({ recoCache: payload });
      console.log(`[Cache] Sauvegardé ${results.length} résultats pour ${username}`);
    } catch (e) { console.warn("[Cache] Écriture échouée:", e); }
  }

  /**
   * Charge le cache si l'utilisateur correspond.
   * Retourne { results, timestamp } ou null.
   * Ne vérifie PAS l'expiration — c'est _run() ou _restoreFromCache() qui décide.
   */
  static async _loadCache(username) {
    try {
      const { recoCache } = await chrome.storage.local.get("recoCache");
      if (recoCache && recoCache.username === username.toLowerCase() && recoCache.results?.length) {
        console.log(`[Cache] Trouvé: ${recoCache.results.length} résultats (âge: ${Math.round((Date.now() - recoCache.timestamp) / 60000)}min)`);
        return recoCache;
      }
    } catch {}
    return null;
  }

  /**
   * Restaure les résultats depuis le cache au démarrage.
   * Affiche immédiatement sans appel API.
   * Propose d'actualiser si les données sont périmées (>24h).
   */
  static async _restoreFromCache() {
    const username = UIRenderer.els.input.value.trim();
    if (!username) return false;

    const cached = await this._loadCache(username);
    if (!cached) return false;

    console.log(`[Cache] Restauration instantanée de ${cached.results.length} résultats`);
    this._show(cached.results);
    this._showCacheAge(cached.timestamp);
    return true;
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => App.init());
