//! Agents the user defines.
//!
//! The six that ship with Aira are compiled in. This is the other half: a file
//! the user adds to, so the fleet stops being a fixed cast and becomes
//! something they staff. A tax agent, a lab-notebook agent, an agent that knows
//! one codebase — none of which Aira could have guessed at.
//!
//! Two rules hold the whole design together.
//!
//! **A custom agent can never out-grant a built-in one.** The denylist still
//! outranks everything, and on top of it a custom agent may only ask for tools
//! from `GRANTABLE`, which deliberately excludes the delegation tools. A user
//! who could grant `sessions_send` would have created a second lead able to
//! dispatch work to the rest of the fleet — and a board that shows one agent
//! running while three others were quietly set going is worse than no board.
//!
//! **A broken file loses the custom agents, never the built-in ones.** The six
//! live in the binary and are merged over whatever loads, so the worst a
//! malformed or hand-edited file can do is leave the user where they started.

use serde::{Deserialize, Serialize};

/// What a custom agent is allowed to ask for.
///
/// The read-only half of the fleet's vocabulary. Everything omitted is omitted
/// on purpose: the delegation tools (`sessions_send`, `agents_list`,
/// `sessions_list`, `sessions_history`) belong to the lead alone, and anything
/// that writes or executes is on the denylist for every agent regardless.
pub const GRANTABLE: &[&str] = &[
    "read", "ls", "dir_list",
    "web_search", "web_fetch", "browser",
    "memory_search", "memory_get",
];

/// Tiers a custom agent may choose between — the same three the router knows.
pub const TIERS: &[&str] = &["frontier", "balanced", "fast"];

/// How many an install may hold, on top of the built-in six.
///
/// A fleet is a team, not a directory. Past a dozen or so nobody remembers who
/// does what, every board becomes a wall of cards, and a task fanned out to all
/// of them costs more than it returns.
pub const MAX_CUSTOM: usize = 12;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The agent's standing instructions, written into its AGENTS.md.
    pub brief: String,
    pub tier: String,
    pub tools: Vec<String>,
}

fn agents_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".aira");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("agents.json"))
}

/// Ids that cannot be taken, because the runtime or the board already means
/// something by them.
fn reserved(id: &str) -> bool {
    matches!(id, "lead" | "research" | "plan" | "write" | "review" | "analyse" | "default" | "openclaw")
}

/// Checks one agent, returning the first reason it cannot be used.
///
/// Returns a message written for the person who typed it, not a code: this runs
/// behind a form, and "id must match ^[a-z][a-z0-9-]{1,23}$" helps nobody.
pub fn validate(agent: &CustomAgent, existing: &[CustomAgent]) -> Result<(), String> {
    let id = agent.id.trim();
    if id.is_empty() {
        return Err("Give the agent a short id, like \"tax\" or \"lab-notes\".".into());
    }
    if !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || !id.starts_with(|c: char| c.is_ascii_lowercase())
    {
        return Err("The id can use lowercase letters, digits and dashes, and must start with a letter.".into());
    }
    if id.len() > 24 {
        return Err("The id is too long — keep it under 24 characters.".into());
    }
    if reserved(id) {
        return Err(format!("\"{id}\" is one of Aira's own agents. Pick another id."));
    }
    if existing.iter().any(|a| a.id == id) {
        return Err(format!("You already have an agent called \"{id}\"."));
    }
    if agent.name.trim().is_empty() {
        return Err("Give the agent a display name.".into());
    }
    if agent.name.len() > 40 {
        return Err("The name is too long for a card — keep it under 40 characters.".into());
    }
    if agent.brief.trim().len() < 20 {
        return Err("Write a brief. An agent with no instructions just answers like any other.".into());
    }
    if agent.brief.len() > 4_000 {
        return Err("The brief is too long — keep it under 4000 characters.".into());
    }
    if !TIERS.contains(&agent.tier.as_str()) {
        return Err(format!("Tier must be one of {}.", TIERS.join(", ")));
    }
    // The security check. Everything outside GRANTABLE is either a delegation
    // power that belongs to the lead or something on the denylist.
    if let Some(bad) = agent.tools.iter().find(|t| !GRANTABLE.contains(&t.as_str())) {
        return Err(format!(
            "\"{bad}\" cannot be granted to a custom agent. Available: {}.",
            GRANTABLE.join(", ")
        ));
    }
    Ok(())
}

/// Reads the user's agents.
///
/// A file that will not parse yields none, rather than failing the caller. The
/// built-in fleet is merged over this, so a broken file costs the user their
/// custom agents and never the six Aira ships.
pub fn load() -> Vec<CustomAgent> {
    let Ok(path) = agents_path() else { return Vec::new() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return Vec::new() };
    let parsed: Vec<CustomAgent> = serde_json::from_str(&raw).unwrap_or_default();
    // Re-validated on the way in. The file is editable by hand, so what was
    // legal when it was written is not proof it is legal now — and a tool that
    // moved onto the denylist since must not survive in someone's saved fleet.
    let mut kept: Vec<CustomAgent> = Vec::new();
    for agent in parsed.into_iter().take(MAX_CUSTOM) {
        if validate(&agent, &kept).is_ok() {
            kept.push(agent);
        }
    }
    kept
}

