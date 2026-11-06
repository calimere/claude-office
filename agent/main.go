package main

// Claude Office — l'agent a installer sur un poste.
//
// Il ecoute la ou les hooks de Claude Code ecrivent deja (127.0.0.1:4317/event),
// assainit ce qu'il recoit, et publie le resultat vers le serveur de la flotte.
// `hooks.json` n'a pas une ligne a changer.
//
//   claude-office-agent -server http://bureau.interne:4317 -token XXXX
//
// Sans -server, il ne fait que la vue locale : c'est alors un server.js en plus
// petit, et rien ne quitte la machine.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
)

type Config struct {
	Server  string `json:"server"`
	Token   string `json:"token"`
	Machine string `json:"machine"`
	Port    int    `json:"port"`
	Page    string `json:"page"`
}

func configPath() string {
	if runtime.GOOS == "windows" {
		if d := os.Getenv("APPDATA"); d != "" {
			return filepath.Join(d, "claude-office", "agent.json")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "agent.json"
	}
	return filepath.Join(home, ".config", "claude-office", "agent.json")
}

// Le nom du poste est ce qui s'affiche sur l'ilot, et le serveur le refuse s'il
// sort de ce jeu de caracteres. On nettoie plutot que d'echouer : un nom de machine
// Windows peut contenir a peu pres n'importe quoi.
var nameOK = regexp.MustCompile(`[^A-Za-z0-9 ._-]+`)

func cleanName(s string) string {
	s = strings.TrimSpace(nameOK.ReplaceAllString(s, "-"))
	if len(s) > 32 {
		s = s[:32]
	}
	return strings.Trim(s, "-. ")
}

// index.html a cote de l'executable, puis dans le dossier courant. Absent : la vue
// locale est simplement desactivee, l'agent reste un relais.
func findPage(explicit string) string {
	if explicit != "" {
		if _, err := os.Stat(explicit); err == nil {
			return explicit
		}
		return ""
	}
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		dirs = append(dirs, wd)
	}
	for _, d := range dirs {
		p := filepath.Join(d, "index.html")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func main() {
	cfgPath := flag.String("config", configPath(), "fichier de configuration")
	server := flag.String("server", "", "serveur de la flotte, ex. http://bureau.interne:4317")
	token := flag.String("token", "", "jeton d'acces au serveur (OFFICE_TOKEN cote serveur)")
	machine := flag.String("machine", "", "nom du poste affiche sur l'ilot (defaut : nom de la machine)")
	port := flag.Int("port", 0, "port d'ecoute local (defaut 4317, la ou pointent les hooks)")
	page := flag.String("page", "", "chemin d'index.html pour la vue locale")
	writeCfg := flag.Bool("save", false, "enregistre les options donnees dans le fichier de configuration")
	doHooks := flag.Bool("hooks", false, "installe les hooks Claude Code dans ~/.claude/settings.json")
	flag.Parse()

	// Fichier, puis variables d'environnement, puis options : chaque niveau ecrase
	// le precedent.
	cfg := Config{}
	if b, err := os.ReadFile(*cfgPath); err == nil {
		if err := json.Unmarshal(b, &cfg); err != nil {
			fmt.Fprintf(os.Stderr, "configuration illisible (%s) : %v\n", *cfgPath, err)
			os.Exit(1)
		}
	}
	if v := os.Getenv("OFFICE_SERVER"); v != "" {
		cfg.Server = v
	}
	if v := os.Getenv("OFFICE_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("OFFICE_MACHINE"); v != "" {
		cfg.Machine = v
	}
	if *server != "" {
		cfg.Server = *server
	}
	if *token != "" {
		cfg.Token = *token
	}
	if *machine != "" {
		cfg.Machine = *machine
	}
	if *port != 0 {
		cfg.Port = *port
	}
	if *page != "" {
		cfg.Page = *page
	}
	if cfg.Port == 0 {
		cfg.Port = 4317
	}
	if cfg.Machine == "" {
		h, _ := os.Hostname()
		cfg.Machine = h
	}
	cfg.Machine = cleanName(cfg.Machine)
	if cfg.Machine == "" {
		cfg.Machine = "poste"
	}

	if *writeCfg {
		os.MkdirAll(filepath.Dir(*cfgPath), 0o755)
		b, _ := json.MarshalIndent(cfg, "", "  ")
		if err := os.WriteFile(*cfgPath, b, 0o600); err != nil {
			fmt.Fprintf(os.Stderr, "ecriture de la configuration : %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("configuration enregistree dans %s\n", *cfgPath)
	}

	// Un agent connecte qui ne recoit aucun hook est la panne la plus deroutante de
	// l installation : tout a l air de marcher. Le lanceur passe -hooks a chaque
	// demarrage, et l operation ne reecrit rien quand tout est deja en place.
	if *doHooks {
		p, n, err := InstallHooks(cfg.Port)
		switch {
		case err != nil:
			fmt.Fprintf(os.Stderr, "hooks : %v\n", err)
			os.Exit(1)
		case n == 0:
			fmt.Printf("hooks deja en place dans %s\n", p)
		default:
			fmt.Printf("%d hooks ajoutes dans %s — relancez `claude` pour qu ils prennent effet\n", n, p)
		}
	}

	logf := func(f string, a ...any) { fmt.Printf("  "+f+"\n", a...) }

	st := NewState()
	usage := NewUsage()

	var fleet *Fleet
	if cfg.Server != "" {
		if cfg.Token == "" {
			fmt.Fprintln(os.Stderr, "un serveur est configure mais pas de jeton : voir -token")
			os.Exit(1)
		}
		f, err := NewFleet(cfg.Server, cfg.Token, cfg.Machine, st, usage.Message, logf)
		if err != nil {
			fmt.Fprintf(os.Stderr, "serveur de flotte : %v\n", err)
			os.Exit(1)
		}
		fleet = f
	}

	pagePath := findPage(cfg.Page)
	local := NewLocal(st, fleet, usage, cfg.Machine, pagePath, cfg.Server)
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)

	fmt.Printf("Claude Office — agent du poste « %s »\n", cfg.Machine)
	fmt.Printf("  ecoute      : http://%s/event  (ou pointent deja les hooks)\n", addr)
	if fleet != nil {
		fmt.Printf("  flotte      : %s\n", cfg.Server)
	} else {
		fmt.Printf("  flotte      : aucune (mode local seul, rien ne quitte la machine)\n")
	}
	if pagePath != "" {
		fmt.Printf("  vue locale  : http://%s/  (%s)\n", addr, pagePath)
	} else {
		fmt.Printf("  vue locale  : desactivee (index.html introuvable, voir -page)\n")
	}
	fmt.Printf("  usage 5 h   : %s\n", map[bool]string{true: "transcripts locaux", false: "indisponible"}[usage.Available()])
	fmt.Printf("  diagnostic  : http://%s/status\n", addr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if fleet != nil {
		go fleet.Run(ctx)
	}

	errc := make(chan error, 1)
	go func() { errc <- local.Serve(addr) }()

	select {
	case <-ctx.Done():
		fmt.Println("\narret demande")
	case err := <-errc:
		// Le cas courant : le port est deja pris, par server.js ou par une autre
		// instance de l'agent. Le dire franchement evite un quart d'heure perdu.
		fmt.Fprintf(os.Stderr, "\necoute locale impossible sur %s : %v\n", addr, err)
		fmt.Fprintln(os.Stderr, "un server.js ou un autre agent occupe deja ce port ?")
		os.Exit(1)
	}
}
