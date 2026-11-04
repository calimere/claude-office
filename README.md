# Claude Office

Un bureau 3D (three.js) où tu vois tes sessions Claude Code et leurs sous-agents travailler en temps réel.

## Comment ça marche

```
claude (CLI) ──hooks──▶ curl POST /event ──▶ server.js ──SSE /stream──▶ index.html (three.js)
```

- Chaque **session** Claude Code = un **îlot** de 4 bureaux, cloisonné (bois + verre
  dépoli), posé sur un tapis de couleur et surmonté d'un panneau au nom du projet
  (dernier segment du `cwd` reçu dans les hooks). Deux sessions sur le même projet sont
  numérotées (`mon-projet #2`). Chaque îlot s'ouvre sur l'allée centrale ; tous les
  déplacements passent par le couloir de gauche puis cette allée.
- Le « Lead » (perso orange) **tient le poste** : il est assis dès le début de la session
  et ne franchit jamais la porte. L'îlot reste en place même quand il ne fait rien.
- Chaque appel à l'outil **Task/Agent** = un sous-agent qui entre par la porte, s'installe
  **dans l'îlot de son lead**, bosse, puis repart. Seuls les sous-agents circulent.
- À la fin de la session, l'îlot est démonté une fois le dernier sous-agent sorti, et son
  emplacement est rendu disponible.
- Le **coin café** (bar + mange-debout) occupe la bande libre à l'avant droit, devant
  les îlots. On y accède par l'allée centrale puis une voie dédiée (`CAFE_LANE_X`)
  qui passe entre le comptoir et les places debout.
- Un sous-agent qui a fini ne disparaît pas : il va au **mange-debout** boire un café.
  Si la session relance un agent du **même type**, il est rappelé à un bureau de l'îlot ;
  sinon il s'en va au bout de **5 minutes** (`?coffee=30` pour raccourcir le délai).
- Le panneau **Sessions** (en haut à droite) liste les projets actifs, leurs sous-agents
  au travail (🤖) et en pause (☕). La caméra se recentre selon le nombre d'îlots.
- Les bureaux ont **deux écrans**, allumés de la même couleur que l'outil en cours.
- Chaque agent a une **allure propre** — teint, coupe, haut, pantalon, taille, lunettes —
  dérivée de son nom de façon déterministe. Les leads gardent la famille orange.
- Le mur du fond porte une enseigne, **CLAUDE OFFICE** par défaut. `?sign=ACME&subsign=LABS`
  la change ; `?subsign=` seul ne garde que la ligne principale. Elle est dessinée en texte
  (et se redimensionne pour tenir) ; posez un `logo.png` à côté d'`index.html` pour la
  remplacer par votre visuel.
- L'animation et la couleur de l'écran suivent l'outil en cours :
  - vert = Edit/Write (tape au clavier) · ambre = Bash · bleu = Read/Grep/Glob
  - violet = WebSearch/WebFetch/MCP · rose = TodoWrite · rouge clignotant = attend ta permission (main levée)

## Quand une session t'appelle

C'est ce qui rend le bureau utile en second écran : on doit pouvoir capter qu'une session
attend sans lire les étiquettes, et même sans regarder l'onglet.

- Trois niveaux d'appel, chacun allumant une balise sur l'îlot : ✋ **attend ton input**
  (ambre), ✋ **attend ta validation** (rouge), ✅ **a fini son tour** (vert). Toute
  activité — nouveau prompt, nouvel outil — éteint l'appel.
- Le **titre de l'onglet** devient `(n) Claude Office` et la **favicon**, dessinée au
  canvas, porte une pastille de comptage. Lisible depuis la barre des tâches.
- Un **bip** optionnel, coupé par défaut : la pill `🔕 Son` l'active — ce clic vaut aussi
  le geste utilisateur que les navigateurs exigent pour autoriser l'audio.

## Inspecter

