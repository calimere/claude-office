package main

// Le serveur local. Il ecoute la ou les hooks ecrivent deja — 127.0.0.1:4317/event —
// si bien que `hooks.json` n'a pas une ligne a changer.
//
// Il fait deux choses de la meme charge utile :
//   - il la diffuse telle quelle a la page locale (mode local : le detail reste sur
//     le poste, donc autant l'afficher) ;
//   - il l'assainit et la confie a la flotte (mode flotte : seul le statut part).
//
// La boucle locale uniquement : ce qui arrive ici contient les prompts et les
// commandes, et n'a aucune raison d'etre joignable depuis le reseau.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Local struct {
	state   *State
	fleet   *Fleet
	usage   *Usage
	machine string
	page    string // chemin d'index.html, vide si introuvable
	server  string // serveur de flotte, pour relayer la meteo

	mu      sync.Mutex
	clients map[chan string]struct{}
}

func NewLocal(st *State, f *Fleet, u *Usage, machine, page, server string) *Local {
	return &Local{state: st, fleet: f, usage: u, machine: machine, page: page,
		server: server, clients: map[chan string]struct{}{}}
}

func (l *Local) broadcast(raw string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for c := range l.clients {
		select {
		case c <- raw:
		default: // page qui ne lit plus : on ne bloque pas le hook pour elle
		}
	}
}

func (l *Local) handleEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// On repond tout de suite : un hook ne doit jamais attendre apres nous.
	w.WriteHeader(http.StatusNoContent)

	var h Hook
	if json.Unmarshal(body, &h) != nil {
		return
	}
	// La page locale a droit au detail : rien ne quitte la machine par ce chemin.
	l.broadcast(string(body))

	ev := Sanitize(&h, l.machine, time.Now().UnixMilli())
	if ev == nil {
		return
	}
	l.state.Apply(ev)
	if l.fleet != nil {
		if b, err := json.Marshal(ev); err == nil {
			l.fleet.Publish(string(b))
		}
	}
}

func (l *Local) handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "flux non supporte", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": hello\n\n")
	fl.Flush()

	ch := make(chan string, 64)
	l.mu.Lock()
	l.clients[ch] = struct{}{}
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.clients, ch)
		l.mu.Unlock()
	}()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// La meteo est relayee au serveur de la flotte plutot que redemandee ici : c'est lui
// qui parle a Open-Meteo, et dupliquer ce code dans deux langages pour une tuile de
// ciel serait un mauvais marche. Hors ligne, la page sait deja se passer de meteo.
func (l *Local) handleWeather(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if l.server == "" {
		fmt.Fprint(w, `{"offline":true,"error":"aucun serveur de flotte configure"}`)
		return
	}
	base := strings.TrimSuffix(l.server, "/")
	base = strings.Replace(strings.Replace(base, "wss://", "https://", 1), "ws://", "http://", 1)
	c := &http.Client{Timeout: 8 * time.Second}
	resp, err := c.Get(base + "/weather?" + r.URL.RawQuery)
	if err != nil {
		fmt.Fprintf(w, `{"offline":true,"error":%q}`, err.Error())
		return
	}
	defer resp.Body.Close()
	io.Copy(w, io.LimitReader(resp.Body, 1<<20))
}

func (l *Local) handleUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if msg := l.usage.Message(); msg != "" {
		fmt.Fprint(w, msg)
		return
	}
	fmt.Fprint(w, `{"tokens":0,"messages":0,"elapsed":0}`)
}

// Diagnostic. C'est la premiere chose a regarder quand un poste n'apparait pas dans
// le bureau : elle dit si la liaison tient, et sinon pourquoi.
func (l *Local) handleStatus(w http.ResponseWriter, r *http.Request) {
	sessions, tasks := l.state.Count()
	out := map[string]any{
		"v": ProtocolVersion, "machine": l.machine,
		"sessions": sessions, "sous_agents": tasks,
		"vue_locale": l.page != "", "usage_local": l.usage.Available(),
	}
	if l.fleet == nil {
		out["flotte"] = "desactivee"
	} else {
		out["flotte"] = map[string]any{
			"en_ligne": l.fleet.Online(), "jetes": l.fleet.Dropped(),
			"derniere_erreur": l.fleet.LastError(),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (l *Local) handlePage(w http.ResponseWriter, r *http.Request) {
	if l.page == "" {
		http.Error(w, "vue locale desactivee : index.html introuvable (option -page)",
			http.StatusNotFound)
		return
	}
	http.ServeFile(w, r, l.page)
}

// Fichiers poses a cote d'index.html (logo.png, un son). Nom simple uniquement :
// pas de sous-dossier, pas de remontee de chemin.
func (l *Local) handleAsset(w http.ResponseWriter, r *http.Request) bool {
	if l.page == "" {
		return false
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return false
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".svg", ".webp", ".mp3", ".ogg", ".m4a", ".wav":
	default:
		return false
	}
	p := filepath.Join(filepath.Dir(l.page), name)
	if _, err := os.Stat(p); err != nil {
		return false
	}
	http.ServeFile(w, r, p)
	return true
}

func (l *Local) Serve(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		l.handleEvent(w, r)
	})
	mux.HandleFunc("/stream", l.handleStream)
	mux.HandleFunc("/weather", l.handleWeather)
	mux.HandleFunc("/usage", l.handleUsage)
	mux.HandleFunc("/status", l.handleStatus)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			l.handlePage(w, r)
			return
		}
		if l.handleAsset(w, r) {
			return
		}
		http.NotFound(w, r)
	})

	// 127.0.0.1 en dur : cet endpoint recoit des hooks bruts.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	return srv.Serve(ln)
}
