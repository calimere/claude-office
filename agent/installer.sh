#!/bin/sh
# Claude Office — installation de l'agent sur un poste Linux.
#
#     ./installer.sh                                   demande le serveur et le jeton
#     ./installer.sh http://bureau.interne:4317 JETON   sans rien demander
#     SERVEUR=... JETON=... ./installer.sh              pour un deploiement automatise
#
# Ce qu'il pose, et rien d'autre :
#   ~/.local/bin/claude-office-agent            l'executable
#   ~/.local/share/claude-office/index.html     la vue locale
#   ~/.config/claude-office/agent.json          serveur + jeton (mode 600)
#   ~/.config/systemd/user/claude-office-agent.service
#   et les hooks fusionnes dans ~/.claude/settings.json
#
# Tout est dans le dossier de l'utilisateur : pas de sudo, rien a /usr/local, et
# `./installer.sh --desinstaller` remet le poste exactement dans son etat d'avant.

set -eu

ICI=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$HOME/.local/bin"
PART="$HOME/.local/share/claude-office"
UNITE="$HOME/.config/systemd/user/claude-office-agent.service"
SERVICE=claude-office-agent
POSE=non   # le service a-t-il reellement ete installe ?

dire() { printf '  %s\n' "$*"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --------------------------------------------------------------------------
# Desinstallation
# --------------------------------------------------------------------------
if [ "${1:-}" = "--desinstaller" ] || [ "${1:-}" = "--uninstall" ]; then
  titre "Desinstallation"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  fi
  rm -f "$UNITE" "$BIN/claude-office-agent"
  rm -rf "$PART"
  command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true
  dire "service, executable et page retires."
  dire "Restent, volontairement : ~/.config/claude-office/agent.json (serveur + jeton)"
  dire "et les hooks dans ~/.claude/settings.json. Les retirer :"
  dire "  rm -rf ~/.config/claude-office"
  dire "  et enlever a la main les lignes 127.0.0.1:4317/event de ~/.claude/settings.json"
  dire "  (la sauvegarde d'avant l'installation : ~/.claude/settings.json.avant-claude-office)"
  exit 0
fi

# --------------------------------------------------------------------------
# Ce qu'on a sous la main
# --------------------------------------------------------------------------
EXE="$ICI/claude-office-agent"
[ -f "$EXE" ] || { echo "claude-office-agent introuvable a cote de ce script ($ICI)." >&2; exit 1; }

# `read` sur l'entree standard echoue si le script est lu depuis un tube
# (`curl ... | sh`). /dev/tty parle au terminal, quoi qu'il arrive sur stdin.
demander() {
  printf '  %s' "$1" >&2
  if [ -r /dev/tty ]; then read -r REP < /dev/tty; else read -r REP; fi
  printf '%s' "$REP"
}

SERVEUR=${1:-${SERVEUR:-}}
JETON=${2:-${JETON:-}}

titre "Claude Office — agent du poste $(hostname)"
[ -n "$SERVEUR" ] || SERVEUR=$(demander "Adresse du serveur (ex. http://192.168.1.56:4317) : ")
[ -n "$JETON" ]   || JETON=$(demander "Jeton donne par l'administrateur             : ")
[ -n "$SERVEUR" ] && [ -n "$JETON" ] || { echo "Il faut une adresse ET un jeton." >&2; exit 1; }

# --------------------------------------------------------------------------
# Pose des fichiers
# --------------------------------------------------------------------------
mkdir -p "$BIN" "$PART"
install -m 755 "$EXE" "$BIN/claude-office-agent"
PAGE=
if [ -f "$ICI/index.html" ]; then
  install -m 644 "$ICI/index.html" "$PART/index.html"
  PAGE="$PART/index.html"
fi

titre "Configuration"
# -quit : on enregistre et on installe les hooks, puis on rend la main. C'est le
# service qui demarrera l'agent, pas cet appel-ci.
"$BIN/claude-office-agent" -server "$SERVEUR" -token "$JETON" \
  ${PAGE:+-page "$PAGE"} -save -hooks -quit

# --------------------------------------------------------------------------
# Demarrage automatique
# --------------------------------------------------------------------------
titre "Demarrage automatique"
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
  # Conteneur, WSL sans systemd, session distante sans bus : on ne bricole pas un
  # autre mecanisme de demarrage, on le dit.
  dire "systemd utilisateur indisponible ici — pas de service installe."
  dire "Lancez l'agent a la main, ou depuis le demarrage de votre session :"
  dire "  $BIN/claude-office-agent"
else
  mkdir -p "$(dirname "$UNITE")"
  cat > "$UNITE" <<UNIT
[Unit]
Description=Claude Office - agent du poste
# L'agent survit a une coupure reseau, mais autant ne pas le faire echouer au
# demarrage alors que l'interface n'est pas encore montee.
After=network-online.target

[Service]
Type=simple
# -hooks a chaque demarrage : l'operation est sans effet quand ils sont deja en
# place, et un poste ou Claude Code est installe plus tard se repare tout seul.
ExecStart=$BIN/claude-office-agent -hooks
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  POSE=oui
  dire "service installe et demarre."
  # Sans linger, le service meurt a la deconnexion. Sur un poste de travail c'est
  # exactement ce qu'on veut ; sur une machine qu'on quitte en laissant tourner,
  # non. On le signale plutot que de decider a la place de l'utilisateur.
  if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    dire "(L'agent s'arretera a la deconnexion. Pour qu'il tienne sans session :"
    dire "  sudo loginctl enable-linger $(id -un) )"
  fi
fi

# --------------------------------------------------------------------------
titre "C'est pose"
dire "serveur     : $SERVEUR"
dire "diagnostic  : http://127.0.0.1:4317/status"
[ -n "$PAGE" ] && dire "vue locale  : http://127.0.0.1:4317/  (tout le detail, rien ne sort)"
[ "$POSE" = oui ] && dire "journal     : journalctl --user -u $SERVICE -f"
printf '\n'
dire "Relancez \`claude\` pour que les hooks prennent effet : une session deja"
dire "ouverte garde ceux qu'elle avait au demarrage."
printf '\n'
