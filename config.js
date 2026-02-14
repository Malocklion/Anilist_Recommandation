/* ═══════════════════════════════════════════════════════════════════════════
   CONFIGURATION — AniList Smart Recommendations
   ═══════════════════════════════════════════════════════════════════════════
   
   👉 ÉTAPE 1 : Allez sur https://anilist.co/settings/developer
   👉 ÉTAPE 2 : Cliquez "Create New Client"
   👉 ÉTAPE 3 : Remplissez :
        - Name      : ce que vous voulez (ex: "Mon Reco Extension")
        - Redirect URL : https://VOTRE_EXTENSION_ID.chromiumapp.org/
          
          💡 Pour trouver votre EXTENSION_ID :
             Chargez l'extension dans chrome://extensions (mode développeur)
             L'ID apparaît sous le nom de l'extension (ex: "abcdefgh...")
             Donc le redirect URL sera :
             https://abcdefgh.chromiumapp.org/

   👉 ÉTAPE 4 : Copiez le "Client ID" et collez-le ci-dessous

   ═══════════════════════════════════════════════════════════════════════════ */

const CONFIG = {
  ANILIST_CLIENT_ID: "YOUR_CLIENT_ID",
};