- Clic sur un **agent** → rôle, état, mission, `agent_id`, outil en cours et depuis quand.
- Clic sur le **tapis d'un îlot** → session, durée, sous-agents au travail et au café,
  nombre d'outils appelés, dernier outil, le plus long, tâches de fond, effort, mode de
  permissions. La caméra se cadre en même temps sur l'îlot ; `⤢ Tout voir` dézoome.
- Clic sur une ligne du panneau **Sessions** → même chose.
- `Échap` ferme le panneau de détail.
- Sur `Stop` et `SubagentStop`, le dernier message de l'agent s'affiche en bulle.

## Installation

1. `node server.js` (Node 18+, aucune dépendance) → ouvre http://localhost:4317
2. Copie le bloc `hooks` dans `~/.claude/settings.json` (global) ou `.claude/settings.json` (projet). Fusionne avec tes hooks existants si tu en as.
   - **macOS / Linux** : `hooks.json`.
   - **Windows** : `hooks.windows.json`, qui appelle le wrapper `claude-office-hook.cmd`
     (la syntaxe bash de `hooks.json` — `/dev/null`, `|| true`, quotes simples — ne passe
     pas sous `cmd.exe`). Adapte le chemin absolu si tu déplaces le dossier.
3. Lance `claude` normalement. Le bureau s'anime.

Les hooks ont un timeout d'1 s et `|| true` : si le serveur est coupé, Claude Code n'est ni bloqué ni ralenti.

Le serveur retient les sessions ouvertes — identité (id + projet) **et sous-agents encore
en vol** — puis les rejoue à chaque nouvelle page. Recharger affiche aussitôt les îlots et
les agents déjà au travail, même si personne ne bouge à cet instant. Cet état est écrit
dans `.state.json` : **redémarrer le serveur ne perd plus les agents déjà lancés**.
Ce qui n'est pas rejoué : l'outil en cours d'exécution, qui reprend au premier événement
suivant. `GET /sessions` montre ce que le serveur croit savoir.

Un agent lancé pendant que le serveur était arrêté reste invisible : le seul canal
d'information, ce sont les hooks. Il apparaîtra au prochain agent que la session lancera.

Ouvrir `index.html` directement (ou `?demo`) lance un scénario de démo sans serveur.
Depuis une autre machine : `HOST=0.0.0.0 node server.js` puis `index.html?server=http://ip:4317`.

## Limites connues

- **Les agents sont asynchrones.** Le `PostToolUse` de l'outil `Agent` arrive au
  *lancement* (`tool_response: {isAsync: true, status: "async_launched", agentId}`,
  `duration_ms` ≈ 40), pas à la fin. Un agent qui travaille une heure produit son
  `PostToolUse` dans les 50 ms. Le cycle de vie suivi est donc :
  `PreToolUse` → en poste, `SubagentStop` (qui porte `agent_id` et `agent_type`) → fin.
  Traiter le `PostToolUse` comme une fin rendait tous les agents invisibles.
- Le **cycle de vie** est exact (grâce à `agent_id`), mais pas l'**attribution des appels
  d'outils** : les `PreToolUse` d'un `Bash` ou d'un `Read` ne portent pas d'`agent_id`.
  Ils restent attribués au dernier sous-agent lancé — approximatif en parallèle.
- 6 îlots sont visibles simultanément. Au-delà, les sessions supplémentaires se superposent
  sur les emplacements existants (le comptage reste juste, mais l'affichage se chevauche).
- Un îlot compte 4 bureaux. Au-delà de 4 agents, les suivants se partagent le dernier bureau.

## Pistes

- Piloter Claude depuis l'UI via l'Agent SDK (le serveur lance les sessions et lit le stream JSON → attribution exacte des sous-agents).
- Modèles glTF / sprites low-poly à la place des cubes, bulles de dialogue, sons de clavier.
- Statistiques façon tycoon : tokens, fichiers modifiés, tests verts, « moral » des agents.
