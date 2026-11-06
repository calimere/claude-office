#!/bin/sh
# Claude Office — fabrique les archives de l'agent, pretes a diffuser.
#
#     ./paquet.sh                                    des archives neutres
#     SERVEUR=http://192.168.1.56:4317 JETON=xxx ./paquet.sh
#
# Avec SERVEUR et JETON, la configuration est posee DANS l'archive : le collegue
# double-clique, et c'est fini. Sans eux, l'archive est neutre et il faudra lui
# donner l'adresse et le jeton a part.
#
# Resultat dans dist/ :
#     claude-office-agent-windows-amd64.zip      .bat, double-clic
#     claude-office-agent-linux-amd64.tar.gz     installer.sh, service systemd
#     claude-office-agent-linux-arm64.tar.gz     idem, pour ARM
#     SHA256SUMS
#
# Go cross-compile sans rien installer : un seul poste suffit a produire les trois.

set -eu

RACINE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIST="$RACINE/dist"
VERSION=$(git -C "$RACINE" describe --tags --always --dirty 2>/dev/null || echo inconnue)

command -v go >/dev/null 2>&1 || {
  echo "go est introuvable. Installez Go, ou mettez une toolchain portable dans le PATH." >&2
  exit 1
}

rm -rf "$DIST"
mkdir -p "$DIST"

# --------------------------------------------------------------------------
# agent.cfg : pre-rempli si on nous a donne de quoi, sinon un modele.
# --------------------------------------------------------------------------
SERVEUR=${SERVEUR:-}
JETON=${JETON:-}
PRE_REMPLI=non
[ -n "$SERVEUR" ] && [ -n "$JETON" ] && PRE_REMPLI=oui

ecrire_cfg() {
  if [ "$PRE_REMPLI" = oui ]; then
    cat > "$1" <<CFG
# Configuration lue au premier lancement, puis enregistree dans %APPDATA%.
SERVEUR=$SERVEUR
JETON=$JETON
CFG
  else
    cat > "$1" <<'CFG'
# Configuration lue au premier lancement, puis enregistree dans %APPDATA%.
# Remplacez les deux valeurs ci-dessous par celles de votre serveur.
SERVEUR=http://adresse-du-serveur:4317
JETON=le-jeton-donne-par-l-administrateur
CFG
  fi
}

