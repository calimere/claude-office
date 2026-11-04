# Claude Office

Un bureau 3D (three.js) où tu vois tes sessions Claude Code et leurs sous-agents travailler en temps réel.

## Comment ça marche

```
claude (CLI) ──hooks──▶ curl POST /event ──▶ server.js ──SSE /stream──▶ index.html (three.js)
```

- Chaque **session** Claude Code = un **îlot** de 4 bureaux, cloisonné (bois + verre
  dépoli), posé sur un tapis de couleur. Une **descente de lit** devant l'ouverture porte
  le nom du projet (dernier segment du `cwd` reçu dans les hooks). Deux sessions sur le
  même projet sont numérotées (`mon-projet #2`). Chaque îlot s'ouvre sur l'allée centrale ;
  tous les déplacements passent par le couloir de gauche puis cette allée.
- Le « Lead » (perso orange) **tient le poste** : il est assis dès le début de la session
  et ne franchit jamais la porte. L'îlot reste en place même quand il ne fait rien.
- Chaque appel à l'outil **Task/Agent** affecte un employé à l'îlot : il s'installe à un
  bureau, bosse, puis retourne à l'open space. Voir *La maison et ses employés* plus bas.
- À la fin de la session, l'îlot est démonté une fois ses occupants partis, et son
  emplacement est rendu disponible.
- Le **coin café** (bar + mange-debout) occupe la bande libre à l'avant droit, devant
  les îlots. On y accède par l'allée centrale puis une voie dédiée (`CAFE_LANE_X`)
  qui passe entre le comptoir et les places debout.
- Le **salon** occupe le centre de la bande avant, dans l'axe de la pièce : tapis, canapé,
  table basse, téléviseur et console. L'écran regarde le fond, donc il tourne le dos à la
  caméra — ce qu'on voit, c'est sa lueur sur les joueurs, et elle ne s'allume que si
  quelqu'un joue. Un téléviseur et un canapé se faisant face, l'un des deux est forcément
  de dos en vue isométrique : ce sont les gens qu'on garde.
- Les **places debout** où l'on discute occupent la bande avant gauche, libérée par le salon.
- Le mur de gauche porte un **tableau blanc** (le schéma de l'appli, des post-it, un
  burndown) et le **modèle de données** punaisé à côté. La **baie serveurs** occupe l'angle
  du fond à droite : trois armoires, dont celle du milieu allume une LED par commande shell
  encore en cours (`background_tasks` des hooks).
- Un **chat** vit dans la pièce. Il dort sur le dossier du canapé, s'étire, descend,
  traverse, se réinstalle ailleurs — accoudoir, table basse, tapis devant la télé,
  parquet près des places debout — et recommence toutes les une à trois minutes. Il ne
  dit rien sur tes sessions : c'est la seule chose de la pièce dont l'activité ne dépend
  pas de toi, et c'est exactement à ça qu'elle sert.
- De la **vapeur** monte des tasses du comptoir, et de celles que tiennent les agents en
  pause — une place du bar occupée devient une source.
- De la **poussière** dérive dans l'air. Elle ne signifie rien ; elle donne de l'air à
  la pièce.
- Les **suspensions oscillent** autour de leur attache et les **feuillages ploient**,
  chacun à son rythme et deux fois plus lentement — rien ne doit battre la mesure.

- Le panneau **Sessions** (en haut à droite) liste les projets actifs et, en pied,
  l'effectif de la maison. La caméra se recentre selon le nombre d'îlots.
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

## La maison et ses employés

Claude Office est l'employeur, pas une agence d'intérim. **Un agent appelé une fois entre
à l'effectif et n'en sort plus.**

- Au premier appel d'un métier (`subagent_type`), l'employé est **embauché** : il entre par
  la porte et rejoint l'îlot qui l'appelle.
- Mission finie, il **rend son bureau et quitte l'îlot, pas la maison**. Il va s'occuper
  ailleurs et change d'occupation toutes les minute ou deux : ☕ au mange-debout,
  🎮 sur le canapé devant la console, 🧍 debout à discuter devant le salon.
- Rappelé — par **n'importe quelle session**, pas seulement celle qui l'avait embauché —
  il traverse l'open space et s'installe au bureau qui l'attend.
- On n'embauche un second employé d'un métier que si **tous ceux de ce métier sont déjà sur
  un dossier**. L'effectif reste donc de la taille de ton usage réel.
- Les **leads ne font pas partie de l'effectif** : ils *sont* la session, et disparaissent
  avec elle. Eux seuls ont jamais quitté la pièce — et depuis que la maison garde ses gens,
  plus personne ne franchit la porte dans ce sens. Elle ne sert plus qu'aux arrivées.

L'effectif est **gardé par le serveur** et réécrit dans `.state.json`, puis rejoué en tête
du flux à chaque connexion : recharger la page ou redémarrer le serveur ne vide pas l'open
space. Les employés qui ne sont sur aucun dossier sont reposés directement à une place de
repos — ils étaient déjà là, les faire entrer par la porte serait un mensonge.

