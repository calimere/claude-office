# Claude Office

Un bureau 3D (three.js) où tu vois tes sessions Claude Code et leurs sous-agents travailler en temps réel.

## Comment ça marche

```
claude (CLI) ──hooks──▶ curl POST /event ──▶ server.js ──SSE /stream──▶ index.html (three.js)
```

En **mode flotte**, plusieurs postes publient dans le même bureau — chacun via un agent
local qui n'émet que des statuts, jamais de contenu. Voir [La flotte](#la-flotte).

- Chaque **session** Claude Code = un **îlot** de 4 bureaux, cloisonné (bois + verre
  dépoli), posé sur un tapis de couleur. Une **descente de lit** devant l'ouverture porte
  le nom du projet (dernier segment du `cwd` reçu dans les hooks) et, en dessous, le
  **poste** d'où vient la session. Deux sessions sur le même projet sont numérotées
  (`mon-projet #2`).
- Le plateau compte **20 emplacements**, 5 colonnes × 4 rangées. Les rangées vont par
  **paires** : chaque paire encadre une allée et s'ouvre dessus ; entre deux paires, les
  îlots se tournent le dos. Quatre rangées, deux allées. Le **couloir de gauche** les
  relie toutes — c'est le seul passage de l'une à l'autre, et tout déplacement l'emprunte.
- Les emplacements se remplissent **du milieu de la première rangée vers l'extérieur**.
  Trois sessions occupent trois îlots voisins, pas les trois coins du plateau : la caméra
  cadre ce qui est occupé, et des îlots dispersés la forceraient à tout dézoomer pour ne
  montrer que du parquet.
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
- Et un **visage** : yeux, sourcils, bouche. L'expression suit l'activité — concentré en
  tapant, sourcils hauts et bouche tombante quand il attend ta validation, souriant au
  café ou devant la console. Chacun **cligne des yeux** à son propre rythme, entre 7 et
  17 fois par minute : synchronisés, ils feraient l'effet inverse.
- Chaque bulle porte une **pastille d'état**, en haut à gauche : 💼 au travail, ❓ attend
  ta réponse (elle clignote), ☕ au repos. Le ❓ n'est porté que par le lead : ses
  sous-agents, eux, continuent de travailler pendant qu'il t'attend.
- **Plus la caméra recule, moins les bulles en disent.** D'abord le libellé d'activité
  disparaît, puis tout sauf la pastille. À pleine charge, quarante bulles recouvriraient
  le plateau et on ne verrait plus la pièce ; « il travaille / il t'attend / il se
  repose » est de toute façon le seul niveau de détail encore lisible à cette distance.
  Un clic sur un îlot cadre dessus et rend les bulles complètes.
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

