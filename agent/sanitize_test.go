package main

// Le test qui compte : aucun contenu ne doit franchir Sanitize. Une regression ici
// ne casse rien de visible — elle envoie les prompts de l'equipe sur le reseau.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRienDeConfidentielNePasse(t *testing.T) {
	secrets := []string{
		"rm -rf /srv/prod", "refacto du module de paie", "salaires.xlsx",
		"client-confidentiel", "Atlassian_MCP", "resume de la tache secrete",
		"git push --force",
	}
	hooks := []string{
		`{"hook_event_name":"UserPromptSubmit","session_id":"aaaabbbb-1111",
		  "cwd":"C:\\dev\\client-confidentiel\\paie","prompt":"refacto du module de paie"}`,
		`{"hook_event_name":"PreToolUse","session_id":"aaaabbbb-1111","cwd":"/srv/prod/app",
		  "tool_name":"Bash","tool_input":{"command":"rm -rf /srv/prod"},"tool_use_id":"x1"}`,
		`{"hook_event_name":"PreToolUse","session_id":"aaaabbbb-1111",
		  "tool_name":"Read","tool_input":{"file_path":"/home/rh/salaires.xlsx"}}`,
		`{"hook_event_name":"PreToolUse","session_id":"aaaabbbb-1111",
		  "tool_name":"mcp__claude_ai_Atlassian_MCP__getJiraIssue","tool_input":{"issue":"SEC-1"}}`,
		`{"hook_event_name":"PreToolUse","session_id":"aaaabbbb-1111","tool_name":"Agent",
		  "tool_input":{"subagent_type":"Explore","description":"resume de la tache secrete"},
		  "tool_use_id":"x3"}`,
		`{"hook_event_name":"Notification","session_id":"aaaabbbb-1111",
		  "message":"Claude a besoin de ta permission pour git push --force"}`,
	}

	var out strings.Builder
	for _, raw := range hooks {
		var h Hook
		if err := json.Unmarshal([]byte(raw), &h); err != nil {
			t.Fatalf("hook indecodable : %v", err)
		}
		ev := Sanitize(&h, "poste-1", 1700000000000)
		if ev == nil {
			t.Fatalf("hook non transmis alors qu'il devrait l'etre : %s", raw)
		}
		b, _ := json.Marshal(ev)
		out.Write(b)
	}
	got := out.String()
	for _, s := range secrets {
		if strings.Contains(got, s) {
			t.Errorf("« %s » a franchi l'assainisseur :\n%s", s, got)
		}
	}
	if !strings.Contains(got, `"project":"paie"`) {
		t.Errorf("le nom du projet devrait passer, lui :\n%s", got)
	}
	if !strings.Contains(got, `"agent":"Explore"`) {
		t.Errorf("le metier de l'agent delegue devrait passer :\n%s", got)
	}
}

func TestActivites(t *testing.T) {
	// Doit rester le miroir de describe() dans index.html et de actOf() dans
	// protocol.js. smoke-serveur.mjs verifie l'autre moitie de cette table.
	cas := map[string]string{
		"Read": "read", "Grep": "read", "Glob": "read",
		"Write": "type", "Edit": "type", "NotebookEdit": "type",
		"Bash": "term", "PowerShell": "term",
		"WebFetch": "web", "WebSearch": "web",
		"TodoWrite": "plan", "Agent": "task", "Task": "task",
		"mcp__serveur__outil": "web", "TrucInconnu": "think",
	}
	for tool, want := range cas {
		if got := actOf(tool); got != want {
			t.Errorf("actOf(%q) = %q, attendu %q", tool, got, want)
		}
	}
}

func TestProjet(t *testing.T) {
	cas := map[string]string{
		`C:\dev\gitlab-rd\protrack`: "protrack",
		"/home/x/mon-projet/":       "mon-projet",
		"/home/x/mon-projet":        "mon-projet",
		"protrack":                  "protrack",
		"":                          "",
	}
	for in, want := range cas {
		if got := projectOf(in); got != want {
			t.Errorf("projectOf(%q) = %q, attendu %q", in, got, want)
		}
	}
}

func TestCafe(t *testing.T) {
	// La phrase doit se reduire EXACTEMENT a une commande connue, sinon une demande
	// qui *parle* de cafe enverrait le lead au bar.
	oui := []string{"café", "va boire un café", "Pause Café", "take a break", "coffee"}
	non := []string{"ajoute un bouton café", "fais une pause dans le code", "cafeteria"}
	for _, s := range oui {
		if !isCoffeeCmd(s) {
			t.Errorf("« %s » devrait etre une pause", s)
		}
	}
	for _, s := range non {
		if isCoffeeCmd(s) {
			t.Errorf("« %s » ne devrait PAS etre une pause", s)
		}
	}
}

