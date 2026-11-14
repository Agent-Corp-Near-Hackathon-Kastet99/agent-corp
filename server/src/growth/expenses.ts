import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChainConfig, Expense, Ledger } from "../ledger.js";
import type { GrowthState } from "./state.js";

export type GrowthExpense = { actionId: string; actualUsd: string; rateUsdPerNear: string; amountYocto: string; payee: string; evidenceUrl: string; approvedBy: string; reference: string; status: "PREPARED" | "SUBMITTING" | "UNCERTAIN" | "APPROVED" | "PAID"; expenseId?: number; txHash?: string };
const micros = (v: string) => { if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/.test(v)) throw new Error("Use a positive decimal USD amount, up to 6 decimals"); const [a,b=''] = v.split('.');const n=BigInt(a!)*1_000_000n+BigInt(b.padEnd(6,'0'));if(!n)throw new Error('Amount must be positive');return n; };

/** Explicit owner-confirmed testnet reimbursements, never estimated API costs booked as paid invoices.
 * The runtime lock owns this journal. Ambiguous submission is reconciled by reference, never blindly repeated. */
export class GrowthExpenses {
  private rows: GrowthExpense[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private state: GrowthState, private ledger?: Ledger, private payee?: string, private rate = '5', private enabled = false) {
    if (existsSync(file)) {
      const rows = JSON.parse(readFileSync(file,'utf8'));
      if (!Array.isArray(rows) || rows.some(r=> !r || typeof r.actionId!=='string' || typeof r.reference!=='string' || !['PREPARED','SUBMITTING','UNCERTAIN','APPROVED','PAID'].includes(r.status) || !/^[1-9][0-9]*$/.test(r.amountYocto) || typeof r.payee!=='string')) throw new Error('Invalid growth expense journal');
      this.rows = rows;
    }
  }
  list() { return structuredClone(this.rows); }
  available() { return this.enabled && !!this.ledger && !!this.payee; }
  private save(row: GrowthExpense) {
    const next = this.rows.filter(r=>r.actionId!==row.actionId).concat(row);
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    writeFileSync(this.file+'.tmp',JSON.stringify(next,null,2)+'\n',{mode:0o600});renameSync(this.file+'.tmp',this.file);this.rows=next;
  }
  record(actionId: string, input?: { actualUsd: string; evidenceUrl: string; approvedBy: string }) {
    const run=this.pending.then(()=>this.reconcile(actionId,input));this.pending=run.catch(()=>undefined);return run;
  }
  private async reconcile(actionId:string,input?:{actualUsd:string;evidenceUrl:string;approvedBy:string}) {
    if(!this.available())throw new Error('Configure GROWTH_EXPENSE_PAYEE and GROWTH_EXPENSE_WRITES=on for testnet reimbursements');
    const chain=this.ledger!;
    const config=await chain.view<ChainConfig>('get_config');
    if(!config.demo_mode || !chain.contractId.endsWith('.testnet') || !this.payee!.endsWith('.testnet'))throw new Error('Expense bridge is testnet-only');
    let row=this.rows.find(r=>r.actionId===actionId);
    if(!row){
      const action=this.state.get(actionId);
      if(!action || action.status!=='EXECUTED' || action.summary.startsWith('[DRY]') || !/^(llm\.|exa\.|fal\.)/.test(action.kind))throw new Error('Only completed live LLM/Exa/fal actions can have receipts');
      if(!input || !input.approvedBy.trim() || input.approvedBy.length>80)throw new Error('Actual payment evidence and approver required');
      const evidence=new URL(input.evidenceUrl);if(evidence.protocol!=='https:' || evidence.username || evidence.password || input.evidenceUrl.length>1000)throw new Error('Use an HTTPS receipt URL without embedded credentials');
      if(this.rows.some(r=>r.evidenceUrl===input.evidenceUrl))throw new Error('This receipt already belongs to another action; provide an item-specific receipt');
      const cost=micros(input.actualUsd),rate=micros(this.rate), numerator=cost*10n**24n;
      if(numerator%rate!==0n)throw new Error('USD amount is not exactly representable at the configured testnet rate');
      row={actionId,actualUsd:input.actualUsd,rateUsdPerNear:this.rate,amountYocto:(numerator/rate).toString(),payee:this.payee!,evidenceUrl:input.evidenceUrl,approvedBy:input.approvedBy.trim(),reference:`growth:${actionId}:${createHash('sha256').update(input.evidenceUrl).digest('hex').slice(0,24)}`,status:'PREPARED'};
      this.save(row); // before any chain write
    } else if(input && (input.actualUsd!==row.actualUsd || input.evidenceUrl!==row.evidenceUrl || input.approvedBy.trim()!==row.approvedBy)) throw new Error('Receipt is immutable; input conflicts with existing record');
    let expense:Expense|undefined;
    for(let from=0;;from+=100){const page=await chain.view<Expense[]>('get_expenses',{from_index:from,limit:100});expense=page.find(e=>e.reference===row!.reference);if(expense||page.length<100)break;}
    if(!expense){
      if(row.status!=='PREPARED'){this.save({...row,status:'UNCERTAIN'});throw new Error('Submission uncertain: inspect chain before retry; automatic resubmission is disabled');}
      row={...row,status:'SUBMITTING'};this.save(row);
      try{await chain.call('ceo','record_expense',{category:'api',amount:row.amountYocto,payee:row.payee,reference:row.reference});}
      catch(error){this.save({...row,status:'UNCERTAIN'});throw error;}
      // Final chain state, not a local success assumption, determines the expense ID.
      for(let from=0;;from+=100){const page=await chain.view<Expense[]>('get_expenses',{from_index:from,limit:100});expense=page.find(e=>e.reference===row!.reference);if(expense||page.length<100)break;}
      if(!expense){this.save({...row,status:'UNCERTAIN'});throw new Error('Expense not visible at finality; reconcile later');}
    }
    if(expense.amount!==row.amountYocto || expense.payee!==row.payee || expense.category!=='api')throw new Error('On-chain expense conflicts with receipt');
    row={...row,expenseId:expense.id,status:expense.status==='Paid'?'PAID':'APPROVED'};this.save(row);
    if(expense.status==='Approved'){
      const tx=await chain.call('oracle','pay_expense',{expense_id:expense.id});
      expense=await chain.view<Expense>('get_expense',{expense_id:expense.id});
      row={...row,txHash:tx.txHash,status:expense.status==='Paid'?'PAID':'APPROVED'};this.save(row);
    }
    return structuredClone(row);
  }
}