### Envoyer le lead en pause

Tape **`café`** (ou `coffee`, `pause café`, `va boire un café`, `take a break`…) comme
prompt dans une session : le lead quitte son poste pour le mange-debout. Il garde son
bureau et y revient dès qu'il y a du travail — un `PreToolUse` ou un vrai prompt suffit.

Le prompt doit se réduire **exactement** à l'une de ces phrases : une demande qui *parle* de
café (« ajoute un bouton café ») ne l'envoie pas au bar. Claude reçoit quand même le prompt
et y répondra — la commande ne pilote que la vue.

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

- Clic sur un **agent** → rôle, affectation, état, mission, `agent_id`, outil en cours.
- Clic sur le **tapis d'un îlot** → session, durée, sous-agents sur le dossier, effectif de
  la maison, outils appelés, dernier outil, le plus long, tâches de fond, effort, mode de
  permissions. La caméra se cadre en même temps sur l'îlot ; `⤢ Tout voir` dézoome.
- Clic sur une ligne du panneau **Sessions** → même chose.
- `Échap` ferme le panneau de détail.
- Sur `Stop` et `SubagentStop`, le dernier message de l'agent s'affiche en bulle.

## Installation

1. `node server.js` (Node 18+, aucune dépendance) → ouvre http://localhost:4317
2. Copie le bloc `hooks` de `hooks.json` dans `~/.claude/settings.json` (global) ou
   `.claude/settings.json` (projet). Fusionne avec tes hooks existants si tu en as.
   **Le même fichier vaut pour macOS, Linux et Windows**, et il n'y a aucun chemin à
   adapter : tu copies, tu colles, où que soit le dossier.
3. Lance `claude` normalement. Le bureau s'anime.

### Pourquoi la commande est écrite comme ça

```
curl -s -m 1 -X POST http://127.0.0.1:4317/event -H Content-Type:application/json --data-binary @- || exit 0
```

Chaque morceau sert à la rendre portable, parce qu'on ne sait pas quel shell va
l'exécuter — Claude Code passe les hooks par `sh` sur certaines installations Windows,
par `cmd.exe` sur d'autres :

- **`-H Content-Type:application/json`, sans espace.** Un en-tête HTTP n'exige pas
  d'espace après le deux-points. Sans espace, plus besoin de quotes — et donc plus de
  différence de *quoting* entre `sh` et `cmd.exe`. La commande ne contient pas un seul
  guillemet.
- **`|| exit 0`.** `exit 0` existe dans les deux shells. `|| true` ne marche pas sous
  `cmd.exe` (`true` n'y est pas une commande) et `|| ver >nul` ne marche pas sous `sh`.
- **Aucune redirection.** `-s` rend `curl` muet, et le serveur répond `204` sans corps :
  rien n'arrive sur la sortie standard, il n'y a donc rien à rediriger. C'est ce qui
  permet d'éviter `>/dev/null`, que `cmd.exe` ne comprend pas, **et** `>nul`, qui sous
  `sh` ne redirige rien du tout : il crée un fichier nommé `nul` dans ton projet.

Résultat, dans les quatre cas (`sh` ou `cmd.exe`, serveur allumé ou coupé) : sortie `0`,
aucun affichage, aucun fichier parasite. Avec le timeout d'1 s, Claude Code n'est jamais
ni bloqué ni ralenti par un serveur éteint.

Le serveur retient les sessions ouvertes — identité (id + projet) **et sous-agents encore
en vol** — ainsi que l'effectif, puis les rejoue à chaque nouvelle page. Recharger affiche
aussitôt les îlots, les agents déjà au travail et l'open space peuplé, même si personne ne
bouge à cet instant. Cet état est écrit dans `.state.json` : **redémarrer le serveur ne perd
ni les agents déjà lancés, ni les employés**. Ce qui n'est pas rejoué : l'outil en cours
d'exécution, qui reprend au premier événement suivant. `GET /sessions` montre ce que le
serveur croit savoir.

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
- L'open space offre **13 places de repos** (4 au bar, 3 sur le canapé, 6 debout). Un
  quatorzième employé désœuvré reste planté là où il se trouve. Comme on n'embauche que
  faute de disponible, il faut 14 métiers simultanément occupés pour y arriver.
- La mémoire de l'effectif est **par serveur, pas par projet** : un employé embauché depuis
  un dépôt peut être rappelé depuis un autre. C'est voulu — c'est la même maison.

## Pistes

- Piloter Claude depuis l'UI via l'Agent SDK (le serveur lance les sessions et lit le stream JSON → attribution exacte des sous-agents).
- Modèles glTF / sprites low-poly à la place des cubes, sons de clavier.
- Statistiques façon tycoon : tokens, fichiers modifiés, tests verts, « moral » des agents.
- Ancienneté visible : un employé embauché il y a longtemps mérite mieux qu'un bureau au fond.