fn write(agents: &[CustomAgent]) -> Result<(), String> {
    let path = agents_path()?;
    let body = serde_json::to_string_pretty(agents).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

pub fn add(agent: CustomAgent) -> Result<Vec<CustomAgent>, String> {
    let mut agents = load();
    if agents.len() >= MAX_CUSTOM {
        return Err(format!("You can have up to {MAX_CUSTOM} of your own agents. Remove one first."));
    }
    validate(&agent, &agents)?;
    agents.push(agent);
    write(&agents)?;
    Ok(agents)
}

pub fn remove(id: &str) -> Result<Vec<CustomAgent>, String> {
    let agents: Vec<CustomAgent> = load().into_iter().filter(|a| a.id != id).collect();
    write(&agents)?;
    Ok(agents)
}

/// What the panel needs to draw the editor and what is already configured.
#[derive(Serialize)]
pub struct FleetOptions {
    /// Every member, Aira's and the user's, with `custom` saying which is which.
    pub members: Vec<crate::openclaw::Member>,
    pub grantable: Vec<String>,
    pub tiers: Vec<String>,
    pub max_custom: usize,
    pub used: usize,
}

#[tauri::command]
pub fn fleet_list() -> FleetOptions {
    let custom = load();
    FleetOptions {
        members: crate::openclaw::fleet(),
        grantable: GRANTABLE.iter().map(|t| t.to_string()).collect(),
        tiers: TIERS.iter().map(|t| t.to_string()).collect(),
        max_custom: MAX_CUSTOM,
        used: custom.len(),
    }
}

/// Adds an agent, or explains why it cannot be added.
///
/// The error is the one from `validate`, written for the person at the form.
/// Nothing is written to disk unless the agent passed.
#[tauri::command]
pub fn fleet_add(agent: CustomAgent) -> Result<FleetOptions, String> {
    add(agent)?;
    Ok(fleet_list())
}

#[tauri::command]
pub fn fleet_remove(id: String) -> Result<FleetOptions, String> {
    remove(&id)?;
    Ok(fleet_list())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CustomAgent {
        CustomAgent {
            id: "tax".into(),
            name: "Tax".into(),
            description: "Answers questions about our filings.".into(),
            brief: "You answer questions about company tax filings, citing the year.".into(),
            tier: "balanced".into(),
            tools: vec!["read".into(), "memory_search".into()],
        }
    }

    #[test]
    fn a_reasonable_agent_is_accepted() {
        assert!(validate(&sample(), &[]).is_ok());
    }

    #[test]
    fn delegation_tools_cannot_be_granted() {
        // The security boundary: a custom agent holding sessions_send would be
        // a second lead, able to set the rest of the fleet going with nothing
        // on the board to show it.
        for tool in ["sessions_send", "agents_list", "sessions_list", "sessions_history"] {
            let mut agent = sample();
            agent.tools = vec![tool.into()];
            let error = validate(&agent, &[]).unwrap_err();
            assert!(error.contains(tool), "{tool} should be refused, got: {error}");
        }
    }

    #[test]
    fn denied_tools_cannot_be_granted_either() {
        for tool in ["exec", "file_write", "secrets", "sessions_spawn"] {
            let mut agent = sample();
            agent.tools = vec![tool.into()];
            assert!(validate(&agent, &[]).is_err(), "{tool} must be refused");
        }
    }

    #[test]
    fn nothing_grantable_is_on_the_denylist() {
        // The two lists are maintained separately; this is what keeps them from
        // drifting into contradicting each other.
        for tool in GRANTABLE {
            assert!(
                !crate::openclaw::DENIED_TOOLS.contains(tool),
                "{tool} is both grantable and denied"
            );
        }
    }

    #[test]
    fn a_built_in_id_cannot_be_taken() {
        let mut agent = sample();
        agent.id = "research".into();
        assert!(validate(&agent, &[]).unwrap_err().contains("Aira's own"));
    }

    #[test]
    fn ids_are_checked_for_shape_and_collisions() {
        let mut agent = sample();
        agent.id = "Tax Agent".into();
        assert!(validate(&agent, &[]).is_err(), "spaces and capitals are out");
        agent.id = "9lives".into();
        assert!(validate(&agent, &[]).is_err(), "must start with a letter");
        agent.id = "tax".into();
        assert!(validate(&agent, &[sample()]).unwrap_err().contains("already have"));
    }

    #[test]
    fn an_agent_without_instructions_is_refused() {
        let mut agent = sample();
        agent.brief = "do stuff".into();
        assert!(validate(&agent, &[]).unwrap_err().contains("brief"));
    }

    #[test]
    fn the_tier_has_to_be_one_the_router_knows() {
        let mut agent = sample();
        agent.tier = "strongest".into();
        assert!(validate(&agent, &[]).is_err());
    }
}
