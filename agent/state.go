package main

// Ce que le poste croit savoir de ses propres sessions. Sert a une seule chose :
// fabriquer l'instantane envoye toutes les dix secondes. C'est lui qui repare un
// evenement perdu sur le reseau — sans quoi un sous-agent dont le PostToolUse s'est
// egare resterait assis a son bureau pour l'eternite, cote serveur.
//
// Rien de tout cela n'est ecrit sur disque : l'agent redemarre, il repart de rien,
// et le serveur en deduit que le poste n'a plus de session ouverte.

import (
	"encoding/json"
	"sync"
	"time"
)

type task struct {
	Ref     string `json:"ref"`
	Agent   string `json:"agent"`
	AgentID string `json:"agentId,omitempty"`
}

type session struct {
	Session string           `json:"session"`
	Project string           `json:"project"`
	Tasks   map[string]*task `json:"-"`
	seen    time.Time
}

type snapSession struct {
	Session string  `json:"session"`
	Project string  `json:"project"`
	Tasks   []*task `json:"tasks"`
}

type Snapshot struct {
	V        int            `json:"v"`
	Type     string         `json:"type"`
	Machine  string         `json:"machine"`
	Sessions []*snapSession `json:"sessions"`
}

// Une session sans le moindre signe de vie depuis ce delai est oubliee : Claude Code
// n'emet pas toujours SessionEnd (fermeture brutale du terminal, machine en veille).
const sessionTTL = 12 * time.Hour

type State struct {
	mu       sync.Mutex
	sessions map[string]*session
}

func NewState() *State { return &State{sessions: map[string]*session{}} }

func (s *State) Apply(e *Event) {
	if e == nil || e.Session == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if e.Event == "SessionEnd" {
		delete(s.sessions, e.Session)
		return
	}
	cur, ok := s.sessions[e.Session]
	if !ok {
		cur = &session{Session: e.Session, Project: e.Project, Tasks: map[string]*task{}}
		s.sessions[e.Session] = cur
	}
	if e.Project != "" {
		cur.Project = e.Project
	}
	cur.seen = time.Now()

	if e.Act == "task" && e.Ref != "" {
		switch e.Event {
		case "PreToolUse":
			agent := e.Agent
			if agent == "" {
				agent = "agent"
			}
			cur.Tasks[e.Ref] = &task{Ref: e.Ref, Agent: agent}
		case "PostToolUse":
			// Lancement asynchrone : l'appel rend la main mais l'agent commence
			// seulement. On retient son identite pour reconnaitre son vrai
			// SubagentStop, qui seul marque la fin de la mission.
			if e.Async {
				if t, ok := cur.Tasks[e.Ref]; ok {
					t.AgentID = e.AgentID
				}
			} else {
				delete(cur.Tasks, e.Ref)
			}
		}
	}
	if e.Event == "SubagentStop" && e.AgentID != "" {
		for ref, t := range cur.Tasks {
			if t.AgentID == e.AgentID {
				delete(cur.Tasks, ref)
			}
		}
	}

	cut := time.Now().Add(-sessionTTL)
	for k, v := range s.sessions {
		if v.seen.Before(cut) {
			delete(s.sessions, k)
		}
	}
}

func (s *State) Snapshot(machine string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	snap := Snapshot{V: ProtocolVersion, Type: "snapshot", Machine: machine,
		Sessions: make([]*snapSession, 0, len(s.sessions))}
	for _, v := range s.sessions {
		ss := &snapSession{Session: v.Session, Project: v.Project, Tasks: make([]*task, 0, len(v.Tasks))}
		for _, t := range v.Tasks {
			ss.Tasks = append(ss.Tasks, t)
		}
		snap.Sessions = append(snap.Sessions, ss)
	}
	b, _ := json.Marshal(snap)
	return string(b)
}

func (s *State) Count() (sessions, tasks int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range s.sessions {
		sessions++
		tasks += len(v.Tasks)
	}
	return
}
