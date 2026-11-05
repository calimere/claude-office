// Claude Office — le contrat entre l'agent d'un poste et le serveur de la flotte.
//
// C'est le fichier le plus important du depot. Tout ce qui n'est PAS decrit ici ne
// quitte jamais la machine : ni prompt, ni commande shell, ni nom de fichier, ni
// chemin, ni nom de serveur MCP, ni libelle de tache. Un champ ajoute ici est un
// champ qui part sur le reseau — on ne l'ajoute pas sans y avoir reflechi deux fois.
//
// Ce fichier a un jumeau en Go dans agent/. Les deux doivent rester d'accord ;
// smoke.mjs verifie la table des activites.

const PROTOCOL_VERSION = 1;

// Le vocabulaire est celui que la page parle DEJA (voir describe() dans index.html) :
// on envoie l'activite, jamais son libelle. Resultat : les ecrans gardent exactement
// les memes couleurs qu'en mode local, sans qu'une seule ligne de contenu transite.
// 'task' s'y ajoute pour la delegation, que describe() traite a part.
const ACTS = ['read', 'type', 'term', 'web', 'plan', 'think', 'task'];

// Miroir exact de describe(), moins les libelles. Si l'une des deux tables bouge,
// l'autre doit bouger : un outil range ici dans 'term' et la dans 'read' donnerait
// un ecran d'une couleur et une animation d'une autre.
function actOf(toolName = '') {
  const n = String(toolName);
  if (n === 'Task' || n === 'Agent') return 'task';
  if (n === 'Read' || n === 'NotebookRead') return 'read';
  if (/^(Glob|Grep|LS|ToolSearch)$/.test(n)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(n)) return 'type';
  if (/^(Bash|PowerShell|BashOutput|KillShell|Monitor)$/.test(n)) return 'term';
  if (/^Web(Search|Fetch)$/.test(n)) return 'web';
  if (/^(TodoWrite|TaskCreate|TaskUpdate|ExitPlanMode|EnterPlanMode)$/.test(n)) return 'plan';
  // Un nom d'outil MCP porte le nom du serveur (mcp__claude_ai_Atlassian_MCP__...),
  // donc le nom d'un outil interne de l'entreprise. Il ne sort pas : seule la
  // categorie part, et c'est celle que la page donne deja aux MCP.
  if (n.startsWith('mcp__')) return 'web';
  return 'think';
}

// Dernier segment du chemin, calcule SUR LE POSTE. Le chemin complet
// (C:\dev\gitlab-rd\protrack\...) ne quitte jamais la machine ; seul « protrack » part.
function projectOf(cwd = '') {
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// « va boire un cafe » tape dans une session : la page sait en faire une pause au
// mange-debout. On evalue la phrase ICI, sur le poste, et on n'envoie qu'un booleen —
// la fonctionnalite survit sans qu'un seul prompt ne parte.
const COFFEE_CMDS = new Set([
  'cafe', 'coffee', 'pause', 'break', 'pause cafe', 'coffee break', 'un cafe',
  'va boire un cafe', 'va prendre un cafe', 'va au cafe', 'go get coffee',
  'take a break', 'fais une pause', 'prends une pause', 'prends un cafe',
]);
const isCoffeeCmd = (p) => COFFEE_CMDS.has(String(p ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim());

const FORWARDED = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'SubagentStop', 'Stop', 'SessionEnd']);

// Reduit un evenement de hook brut a ce qui a le droit de partir. Rend null pour
// tout ce qu'on ne transmet pas — un hook inconnu n'ouvre pas une breche par defaut.
function sanitize(hook = {}, machine = '') {
  const event = hook.hook_event_name;
  if (!FORWARDED.has(event) || !hook.session_id) return null;

  const out = {
    v: PROTOCOL_VERSION,
    machine,
    session: String(hook.session_id).slice(0, 8),
    event,
    ts: hook._ts || Date.now(),
  };
  const project = projectOf(hook.cwd);
  if (project) out.project = project;

  // Les commandes shell lancees en arriere-plan allument les LED de la baie serveurs.
  // On n'envoie que le NOMBRE de commandes encore en cours, jamais les commandes.
  if (Array.isArray(hook.background_tasks)) {
    out.bg = hook.background_tasks.filter((t) => t && t.status === 'running').length;
  }

  if (event === 'UserPromptSubmit') {
    // Le prompt ne part pas. Seul le fait qu'il demandait une pause cafe part.
    if (isCoffeeCmd(hook.prompt)) out.coffee = true;
    return out;
  }

  if (event === 'Notification') return out; // le message contient la demande : il reste ici

  if (event === 'SubagentStop') {
    if (hook.agent_id) out.agentId = hook.agent_id;
    return out;
  }

  if (event === 'PreToolUse' || event === 'PostToolUse') {
    out.act = actOf(hook.tool_name);
    if (hook.tool_use_id) out.ref = hook.tool_use_id;
    if (out.act === 'task') {
      // Le METIER de l'agent delegue part (Explore, Plan, redacteur-livrables...) :
      // c'est lui qui peuple l'open space, et c'est le propos de la piece. Sa
      // `description`, elle, est le resume de la tache : elle reste sur le poste.
      const type = hook.tool_input && hook.tool_input.subagent_type;
      if (type) out.agent = String(type);
      const r = hook.tool_response || {};
      if (r.isAsync || r.status === 'async_launched') {
        out.async = true;
        if (r.agentId) out.agentId = r.agentId;
      }
    } else if (event === 'PostToolUse' && Number.isFinite(hook.duration_ms)) {
      out.ms = hook.duration_ms; // alimente « l'outil le plus lent » : un nombre, pas un nom
    }
    return out;
  }

  return out; // SessionStart, Stop, SessionEnd : rien de plus que l'identite
}

module.exports = { PROTOCOL_VERSION, ACTS, actOf, projectOf, isCoffeeCmd, sanitize, FORWARDED };
