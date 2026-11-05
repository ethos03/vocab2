# Roue des mots

**Roue des mots** est un outil de révision du vocabulaire anglais-français, organisé par chapitres. Il propose plusieurs façons de s’entraîner et de suivre ses progrès.

## Fonctionnalités

- Parcourir les chapitres et leurs mots, avec une roue pour tirer un mot au hasard et s’exercer dans les deux sens (anglais → français ou français → anglais).
- Rechercher un mot, mélanger l’ordre de la liste et filtrer les mots : tous, favoris, ratés, jamais vus ou maîtrisés.
- Ajouter des mots aux favoris et écouter leur prononciation grâce à la synthèse vocale du navigateur.
- Faire un quiz en QCM ou en saisie, choisir le chapitre, le sens, le nombre de questions et la difficulté (Facile, Moyen ou Difficile), puis consulter son score et ses réponses.
- Réviser avec des flashcards, pour tous les mots, les favoris ou les mots ratés.
- Consulter les statistiques, la progression par chapitre et l’historique des résultats.
- Changer de thème (clair/sombre). Des outils d’administration permettent, après connexion, de gérer chapitres et mots, publier des évaluations, vérifier l’orthographe et signaler une erreur.

## Comment l’utiliser

1. Ouvrez un chapitre, ou choisissez **Tous les chapitres**.
2. Parcourez et recherchez les mots, ou utilisez les filtres et les favoris.
3. Pour vous entraîner, ouvrez **Quiz** ou **Flashcards**, choisissez les options proposées et démarrez.
4. Consultez **Stats** pour voir vos résultats et votre progression. L’onglet **Éval** affiche les évaluations publiées.

## Mise en ligne avec GitHub et Render

1. Ajoutez les fichiers du site à un dépôt GitHub et envoyez-les avec un commit (`git add`, `git commit`, puis `git push`).
2. Dans Render, créez un **Static Site** et reliez-le au dépôt GitHub.
3. Indiquez le dossier du projet comme **Publish Directory** (souvent `.` pour la racine) et laissez la commande de build vide si le projet ne nécessite pas de compilation.
4. Lancez le déploiement. Après chaque modification, faites un nouveau commit et poussez-le sur GitHub : Render redéploie le site selon la configuration du dépôt. Un déploiement peut aussi être lancé depuis Render.

**À noter :** l’interface appelle des routes `/api` pour charger les mots et chapitres, ainsi que pour les fonctions d’administration et les évaluations. Un hébergement Render en site statique sert les fichiers, mais ne fournit pas ces routes API. Pour que ces fonctions marchent en ligne, il faut aussi héberger et relier un serveur/API compatible, ou configurer un service backend qui répond sur ces routes.

## Structure du projet

- `index.html` — interface et logique de révision côté navigateur.
- `sw.js`, `manifest.webmanifest` et les icônes — fichiers de service worker et d’installation PWA, s’ils sont conservés dans le dépôt.

## Données locales

Les favoris, les statistiques de réponses, le thème choisi, la difficulté du quiz, les mots récemment posés en quiz et jusqu’à 30 résultats récents sont enregistrés dans le `localStorage` du navigateur. Ces données restent propres à ce navigateur et à cet appareil ; elles ne sont pas partagées entre utilisateurs. Le jeton d’administration est conservé temporairement dans `sessionStorage`, et non dans `localStorage`.
