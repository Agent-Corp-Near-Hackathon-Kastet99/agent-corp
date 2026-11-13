import type { DashboardView, JobView } from "./types";
import dashboard from "../fixtures/dashboard.json";
import emptyDashboard from "../fixtures/dashboard-empty.json";
import complete from "../fixtures/job-complete.json";
import running from "../fixtures/job-running.json";
import reassigned from "../fixtures/job-reassigned.json";
import refundable from "../fixtures/job-refundable.json";
const fixtures:Record<string,JobView>={"demo-complete":complete as JobView,"demo-running":running as JobView,"demo-reassigned":reassigned as JobView,"demo-refundable":refundable as JobView};
const fixtureMode=location.search.includes("fixture") || location.hostname === "localhost";
export async function getDashboard(empty=false):Promise<DashboardView>{ if(fixtureMode) return (empty?emptyDashboard:dashboard) as DashboardView; const r=await fetch("/api/dashboard"); return r.json(); }
export async function getJob(id:string):Promise<JobView>{ if(fixtures[id]) return fixtures[id]; const r=await fetch(`/api/jobs/${id}`); return r.json(); }
export async function createJob(url:string){ if(fixtureMode) return {jobId:"demo-running"}; const r=await fetch("/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url})}); return r.json() as Promise<{jobId:string}>; }
