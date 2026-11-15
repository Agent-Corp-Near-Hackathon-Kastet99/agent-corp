/**
 * Kanban seed for the hackathon demo. Only work that was really requested for this repo.
 * `done` means the deliverable exists in the repository (evidence path in `result`); everything
 * else stays To Do. Token figures are `null` ("Not metered") because no usage meter recorded them.
 */
export type Department = "marketing" | "product" | "self-improvement" | "research-ops";
export type KanbanStatus = "todo" | "in-progress" | "done";
export type KanbanTask = {
  id: string; title: string; description: string; department: Department; agent: string; status: KanbanStatus;
  /** null = never metered; shown as "Not metered", never as zero. */
  budgetTokens: number | null; usedTokens: number | null;
  result?: string; links: { label: string; url: string }[];
  /** Pipeline stage label while a job is running or after it failed. */
  stage?: string; failed?: string; source: "repo" | "job" | "worker";
};
export const DEPARTMENTS: { id: Department; label: string }[] = [
  { id: "marketing", label: "Marketing & Growth" }, { id: "product", label: "Product Development" },
  { id: "self-improvement", label: "Self-Improvement" }, { id: "research-ops", label: "Research / Operations" },
];
export const LAUNCH_POST_TASK = "marketing-launch-post";
const repo = (department: Department, id: string, title: string, description: string, agent: string, status: KanbanStatus, result?: string): KanbanTask =>
  ({ id, title, description, department, agent, status, budgetTokens: null, usedTokens: null, result, links: [], source: "repo" });

export function seedTasks(): KanbanTask[] {
  return [
    { id: LAUNCH_POST_TASK, title: "Generate and Publish Game Launch Post", description: "Write a launch post for Sam Alt-Ram and publish it to X using newly connected AI resources.", department: "marketing", agent: "Marketing Agent", status: "todo", budgetTokens: 2000, usedTokens: null, links: [], source: "job" },
    repo("marketing", "marketing-announcement", "Prepare Product Announcement", "Announcement copy for the Sam Alt-Ram demo. Not started.", "Marketing Agent", "todo"),
    repo("marketing", "marketing-channels", "Research Player Acquisition Channels", "Channel research for reaching stealth-game players.", "Growth Agent", "done", "research_notes/Game operations stack/growth_outreach.md"),
    repo("product", "product-patrol", "Improve Security Guard Patrol Routes", "Waypoint routes with waits and look directions for each guard.", "Game Agent", "done", "server/src/levels.ts · server/web/sneak-core.js (guard routes)"),
    repo("product", "product-wardrobe", "Fix Wardrobe Hiding Behavior", "Player counts as unseen inside closets and hedges.", "Game Agent", "done", "server/web/sneak-core.js (hide tiles: hedge, closet)"),
    repo("product", "product-noise", "Implement Guard Reactions to Sprinting Noise", "Guards hear sprinting within HEAR_RANGE and investigate.", "Game Agent", "done", "server/web/sneak-core.js (HEAR_RANGE) · server/client/game/actors.ts (heard marker)"),
    repo("product", "product-office", "Improve Silicon Valley Office Environment", "Dress the founder-house office rooms. Not verified as finished.", "Game Agent", "todo"),
    repo("product", "product-lighting", "Fix Lighting and Interaction Triggers", "Lighting pass and interaction trigger fixes. Not verified as finished.", "Game Agent", "todo"),
    repo("product", "product-busted", "Improve Busted Screen Messages", "Per-guard busted quips on the caught overlay.", "Game Agent", "done", "server/client/game/main.ts (QUIPS) · server/client/game/hud.ts (busted overlay)"),
    repo("self-improvement", "self-efficiency", "Analyze Agent Execution Efficiency", "Review token use per job across agents. Needs metered usage first.", "Strategy Agent", "todo"),
    repo("self-improvement", "self-allocation", "Optimize AI Resource Allocation", "Rebalance AI resources between departments. Depends on the governance proposal.", "Strategy Agent", "todo"),
    repo("research-ops", "ops-architecture", "Architecture Review", "Review of company architecture, accounting and risks.", "Operations Agent", "done", "docs/ARCHITECTURE-REVIEW.md"),
    repo("research-ops", "ops-hackathon", "Document Hackathon Review and Project Tags", "Audit of what is real, mock or unverified for the demo.", "Operations Agent", "done", "docs/HACKATHON-VISUAL-PLAN.md"),
  ];
}