# --------------------------------------------------------------------------
# Un LISEZMOI par plateforme : la premiere chose qu'on ouvre en recevant un zip.
# --------------------------------------------------------------------------
lisezmoi_windows() {
  cat > "$1" <<TXT
Claude Office — agent du poste (Windows)   version $VERSION
===========================================================

1. Decompressez ce dossier ou vous voulez (Bureau, Documents, peu importe).
2. Double-cliquez sur  lancer-agent.bat
3. Laissez la fenetre ouverte. Fermer la fenetre arrete la publication.
4. Relancez \`claude\` dans vos projets : une session deja ouverte garde les
   hooks qu'elle avait au demarrage.

C'est tout. L'agent s'occupe aussi d'installer les hooks de Claude Code dans
votre settings.json, sans toucher a ceux que vous y avez deja.
$(if [ "$PRE_REMPLI" = oui ]; then
  printf '%s\n' "Le serveur est deja configure : $SERVEUR"
else
  printf '%s\n' "Avant le premier lancement, ouvrez agent.cfg et remplacez l'adresse du
serveur et le jeton par ceux que vous a donnes l'administrateur."
fi)

Ce qui part de votre poste
--------------------------
Un statut (au travail / en attente / en pause), le NOM du dossier de projet, et
une categorie d'outil (fichier, console, web...). Rien d'autre. Ni le contenu
des fichiers, ni les commandes, ni vos prompts, ni les noms de fichiers.

La vue locale, elle, garde tout le detail : http://127.0.0.1:4317/
Elle ne sort pas de votre machine.

Si le poste n'apparait pas dans le bureau
-----------------------------------------
Ouvrez http://127.0.0.1:4317/status — il dit si la liaison tient, et sinon
pourquoi. En ligne mais zero session : les hooks ne sont pas actifs, relancez
\`claude\`.
TXT
}

lisezmoi_linux() {
  cat > "$1" <<TXT
Claude Office — agent du poste (Linux)   version $VERSION
=========================================================

    tar xzf claude-office-agent-linux-*.tar.gz
    cd claude-office-agent
    ./installer.sh$(if [ "$PRE_REMPLI" = oui ]; then printf ''; else printf ' http://adresse-du-serveur:4317 LE_JETON'; fi)

Puis relancez \`claude\` dans vos projets : une session deja ouverte garde les
hooks qu'elle avait au demarrage.

L'installateur ne demande pas sudo. Il pose tout dans votre dossier personnel :

    ~/.local/bin/claude-office-agent               l'executable
    ~/.local/share/claude-office/index.html        la vue locale
    ~/.config/claude-office/agent.json             serveur + jeton (mode 600)
    ~/.config/systemd/user/claude-office-agent.service
    et les hooks fusionnes dans ~/.claude/settings.json

Le service demarre avec votre session. Pour le suivre :

    systemctl --user status claude-office-agent
    journalctl --user -u claude-office-agent -f

Pour tout retirer :  ./installer.sh --desinstaller

Ce qui part de votre poste
--------------------------
Un statut (au travail / en attente / en pause), le NOM du dossier de projet, et
une categorie d'outil (fichier, console, web...). Rien d'autre. Ni le contenu
des fichiers, ni les commandes, ni vos prompts, ni les noms de fichiers.

La vue locale, elle, garde tout le detail : http://127.0.0.1:4317/
Elle ne sort pas de votre machine.

Si le poste n'apparait pas dans le bureau
-----------------------------------------
Ouvrez http://127.0.0.1:4317/status — il dit si la liaison tient, et sinon
pourquoi. En ligne mais zero session : les hooks ne sont pas actifs, relancez
\`claude\`.
TXT
}

# --------------------------------------------------------------------------
# Compilation
# --------------------------------------------------------------------------
# -s -w retire la table des symboles et DWARF : l'executable passe d'environ
# 8 Mo a 5, et personne ne deboguera l'agent depuis le poste d'un collegue.
construire() { # $1=GOOS  $2=GOARCH  $3=destination
  echo "  compilation $1/$2"
  ( cd "$RACINE/agent" && CGO_ENABLED=0 GOOS=$1 GOARCH=$2 \
      go build -trimpath -ldflags "-s -w" -o "$3" . )
}

echo "Claude Office — fabrication des paquets (version $VERSION)"
[ "$PRE_REMPLI" = oui ] \
  && echo "  configuration incluse : $SERVEUR" \
  || echo "  archives neutres (passez SERVEUR= et JETON= pour les pre-remplir)"

# ---- Windows ----
W="$DIST/claude-office-agent"
mkdir -p "$W"
construire windows amd64 "$W/claude-office-agent.exe"
cp "$RACINE/agent/lancer-agent.bat" "$W/"
cp "$RACINE/index.html" "$W/"
ecrire_cfg "$W/agent.cfg"
lisezmoi_windows "$W/LISEZMOI.txt"
# Les .txt et .bat seront lus par le Bloc-notes et par cmd.exe : des fins de
# ligne Windows, sinon tout s'affiche sur une seule ligne.
for f in "$W/LISEZMOI.txt" "$W/agent.cfg"; do
  sed -i 's/$/\r/' "$f" 2>/dev/null || true
done

ZIP="$DIST/claude-office-agent-windows-amd64.zip"
if command -v zip >/dev/null 2>&1; then
  ( cd "$DIST" && zip -qr "$ZIP" claude-office-agent )
elif command -v powershell.exe >/dev/null 2>&1; then
  # Git Bash sans zip : Windows sait le faire tout seul depuis PowerShell 5.
  powershell.exe -NoProfile -NonInteractive -Command \
    "Compress-Archive -Force -Path '$(cygpath -w "$W")' -DestinationPath '$(cygpath -w "$ZIP")'" >/dev/null
else
  echo "ni zip ni powershell : archive Windows non produite." >&2
fi
rm -rf "$W"
[ -f "$ZIP" ] && echo "  $(basename "$ZIP")"

# ---- Linux ----
for arch in amd64 arm64; do
  L="$DIST/claude-office-agent"
  mkdir -p "$L"
  construire linux "$arch" "$L/claude-office-agent"
  cp "$RACINE/agent/installer.sh" "$L/"
  chmod 755 "$L/installer.sh" "$L/claude-office-agent"
  cp "$RACINE/index.html" "$L/"
  lisezmoi_linux "$L/LISEZMOI.txt"
  # msys ne sait pas poser le bit d execution sur un fichier NTFS : sorti d ici,
  # l executable Linux arrivait en 644 et refusait de se lancer. tar n a pas de
  # mode par fichier, alors on ecrit l archive en deux passes.
  TAR="$DIST/claude-office-agent-linux-$arch.tar"
  TGZ="$TAR.gz"
  ( cd "$DIST" \
    && tar cf "$TAR" --owner=0 --group=0 --mode=0755 \
         claude-office-agent/claude-office-agent claude-office-agent/installer.sh \
    && tar rf "$TAR" --owner=0 --group=0 --mode=0644 \
         claude-office-agent/index.html claude-office-agent/LISEZMOI.txt \
    && gzip -9f "$TAR" )
  rm -rf "$L"
  echo "  $(basename "$TGZ")"
done

# --------------------------------------------------------------------------
( cd "$DIST" && ls | grep -v SHA256SUMS | xargs sha256sum > SHA256SUMS )

echo
echo "dist/ :"
( cd "$DIST" && ls -lh | tail -n +2 | awk '{printf "  %-44s %s\n", $9, $5}' )
if [ "$PRE_REMPLI" = oui ]; then
  echo
  echo "  ATTENTION : ces archives CONTIENNENT le jeton. Diffusez-les comme vous"
  echo "  diffuseriez le jeton lui-meme, et pas plus loin."
fi