L'effectif — le **roster** — est **gardé par le serveur** et réécrit dans `.roster.json`,
puis rejoué en tête du flux à chaque connexion : recharger la page ou redémarrer le
serveur ne vide pas l'open space. C'est la seule chose que le serveur conserve ; l'activité,
elle, disparaît (voir [Ce que le serveur garde](#ce-que-le-serveur-garde-et-ce-quil-oublie)).
Les employés qui ne sont sur aucun dossier sont reposés directement à une place de repos —
ils étaient déjà là, les faire entrer par la porte serait un mensonge.

### Envoyer le lead en pause

Tape **`café`** (ou `coffee`, `pause café`, `va boire un café`, `take a break`…) comme
prompt dans une session : le lead quitte son poste pour le mange-debout. Il garde son
bureau et y revient dès qu'il y a du travail — un `PreToolUse` ou un vrai prompt suffit.

Le prompt doit se réduire **exactement** à l'une de ces phrases : une demande qui *parle* de
café (« ajoute un bouton café ») ne l'envoie pas au bar. Claude reçoit quand même le prompt
et y répondra — la commande ne pilote que la vue.

## Dehors : l'heure et le temps qu'il fait

La lumière suit l'**horloge système**, en continu. Le soleil traverse vraiment le ciel,
d'est en ouest, haut à midi : ce sont les ombres qui balaient la pièce qui font sentir
l'heure passer, pas seulement la teinte.

Les **suspensions s'allument toutes seules** autour du lever et du coucher — les vrais,
ceux de ta ville, pas des heures fixes qui seraient fausses de trois heures entre
décembre et juin. Elles restent à demi allumées en plein jour si le ciel est couvert,
comme on le fait chez soi.

| heure | ciel clair | ciel couvert |
|---|---|---|
| 2 h | 100 % | 100 % |
| lever | 50 % | 50 % |
| midi | éteintes | 45 % |
| coucher | 50 % | 50 % |
| 23 h | 100 % | 100 % |

Derrière les fenêtres, une **silhouette de ville** et le **temps qu'il fait vraiment**,
récupéré pour la ville de ton choix : ciel dégagé, nuages, brouillard, pluie (avec des
gouttes et des traînées sur la vitre), neige, orage et ses éclairs. La nuit, les fenêtres
des immeubles s'allument, et quelques-unes clignotent. Un ciel couvert aplatit aussi la
lumière intérieure : moins de soleil, plus d'ambiante diffuse.

- `CITY=Lyon node server.js` fixe la ville par défaut du serveur (sinon Paris).
  `?city=Marseille` dans l'URL de la page la change à la volée, sans rien relancer —
  les accents et les espaces passent (`?city=Saint-Étienne`, `?city=New York`).
- La météo vient d'[Open-Meteo](https://open-meteo.com) : pas de clé, pas de compte.
  **C'est le seul appel sortant du projet.** Ce qui part : le nom de la ville, puis des
  coordonnées. Rien d'autre — ni chemin, ni nom de projet, ni contenu de session. Hors
  ligne, la scène continue avec un ciel dégagé.
- `?hour=21` fige l'heure. `?clock=120` fait défiler une journée entière en 120 secondes :
  c'est le moyen de juger l'ambiance sans attendre le coucher du soleil.

## L'usage du bloc de 5 h

Une **horloge murale** affiche où en est le bloc de 5 heures, et les agents **fatiguent** à
mesure qu'il se remplit : le dos s'affaisse, la tête penche, la frappe ralentit. Au café
et sur le canapé, personne n'est fatigué — c'est bien le propos.

> La fatigue s'applique **par-dessus** l'animation de l'outil, jamais à sa place, et la
> frappe garde plus de la moitié de sa cadence même au maximum : on doit toujours voir
> qu'un agent est en train de taper. L'information passe avant l'effet.

**Ce que le serveur lit.** Les transcripts de Claude Code (`~/.claude/projects/**/*.jsonl`),
pour n'en extraire que **deux choses par ligne** : l'horodatage et le bloc `usage`. Le
contenu des messages n'est jamais lu, jamais retenu, jamais servi, et rien de tout cela ne
quitte la machine. La lecture est incrémentale — un transcript est un journal en ajout
seul, on ne relit que ce qui s'est écrit depuis le dernier passage.

**Quel pourcentage ?** Deux lectures sont possibles, et aucune n'est parfaite :

- **Le temps écoulé dans le bloc** — c'est le défaut. Exact, sans réglage. Le bloc est
  *ancré*, pas glissant : il s'ouvre à un message et dure cinq heures, puis le message
  suivant en ouvre un neuf. Une fenêtre glissante donnerait un indicateur collé à 100 %
  dès qu'on travaille plus de cinq heures d'affilée.
- **Le volume consommé** — `?budget=4000000` bascule la jauge et la fatigue sur les tokens
  (cache-read exclu : c'est du contexte relu, pas du travail). Plus parlant, mais **aucun
  quota n'est lisible en local** : le budget reste une estimation que tu fixes toi-même.
  Autant l'assumer que faire croire à une mesure.

## Le grain et le son

- Un **vignettage** et un **grain** très légers, en CSS — deux calques qui ne coûtent rien
  à la carte graphique. Le grain se décale plutôt qu'il ne se redessine.
- Un **halo** sur les ampoules et les écrans allumés, avec un seuil haut pour que seules
  les vraies sources débordent. Chargé en import dynamique et sous `try` : si le CDN ne
  répond pas, la scène se rend sans halo plutôt que de rester blanche.
- `?fx=0` coupe les trois. La scène reste parfaitement lisible sans eux.
- **Ambiance sonore** : pose ton `ambience.mp3` à côté d'`index.html`, le serveur le sert
  et le bouton `🔕 Son` le lance en boucle, avec un curseur de volume. **Aucune piste n'est
  livrée avec le projet** — une boucle lofi est une œuvre, et ce dépôt est public. Sans
  fichier, le bouton ne pilote que le bip.

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
   `CITY=Lyon node server.js` pour la météo de ta ville (défaut : Paris).
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

### Ce que le serveur garde, et ce qu'il oublie

**Rien de ce que font les agents n'est stocké.** Pas de base de données, pas de journal
d'activité, pas d'état de session sur disque. On recharge la page : la pièce est vide, et
se repeuple au premier signe de vie des postes — les instantanés s'en chargent en moins de
dix secondes (en mode flotte ; en mode local, au premier hook suivant).

La seule chose qui survit à un redémarrage est le **roster** : la liste des *métiers*
d'agents déjà vus au moins une fois (`Explore`, `Plan`, `redacteur-livrables`…). C'est lui
qui peuple l'open space et donne à la pièce son animation. Il ne contient ni projet, ni
nom de poste, ni activité — juste des noms de métiers, dans `.roster.json`.

`GET /sessions` montre ce que le serveur croit savoir à l'instant.

Un agent lancé pendant que le serveur était arrêté reste invisible jusqu'au prochain
instantané de son poste (ou, en mode local, jusqu'au prochain hook de sa session).

Ouvrir `index.html` directement (ou `?demo`) lance un scénario de démo sans serveur.
Depuis une autre machine : `HOST=0.0.0.0 node server.js` puis `index.html?server=http://ip:4317`.

## La flotte

Plusieurs postes dans le même bureau. On y voit **qui travaille, qui attend une réponse,
qui est au repos** — et rien de plus. Ni prompt, ni commande, ni nom de fichier, ni
chemin, ni nom de serveur MCP.

```
┌─ poste (×N) ──────────────────────┐        ┌─ serveur Docker ─────────┐
│ claude ──hooks (inchangés)──▶ :4317│        │  /ingest  (WS, jeton)    │
│                   agent local      │        │  /event   (HTTP, local)  │
│                ├─ assainit         │  WSS   │  état en RAM, rien sur   │
│                ├─ file d'attente ──┼───────▶│  disque sauf le roster   │
│                └─ vue locale :4317 │        │  /stream  (SSE)          │
└────────────────────────────────────┘        └──────────────────────────┘
```

**Pourquoi un agent local plutôt que pointer le hook sur le serveur distant.** Deux
raisons, et la seconde est la vraie. D'abord chaque hook bloquerait `claude` le temps
d'un aller-retour WAN. Ensuite et surtout, le hook envoie le JSON **brut** : prompts,
commandes, chemins. Il faut quelque chose sur le poste pour réduire l'événement à un
statut *avant* qu'il ne parte. C'est tout le travail de `protocol.js`.

Avantage de forme : `hooks.json` ne change pas. L'agent écoute sur le même
`127.0.0.1:4317/event`.

### Ce qui quitte le poste

```json
{ "v":1, "machine":"remy-pc", "session":"68746c1f", "project":"protrack",
  "event":"PreToolUse", "act":"term", "ref":"toolu_01DX", "agent":"Explore",
  "ts":1793866032056 }
```

| Champ | Ce que c'est | Pourquoi il part |
|---|---|---|
| `machine` | pseudo du poste, configurable | nommer l'îlot |
| `session` | 8 caractères de l'id de session | distinguer deux sessions d'un même poste |
| `project` | **dernier segment** du `cwd` | nommer le dossier. `C:\dev\gitlab-rd\protrack` → `protrack` |
| `act` | `read` `type` `term` `web` `plan` `think` `task` | la couleur de l'écran et l'animation |
| `agent` | le *métier* d'un sous-agent délégué | c'est lui qui peuple l'open space |
| `ref`, `agentId` | identifiants opaques | relier un début de mission à sa fin |

Ce qui **ne part jamais** : le prompt, la commande shell, le nom de fichier, le chemin
complet, la `description` d'une tâche, le message d'une notification, le nom d'un
serveur MCP (`mcp__…_Atlassian_MCP__…` devient `web`, point).

Deux exceptions calculées *sur le poste* pour préserver une fonctionnalité sans rien
révéler : « va boire un café » devient un booléen `coffee`, et le nombre de commandes
shell encore en cours devient un entier `bg` (les LED de la baie serveurs).

`node smoke-serveur.mjs` vérifie cette liste en rejouant des hooks truffés de secrets et
en cherchant chacun d'eux dans ce qui sort.

### Quand un poste décroche

Deux cas, traités différemment, parce qu'ils ne veulent pas dire la même chose :

- **Fermeture propre** (l'agent s'arrête) : le poste est parti, ses îlots se démontent
  tout de suite.
- **Coupure brutale** (wifi, veille, câble) : on attend `OFFLINE_GRACE` (20 s). Si le
  poste revient avant, rien ne bouge à l'écran — son instantané remet l'état d'aplomb.
  Sans ce délai, un hoquet de réseau de deux secondes ferait disparaître puis
  réapparaître tout le plateau : une convulsion pour une broutille.

Côté serveur, une socket morte a l'air parfaitement ouverte : rien ne la révèle sauf une
écriture. D'où un ping toutes les `SWEEP_EVERY` (15 s), qui échoue et déclenche la
fermeture. Au pire, une machine qui plante disparaît du bureau en 35 s.

### Réconciliation

Un `PostToolUse` perdu sur le réseau laisserait un sous-agent assis à son bureau pour
l'éternité. Le poste renvoie donc toutes les 10 s l'état complet de ce qu'il voit ; le
serveur le compare à ce qu'il croyait et n'émet **que les corrections**. C'est aussi ce
qui repeuple la pièce après un redémarrage du serveur, et ce qui sert de battement de
cœur : un poste silencieux plus de 45 s voit ses îlots démontés.

### La page d'installation

`install.html` résume toute la procédure — ce qui quitte un poste, monter le serveur,
brancher un PC, vérifier, dépanner. Le serveur la sert lui-même sur **`/install.html`**,
**hors mot de passe** : un collègue à qui l'on donne l'adresse du bureau n'a pas encore
le mot de passe, et c'est justement là qu'on lui explique comment se brancher.

C'est la seule adresse à envoyer à quelqu'un qu'on veut ajouter à la flotte.

### L'agent d'un poste

Un binaire Go, sans dépendance, dans `agent/`. Il écoute là où les hooks écrivent déjà :
**`hooks.json` n'a pas une ligne à changer.**

```sh
cd agent && go build -o claude-office-agent.exe .      # ou sans .exe hors Windows
./claude-office-agent.exe -server http://bureau.interne:4317 -token XXXX -save
```

`-save` écrit les options dans `%APPDATA%\claude-office\agent.json`
(`~/.config/claude-office/agent.json` ailleurs) ; les lancements suivants n'ont plus
besoin d'arguments. L'ordre est : fichier, puis `OFFICE_SERVER` / `OFFICE_TOKEN` /
`OFFICE_MACHINE`, puis les options de ligne de commande.

| Option | Défaut | Rôle |
|---|---|---|
| `-server` | aucun | serveur de la flotte. `http(s)://` accepté, pas besoin d'écrire `ws://` |
| `-token` | aucun | doit correspondre à `OFFICE_TOKEN` côté serveur |
| `-machine` | nom de la machine | le nom affiché sur l'îlot |
| `-port` | 4317 | port local, là où pointent les hooks |
| `-page` | détecté | `index.html` pour la vue locale |

**Sans `-server`**, l'agent ne fait que la vue locale : c'est un `server.js` en plus
petit, et rien ne quitte la machine.

#### Sous Windows, le lanceur

`agent/lancer-agent.bat` évite d'avoir à expliquer une ligne de commande à un collègue.
Pose à côté un fichier `agent.cfg` :

```
SERVEUR=http://adresse-du-serveur:4317
JETON=le-jeton-donné-par-l-administrateur
```

Double-clic : il enregistre la configuration dans `%APPDATA%`, et les fois suivantes il
se suffit à lui-même — `agent.cfg` ne sert plus. Si `index.html` est un cran au-dessus
(donc si on lance depuis le dépôt), il active aussi la vue locale.

`agent.cfg` **n'est pas versionné** : ce dépôt est public, et un jeton n'a rien à y faire.

**La vue locale garde le détail.** Sur `http://127.0.0.1:4317/`, l'agent sert la page et
lui diffuse les hooks **bruts** — noms de fichiers, commandes, prompts. C'est ton poste,
ça ne va nulle part. Seul ce qui part vers la flotte est assaini. Il faut qu'`index.html`
soit trouvable : à côté de l'exécutable, dans le dossier courant, ou via `-page`.

`http://127.0.0.1:4317/status` dit si la liaison tient, et sinon pourquoi. C'est la
première chose à regarder quand un poste n'apparaît pas dans le bureau.

La météo de la vue locale est relayée au serveur de la flotte : c'est lui qui parle à
Open-Meteo, et dupliquer ce code dans deux langages pour une tuile de ciel serait un
mauvais marché. Hors ligne, la page sait déjà s'en passer.

### Déployer le serveur

```sh
OFFICE_TOKEN=$(openssl rand -hex 16) docker compose up -d
```

| Variable | Défaut | Rôle |
|---|---|---|
| `OFFICE_TOKEN` | *tiré au hasard au démarrage* | jeton que les agents présentent sur `/ingest` |
| `VIEW_PASSWORD` | vide = page libre | mot de passe de la page (`VIEW_USER`, défaut `office`) |
| `CITY` | `Paris` | ville de la météo — seul appel sortant du serveur |
| `ROSTER_FILE` | `.roster.json` | le seul fichier écrit |
| `ALLOW_REMOTE_EVENT` | `0` | ouvre `/event` au réseau. **À laisser à `0`** : cet endpoint accepte des hooks bruts |
| `OFFLINE_GRACE` | `20000` | délai avant de démonter les îlots d'un poste coupé brutalement |
| `SWEEP_EVERY` | `15000` | période du ping qui révèle les sockets mortes |

Le jeton n'est jamais vide : sans valeur fournie, le serveur en tire un au hasard et
l'affiche au démarrage. Zéro configuration, mais jamais ouvert.

Sur un LAN, la page reste libre. Pour une adresse publique : un reverse proxy TLS devant,
`VIEW_PASSWORD` rempli, et le port 4317 non publié.

### État d'avancement

- [x] **Lot 0** — le contrat (`protocol.js`) et sa table d'activités
- [x] **Lot 1** — serveur multi-postes, WebSocket sans dépendance (`ws.js`), Docker
- [x] **Lot 2** — l'agent Go (`agent/`), sans dépendance lui aussi
- [x] **Lot 3** — la pièce : 20 emplacements, étiquette de poste, pastilles d'état
- [ ] **Lot 4** — VPS : TLS, mot de passe, un jeton par poste
- [ ] **Lot 5** — distribution : installeur, démarrage automatique

Le client WebSocket (Go) et le serveur WebSocket (`ws.js`) sont tous deux écrits à la
main. `smoke-agent.mjs` est le seul test qui les fasse se parler — les tests unitaires
de chaque côté peuvent passer tous les deux pendant qu'ils se refusent la poignée de main.

## Vérifier

`node smoke.mjs` évalue le module entier d'`index.html` avec un three.js factice et
fait tourner huit images de la boucle. `node --check` ne voit que la syntaxe : un appel
au chargement qui touche une constante déclarée plus bas lève une *ReferenceError* de
zone morte, tue tout le script et laisse une page noire — sans la moindre erreur de
syntaxe. C'est arrivé une fois ; ce test est là pour que ça ne recommence pas.

`node smoke.mjs "?hour=21&fx=0"` passe des paramètres d'URL.

`node smoke.mjs "?demo=20"` remplit les vingt emplacements. C'est la seule façon de
**voir** si la pièce tient à pleine charge : le serveur ne rejoue aucune session, donc
une page rechargée arrive dans une pièce vide. `smoke.mjs` vérifie en plus la géométrie
par assertions — que les vingt emplacements tiennent dans les murs, qu'aucun n'en
chevauche un autre, que chacun s'ouvre sur une allée, qu'aucune allée ne traverse un
îlot, et que la baie serveurs ne mord pas sur la rangée du fond. Une capture d'écran ne
répond à aucune de ces questions de façon fiable : un îlot qui mord sur la baie de dix
centimètres ne se voit pas, et se verra sur l'écran de quelqu'un d'autre.

`node smoke-serveur.mjs` couvre le serveur : l'assainisseur (en cherchant des secrets
dans ce qui sort), le WebSocket (dont le vecteur de test de la RFC 6455 — une chaîne
magique mal recopiée donne une poignée de main refusée sans le moindre message d'erreur
exploitable), et le trajet complet d'un poste jusqu'à la page.

`cd agent && go test ./...` couvre l'assainisseur côté Go, le suivi des missions et le
nettoyage des noms de postes.

`node smoke-agent.mjs` fait tourner **les vrais binaires** l'un contre l'autre : un hook
brut entre dans l'agent Go, un statut assaini ressort côté page. Il s'ignore de lui-même
si l'agent n'est pas compilé.

## Limites connues

- **L'identifiant de session est tronqué à 8 caractères.** Deux sessions dont les
  8 premiers caractères coïncident se fondent en un seul îlot, et leurs sous-agents
  s'empilent dessus. Sur de vrais identifiants Claude Code — des UUID — ce sont
  4,3 milliards de valeurs pour quelques sessions par poste : la collision ne se produit
  pas. Mais elle se produit immédiatement avec des identifiants fabriqués à la main
  (`essai-1`, `essai-2`…), ce qui compte quand on teste. Utilisez des identifiants qui
  diffèrent dans les huit premiers caractères.
- **À pleine charge, la pièce est lourde.** Vingt îlots, ce sont jusqu'à 80 personnages,
  et la nuit vingt lumières ponctuelles — une par suspension. Deux économies ont été
  faites : le gyrophare n'a plus qu'**une** lumière pour toute la pièce, qui se pose sur
  l'îlot qui appelle, et les suspensions éteintes sont rendues *invisibles*, donc three.js
  les ignore quand il collecte les lumières (en plein jour, elles ne coûtent plus rien).
  Reste le cas du plateau plein à la nuit tombée, qui n'a pas été mesuré sur du vrai
  matériel : `?demo=20&hour=22` le reproduit en une URL si vous voulez voir ce que ça
  donne sur le vôtre.
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
- **Le budget de tokens est une estimation, pas une mesure.** Aucun quota n'est lisible
  dans les fichiers locaux de Claude Code — `policy-limits.json` ne contient que de la
  politique d'organisation. C'est pourquoi la jauge affiche le temps par défaut.
- Le **premier relevé d'usage** parcourt tous les transcripts récents (~200 ms ici) ;
  les suivants sont incrémentaux et mis en cache 20 s.
- La mémoire de l'effectif est **par serveur, pas par projet** : un employé embauché depuis
  un dépôt peut être rappelé depuis un autre. C'est voulu — c'est la même maison.

## Pistes

- Piloter Claude depuis l'UI via l'Agent SDK (le serveur lance les sessions et lit le stream JSON → attribution exacte des sous-agents).
- Modèles glTF / sprites low-poly à la place des cubes, sons de clavier.
- Statistiques façon tycoon : tokens, fichiers modifiés, tests verts, « moral » des agents.
- Ancienneté visible : un employé embauché il y a longtemps mérite mieux qu'un bureau au fond.
