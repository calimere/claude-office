package main

// Le jumeau Go de protocol.js. C'est ici que s'arrete tout ce qui est confidentiel :
// l'evenement qui sort de cette fonction est le SEUL a franchir la carte reseau.
// Un champ ajoute ici est un champ qui part. Les deux fichiers doivent rester
// d'accord ; `go test ./...` compare la table des activites a celle de protocol.js.

import (
	"encoding/json"
	"strings"
)

const ProtocolVersion = 1

// Hook brut tel que Claude Code l'ecrit sur stdin du hook. Les deux champs
// imbriques sont lus en RawMessage : selon les versions et les outils, `tool_input`
// peut etre un objet, une chaine ou absent, et une seule surprise de ce genre ferait
// echouer le decodage de TOUT l'evenement.
type Hook struct {
	SessionID    string          `json:"session_id"`
	CWD          string          `json:"cwd"`
	Event        string          `json:"hook_event_name"`
	ToolName     string          `json:"tool_name"`
	ToolUseID    string          `json:"tool_use_id"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
	Prompt       string          `json:"prompt"`
	AgentID      string          `json:"agent_id"`
	DurationMs   *float64        `json:"duration_ms"`
	Background   []struct {
		Status string `json:"status"`
	} `json:"background_tasks"`
}

// Evenement du fil. Tous les champs optionnels sont `omitempty` : ce qui n'a pas
// lieu d'etre n'occupe pas d'octet, et la charge utile reste lisible a l'oeil nu
// quand on veut verifier ce qui sort.
type Event struct {
	V       int      `json:"v"`
	Type    string   `json:"type"`
	Machine string   `json:"machine"`
	Session string   `json:"session"`
	Project string   `json:"project,omitempty"`
	Event   string   `json:"event"`
	Act     string   `json:"act,omitempty"`
	Ref     string   `json:"ref,omitempty"`
	Agent   string   `json:"agent,omitempty"`
	AgentID string   `json:"agentId,omitempty"`
	Async   bool     `json:"async,omitempty"`
	Coffee  bool     `json:"coffee,omitempty"`
	BG      *int     `json:"bg,omitempty"`
	Ms      *float64 `json:"ms,omitempty"`
	TS      int64    `json:"ts"`
}

// Miroir exact de describe() dans index.html, moins les libelles. Si l'une des deux
// tables bouge, l'autre doit bouger : un outil range ici dans « term » et la dans
// « read » donnerait un ecran d'une couleur et une animation d'une autre.
func actOf(tool string) string {
	switch tool {
	case "Task", "Agent":
		return "task"
	case "Read", "NotebookRead":
		return "read"
	case "Glob", "Grep", "LS", "ToolSearch":
		return "read"
	case "Edit", "MultiEdit", "Write", "NotebookEdit":
		return "type"
	case "Bash", "PowerShell", "BashOutput", "KillShell", "Monitor":
		return "term"
	case "WebSearch", "WebFetch":
		return "web"
	case "TodoWrite", "TaskCreate", "TaskUpdate", "ExitPlanMode", "EnterPlanMode":
		return "plan"
	}
	// Un nom d'outil MCP porte le nom du serveur, donc celui d'un outil interne de
	// l'entreprise. Il ne sort pas : seule la categorie part.
	if strings.HasPrefix(tool, "mcp__") {
		return "web"
	}
	return "think"
}

// Dernier segment du chemin. Le chemin complet ne quitte jamais la machine.
func projectOf(cwd string) string {
	cwd = strings.TrimRight(cwd, `/\`)
	if i := strings.LastIndexAny(cwd, `/\`); i >= 0 {
		return cwd[i+1:]
	}
	return cwd
}

// « va boire un cafe » : evalue ICI, sur le poste. Seul un booleen part.
var coffeeCmds = map[string]bool{
	"cafe": true, "coffee": true, "pause": true, "break": true,
	"pause cafe": true, "coffee break": true, "un cafe": true,
	"va boire un cafe": true, "va prendre un cafe": true, "va au cafe": true,
	"go get coffee": true, "take a break": true, "fais une pause": true,
	"prends une pause": true, "prends un cafe": true,
}

// Repliement des accents. On n'a pas besoin d'une vraie normalisation Unicode pour
// quinze phrases connues : une table des lettres accentuees du francais suffit, et
// evite une dependance externe a un agent qui doit rester un seul fichier.
var deaccent = strings.NewReplacer(
	"à", "a", "á", "a", "â", "a", "ä", "a", "ã", "a", "å", "a",
	"è", "e", "é", "e", "ê", "e", "ë", "e",
	"ì", "i", "í", "i", "î", "i", "ï", "i",
	"ò", "o", "ó", "o", "ô", "o", "ö", "o", "õ", "o",
	"ù", "u", "ú", "u", "û", "u", "ü", "u",
	"ç", "c", "ñ", "n", "ÿ", "y",
)

func isCoffeeCmd(p string) bool {
	s := deaccent.Replace(strings.ToLower(p))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || r == ' ' {
			b.WriteRune(r)
		} else {
			b.WriteByte(' ')
		}
	}
	return coffeeCmds[strings.Join(strings.Fields(b.String()), " ")]
}

var forwarded = map[string]bool{
	"SessionStart": true, "UserPromptSubmit": true, "PreToolUse": true,
	"PostToolUse": true, "Notification": true, "SubagentStop": true,
	"Stop": true, "SessionEnd": true,
}

// Decodage indulgent d'un champ imbrique : si ce n'est pas un objet, on n'en tire
// rien plutot que de faire echouer l'evenement entier.
func field(raw json.RawMessage, key string) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

func boolField(raw json.RawMessage, key string) bool {
	if len(raw) == 0 {
		return false
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	b, _ := m[key].(bool)
	return b
}

// Reduit un hook brut a ce qui a le droit de partir. Rend nil pour tout ce qu'on ne
// transmet pas : un hook inconnu n'ouvre pas une breche par defaut.
func Sanitize(h *Hook, machine string, now int64) *Event {
	if !forwarded[h.Event] || h.SessionID == "" {
		return nil
	}
	sess := h.SessionID
	if len(sess) > 8 {
		sess = sess[:8]
	}
	e := &Event{
		V: ProtocolVersion, Type: "event", Machine: machine,
		Session: sess, Event: h.Event, TS: now,
	}
	e.Project = projectOf(h.CWD)

	// Les commandes shell encore en cours allument les LED de la baie serveurs.
	// On n'envoie que leur NOMBRE, jamais les commandes.
	if h.Background != nil {
		n := 0
		for _, t := range h.Background {
			if t.Status == "running" {
				n++
			}
		}
		e.BG = &n
	}

	switch h.Event {
	case "UserPromptSubmit":
		// Le prompt ne part pas. Seul « il demandait une pause » part.
		e.Coffee = isCoffeeCmd(h.Prompt)
		return e
	case "Notification":
		// Le message contient la demande de permission : il reste ici.
		return e
	case "SubagentStop":
		e.AgentID = h.AgentID
		return e
	case "PreToolUse", "PostToolUse":
		e.Act = actOf(h.ToolName)
		e.Ref = h.ToolUseID
		if e.Act == "task" {
			// Le METIER de l'agent delegue part : c'est lui qui peuple l'open space.
			// Sa `description` est le resume de la tache : elle reste sur le poste.
			e.Agent = field(h.ToolInput, "subagent_type")
			if boolField(h.ToolResponse, "isAsync") || field(h.ToolResponse, "status") == "async_launched" {
				e.Async = true
				e.AgentID = field(h.ToolResponse, "agentId")
			}
		} else if h.Event == "PostToolUse" {
			e.Ms = h.DurationMs
		}
		return e
	}
	return e // SessionStart, Stop, SessionEnd : rien de plus que l'identite
}