func TestHookDeforme(t *testing.T) {
	// tool_input peut arriver en chaine plutot qu'en objet selon l'outil. Une seule
	// surprise de ce genre ne doit pas faire echouer l'evenement entier.
	raw := `{"hook_event_name":"PreToolUse","session_id":"abcd1234","tool_name":"Agent",
	         "tool_input":"pas un objet","tool_use_id":"x"}`
	var h Hook
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		t.Fatalf("un tool_input en chaine casse le decodage : %v", err)
	}
	ev := Sanitize(&h, "p", 1)
	if ev == nil || ev.Act != "task" {
		t.Fatalf("evenement perdu sur un tool_input inattendu : %+v", ev)
	}
}

func TestHookInconnuNePassePas(t *testing.T) {
	// Un Hook neuf a chaque fois : json.Unmarshal ne remet pas a zero les champs
	// absents de la charge utile, et un struct recycle garderait la session du
	// hook precedent.
	var a Hook
	json.Unmarshal([]byte(`{"hook_event_name":"QuelqueChoseDeNeuf","session_id":"a"}`), &a)
	if Sanitize(&a, "p", 1) != nil {
		t.Error("un hook inconnu ne doit pas etre relaye par defaut")
	}
	var b Hook
	json.Unmarshal([]byte(`{"hook_event_name":"Stop"}`), &b)
	if Sanitize(&b, "p", 1) != nil {
		t.Error("un evenement sans session doit etre refuse")
	}
}

func TestEtatSuitLesMissions(t *testing.T) {
	st := NewState()
	ap := func(raw string) {
		var h Hook
		json.Unmarshal([]byte(raw), &h)
		if ev := Sanitize(&h, "p", 1); ev != nil {
			st.Apply(ev)
		}
	}
	ap(`{"hook_event_name":"SessionStart","session_id":"sess0001","cwd":"/x/proj"}`)
	ap(`{"hook_event_name":"PreToolUse","session_id":"sess0001","tool_name":"Agent",
	     "tool_input":{"subagent_type":"Explore"},"tool_use_id":"t1"}`)
	if s, tk := st.Count(); s != 1 || tk != 1 {
		t.Fatalf("attendu 1 session / 1 mission, obtenu %d / %d", s, tk)
	}
	// Lancement asynchrone : la mission continue, on retient l'agentId.
	ap(`{"hook_event_name":"PostToolUse","session_id":"sess0001","tool_name":"Agent",
	     "tool_use_id":"t1","tool_response":{"isAsync":true,"agentId":"ag1"}}`)
	if _, tk := st.Count(); tk != 1 {
		t.Fatal("un lancement asynchrone ne termine pas la mission")
	}
	// C'est SubagentStop qui la termine.
	ap(`{"hook_event_name":"SubagentStop","session_id":"sess0001","agent_id":"ag1"}`)
	if _, tk := st.Count(); tk != 0 {
		t.Fatal("SubagentStop devrait liberer le bureau")
	}
	ap(`{"hook_event_name":"SessionEnd","session_id":"sess0001"}`)
	if s, _ := st.Count(); s != 0 {
		t.Fatal("SessionEnd devrait fermer la session")
	}
}

func TestInstantaneEstDuJSONValide(t *testing.T) {
	st := NewState()
	var h Hook
	json.Unmarshal([]byte(`{"hook_event_name":"PreToolUse","session_id":"sess0001",
	  "cwd":"/x/proj","tool_name":"Agent","tool_input":{"subagent_type":"Plan"},
	  "tool_use_id":"t1"}`), &h)
	st.Apply(Sanitize(&h, "poste-1", 1))

	var snap Snapshot
	if err := json.Unmarshal([]byte(st.Snapshot("poste-1")), &snap); err != nil {
		t.Fatalf("instantane invalide : %v", err)
	}
	if snap.Type != "snapshot" || snap.Machine != "poste-1" || len(snap.Sessions) != 1 {
		t.Fatalf("instantane inattendu : %+v", snap)
	}
	if len(snap.Sessions[0].Tasks) != 1 || snap.Sessions[0].Tasks[0].Agent != "Plan" {
		t.Fatalf("mission absente de l'instantane : %+v", snap.Sessions[0])
	}
}

func TestNomDePosteNettoye(t *testing.T) {
	// Le point reste : le serveur l'accepte, et un nom de poste n'est jamais
	// utilise comme chemin — ni cote agent, ni cote serveur, ou il ne sert que de
	// cle de table et d'etiquette d'ilot. Seuls les separateurs sont neutralises.
	cas := map[string]string{
		"REMY-PC":               "REMY-PC",
		"poste/../etc":          "poste-..-etc",
		`poste\..\etc`:          "poste-..-etc",
		"bureau rémy":           "bureau r-my",
		strings.Repeat("a", 50): strings.Repeat("a", 32),
	}
	for in, want := range cas {
		if got := cleanName(in); got != want {
			t.Errorf("cleanName(%q) = %q, attendu %q", in, got, want)
		}
	}
}
