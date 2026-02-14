# 🎯 AniList Smart Recommendations

> Extension Chrome qui recommande des animes basée sur vos favoris et votre liste AniList, avec un algorithme de pertinence intelligent.

<p align="center">
  <img src="icons/icon128.png" alt="Logo" width="128" />
</p>

## ✨ Fonctionnalités

- 🔐 **Connexion OAuth2** — Connectez-vous à AniList en un clic
- ⭐ **Algorithme de pertinence** — Score basé sur vos favoris (×2), top notés (×1), tags communs (+0.5) et genres (+0.3)
- 🎭 **Diversité des genres** — Plafond de 5 animes du même genre pour éviter la monotonie
- 📋 **Badge PTW** — Identifie les animes déjà dans votre Plan to Watch
- ➕ **Ajout direct** — Ajoutez un anime à votre Planning en un clic
- 🔍 **Filtres** — Filtrez par genre et format (TV, Film, OVA…)
- 💡 **Backstage** — Découvrez pourquoi chaque anime est recommandé
- ⚡ **Requêtes compound** — Rapide grâce aux requêtes GraphQL groupées (~3-5s)
- 🗄️ **Cache 24h** — Résultats sauvegardés, affichage instantané à la réouverture
- 🔧 **Debug Inspector** — Page dédiée pour explorer vos données via GraphQL

## 📸 Aperçu

L'extension s'ouvre en popup avec une interface Netflix-like sombre :
- Grille de cartes avec couvertures, scores, genres
- Panel latéral "Backstage" expliquant le scoring
- Filtres par genre et format

## 🚀 Installation

### 1. Cloner le repo

```bash
git clone https://github.com/VOTRE_USERNAME/anilist-smart-recommendations.git
cd anilist-smart-recommendations
```

### 2. Créer votre app AniList

1. Allez sur [AniList Developer Settings](https://anilist.co/settings/developer)
2. Cliquez **"Create New Client"**
3. Remplissez :
   - **Name** : ce que vous voulez (ex: "Mon Reco Extension")
   - **Redirect URL** : `https://VOTRE_EXTENSION_ID.chromiumapp.org/`
   
   > 💡 Vous trouverez votre Extension ID à l'étape suivante

### 3. Charger l'extension dans Chrome

1. Ouvrez `chrome://extensions/`
2. Activez le **Mode développeur** (toggle en haut à droite)
3. Cliquez **"Charger l'extension non empaquetée"**
4. Sélectionnez le dossier du projet
5. **Copiez l'ID** de l'extension (affiché sous le nom)

### 4. Configurer le Client ID

1. Ouvrez `config.js` dans le dossier de l'extension
2. Remplacez `YOUR_CLIENT_ID` par le Client ID de votre app AniList :

```javascript
const CONFIG = {
  ANILIST_CLIENT_ID: "12345",  // ← Votre Client ID ici
};
```

3. Retournez sur [AniList Developer Settings](https://anilist.co/settings/developer)
4. Mettez à jour le **Redirect URL** avec votre Extension ID :
   ```
   https://abcdefghijklmnop.chromiumapp.org/
   ```
5. Rechargez l'extension dans `chrome://extensions/`

### 5. Utiliser

1. Cliquez sur l'icône de l'extension dans la barre Chrome
2. Cliquez **"Connexion"** pour vous connecter via AniList
3. Les recommandations se chargent automatiquement ! 🎉

## 🧮 Algorithme de scoring

Chaque anime recommandé reçoit un **Score de Pertinence** :

| Source | Poids |
|--------|-------|
| Recommandé par un **favori** | × 2 pts |
| Recommandé par un **top noté** | × 1 pt |
| **Tag commun** avec votre profil | + 0.5/tag (max 3 = +1.5) |
| **Genre commun** avec votre top 10 | + 0.3/genre (max 3 = +0.9) |

**Diversité** : Maximum 5 animes du même genre principal dans le top pour éviter la saturation.

### Pipeline

```
Favoris (max 15) + Top notés (max 10)
         ↓
  Requêtes GraphQL compound (12 sources/requête)
         ↓
  Filtrage (exclure les vus, garder PTW)
         ↓
  Bonus tags + genres communs
         ↓
  Tri + diversification par genre
         ↓
  Affichage avec cache 24h
```

## 📁 Structure du projet

```
├── manifest.json      # Configuration Manifest V3
├── config.js          # ⚠️ Votre Client ID AniList (à configurer)
├── popup.html         # Structure HTML de la popup
├── popup.js           # Logique principale (4 classes)
├── style.css          # Thème Netflix dark
├── debug.html         # Page d'inspection debug
├── debug.js           # Logique du debug inspector
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── .gitignore
└── README.md
```

## 🏗️ Architecture (popup.js)

| Classe | Rôle |
|--------|------|
| `AuthManager` | OAuth2 implicit grant, token, viewer, retry 429 |
| `RecommendationEngine` | Favoris, liste, compound queries, scoring |
| `UIRenderer` | DOM, cartes, filtres, backstage panel |
| `App` | Orchestration, cache, persistance |

## 🔒 Sécurité

- **Aucun serveur backend** — Tout est côté client, directement avec l'API AniList
- **Token OAuth2** stocké dans `chrome.storage.local` (sandboxé par Chrome)
- **Aucune donnée** envoyée à des tiers
- **CSP strict** : `script-src 'self'` — aucun script inline ou externe
- Le **Client ID AniList** est un identifiant public (pas un secret), mais chaque utilisateur doit utiliser le sien car le redirect URI est lié à l'Extension ID

## 🛠️ Debug

- Cliquez 🔍 dans le header de la popup pour ouvrir le **Debug Inspector**
- Inspectez vos favoris, tags, genres, et les requêtes GraphQL envoyées
- Liens directs vers l'explorateur GraphQL d'AniList

## 📝 Licence

MIT — Libre d'utilisation, modification et distribution.

## 🙏 Crédits

- [AniList API](https://anilist.gitbook.io/anilist-apiv2-docs/) — Source de données
- Interface inspirée du design Netflix
