package main

// La consommation du bloc de 5 h, lue dans les transcripts locaux.
//
// On n'extrait de chaque ligne QUE deux choses : l'horodatage et le bloc `usage`.
// Le contenu des messages n'est jamais decode, jamais retenu, jamais envoye. Ce qui
// part vers le serveur, ce sont quatre nombres.

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	usageWindow = 5 * time.Hour
	// On garde plus que la duree d'un bloc : pour savoir OU commence le bloc
	// courant, il faut pouvoir remonter au message qui l'a ouvert, et il peut
	// dater de presque cinq heures.
	usageKeep = 12 * time.Hour
)

type sample struct {
	t   int64
	tok int64
}

type Usage struct {
	mu      sync.Mutex
	root    string
	seen    map[string]int64 // fichier -> octets deja lus
	samples []sample
	ok      bool
}

func NewUsage() *Usage {
	home, err := os.UserHomeDir()
	if err != nil {
		return &Usage{}
	}
	root := filepath.Join(home, ".claude", "projects")
	st, err := os.Stat(root)
	if err != nil || !st.IsDir() {
		return &Usage{}
	}
	return &Usage{root: root, seen: map[string]int64{}, ok: true}
}

func (u *Usage) Available() bool { return u.ok }

// Seules ces deux cles sont decodees. Tout le reste de la ligne est ignore par le
// decodeur : le texte des messages ne passe jamais par une variable de ce programme.
type transcriptLine struct {
	Timestamp string `json:"timestamp"`
	Message   struct {
		Usage *struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func (u *Usage) scan() {
	cut := time.Now().Add(-usageKeep)
	var files []string
	filepath.WalkDir(u.root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // un dossier illisible ne doit pas arreter le parcours
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".jsonl") {
			files = append(files, p)
		}
		return nil
	})

	for _, p := range files {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		if st.ModTime().Before(cut) {
			delete(u.seen, p)
			continue
		}
		off := u.seen[p]
		if st.Size() < off {
			off = 0 // fichier reecrit : on repart du debut
		}
		if st.Size() == off {
			continue // rien de neuf
		}
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		if _, err := f.Seek(off, 0); err != nil {
			f.Close()
			continue
		}
		// Un transcript est un journal en ajout seul : on ne relit que ce qui s'est
		// ecrit depuis le dernier passage, et on s'arrete a la derniere ligne
		// COMPLETE — la suivante est peut-etre en cours d'ecriture.
		r := bufio.NewReader(f)
		read := off
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				break // ligne incomplete : ce sera pour le prochain tour
			}
			read += int64(len(line))
			var tl transcriptLine
			if json.Unmarshal(line, &tl) != nil || tl.Message.Usage == nil {
				continue
			}
			ts, err := time.Parse(time.RFC3339, tl.Timestamp)
			if err != nil {
				continue
			}
			// Le cache_read n'est pas compte : il represente le contexte relu,
			// pas le travail.
			us := tl.Message.Usage
			u.samples = append(u.samples, sample{ts.UnixMilli(), us.Input + us.Output + us.CacheWrite})
		}
		f.Close()
		u.seen[p] = read
	}

	cutMs := cut.UnixMilli()
	keep := u.samples[:0]
	for _, s := range u.samples {
		if s.t >= cutMs {
			keep = append(keep, s)
		}
	}
	u.samples = keep
	sort.Slice(u.samples, func(i, j int) bool { return u.samples[i].t < u.samples[j].t })
}

// Le bloc de 5 h est ANCRE, pas glissant : il s'ouvre a un message et dure cinq
// heures, puis le message suivant en ouvre un neuf. Une fenetre glissante donnerait
// un indicateur colle a 100 % des qu'on travaille plus de cinq heures d'affilee.
func (u *Usage) Message() string {
	if !u.ok {
		return ""
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.scan()

	now := time.Now().UnixMilli()
	win := usageWindow.Milliseconds()
	start := now
	if len(u.samples) > 0 {
		start = u.samples[0].t
		for _, s := range u.samples {
			if s.t >= start+win {
				start = s.t // ce message ouvre un bloc neuf
			}
		}
	}
	// Bloc arrive a terme sans qu'un nouveau message l'ait relance : on est a zero
	// d'un bloc qui n'a pas encore commence, pas a 100 % d'un bloc fini.
	if now >= start+win {
		start = now
	}
	var tokens, msgs int64
	for _, s := range u.samples {
		if s.t >= start && s.t < start+win {
			tokens += s.tok
			msgs++
		}
	}
	elapsed := float64(now-start) / float64(win)
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed > 1 {
		elapsed = 1
	}
	b, _ := json.Marshal(map[string]any{
		"v": ProtocolVersion, "type": "usage",
		"tokens": tokens, "messages": msgs,
		"blockStart": start, "blockEnd": start + win, "elapsed": elapsed,
	})
	return string(b)
}
