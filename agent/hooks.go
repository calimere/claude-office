package main

// Installation des hooks dans ~/.claude/settings.json.
//
// Sans eux, l'agent se connecte parfaitement et ne recoit rien : le poste apparait
// dans le bureau, en ligne, avec zero session. C'est la panne la plus deroutante de
// toute l'installation, parce que tout a l'air de marcher. Autant que l'agent s'en
// charge — un fichier .bat ne sait pas fusionner du JSON, lui si.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Un hook par evenement, qui poste la charge utile brute a l'agent local.
// `matcher` n'a de sens que pour les evenements d'outil.
var hookEvents = []struct {
	nom     string
	matcher bool
}{
	{"SessionStart", false}, {"UserPromptSubmit", false},
	{"PreToolUse", true}, {"PostToolUse", true},
	{"Notification", false}, {"SubagentStop", false},
	{"Stop", false}, {"SessionEnd", false},
}

// La commande est ecrite pour etre portable : Claude Code passe les hooks par `sh`
// sur certaines installations Windows et par `cmd.exe` sur d'autres.
//
//   - `-H Content-Type:application/json` SANS espace : un en-tete HTTP n'en exige
//     pas, et sans espace il n'y a plus besoin de guillemets — donc plus de
//     difference de quoting entre les deux shells.
//   - `|| exit 0` : `exit 0` existe dans les deux. `|| true` echoue sous cmd.exe.
//   - aucune redirection : `-s` rend curl muet et le serveur repond 204 sans corps,
//     donc il n'y a rien a rediriger. `>/dev/null` casse sous cmd.exe, et `>nul`
//     sous sh cree un fichier nomme `nul` dans le projet.
func hookCommand(port int) string {
	return fmt.Sprintf("curl -s -m 1 -X POST http://127.0.0.1:%d/event"+
		" -H Content-Type:application/json --data-binary @- || exit 0", port)
}

func settingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// Un hook qui poste deja vers notre port : on ne l'ajoute pas une seconde fois.
func dejaInstalle(liste []any, port int) bool {
	b, err := json.Marshal(liste)
	if err != nil {
		return false
	}
	return strings.Contains(string(b), fmt.Sprintf("127.0.0.1:%d/event", port))
}

// InstallHooks ajoute nos hooks sans toucher a ceux qui s'y trouvent deja, et sans
// rien reecrire s'ils sont tous presents. Idempotent : on peut l'appeler a chaque
// lancement, ce qui repare aussi le poste ou Claude Code a ete installe apres.
func InstallHooks(port int) (chemin string, ajoutes int, err error) {
	chemin, err = settingsPath()
	if err != nil {
		return "", 0, err
	}
	os.MkdirAll(filepath.Dir(chemin), 0o755)

	racine := map[string]any{}
	if brut, e := os.ReadFile(chemin); e == nil && len(brut) > 0 {
		if e := json.Unmarshal(brut, &racine); e != nil {
			// Un settings.json illisible n'est pas le notre a reparer. On s'arrete
			// plutot que d'ecraser la configuration de quelqu'un.
			return chemin, 0, fmt.Errorf("%s est illisible (%v) — on n'y touche pas", chemin, e)
		}
		// Sauvegarde avant d'ecrire : ce fichier appartient a l'utilisateur.
		os.WriteFile(chemin+".avant-claude-office", brut, 0o644)
	}

	hooks, _ := racine["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}

	cmd := hookCommand(port)
	for _, ev := range hookEvents {
		liste, _ := hooks[ev.nom].([]any)
		if dejaInstalle(liste, port) {
			continue
		}
		entree := map[string]any{
			"hooks": []any{map[string]any{"type": "command", "command": cmd, "timeout": 2}},
		}
		if ev.matcher {
			entree["matcher"] = "*"
		}
		hooks[ev.nom] = append(liste, entree)
		ajoutes++
	}
	if ajoutes == 0 {
		return chemin, 0, nil
	}

	racine["hooks"] = hooks
	out, err := json.MarshalIndent(racine, "", "  ")
	if err != nil {
		return chemin, 0, err
	}
	return chemin, ajoutes, os.WriteFile(chemin, out, 0o644)
}
